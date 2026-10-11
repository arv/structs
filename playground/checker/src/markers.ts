// The plain TypeScript API of threads (ownmarkers.go): the module the runtime specifier names
// (threads.d.mts) exports markers that stock TypeScript accepts, and the checker gives them their
// meaning:
//
//	Sending<T>                  a value whose ownership moves (a parameter, a rest parameter, a result)
//	Shared<T>                   a shared value (deeply readonly)
//	consume(x)                  ends x's lifetime
//	a type assignable to Cell   a cell: shared and region-less
//	const S = struct({ a: f64, next: ref<T>() }), const S = struct<I>({ ... })
//	                            a shared struct: its fields in the order of the object literal, `f64` a
//	                            number field and `ref<T>()` a reference field.
//
// A marker is recognized by its declaration: an export of the runtime module, by name.

import type { Own, StructInfo } from "./context.ts";
import { ObjectFlags, SymbolFlags, TypeFlags } from "./host.ts";
import type { TsSymbol, Type } from "./host.ts";
import { isCellType, nonNullishMembers } from "./layout.ts";
import { Messages } from "./messages.ts";
import { forEachChild, isPropertyNameLiteral, K, skipParentheses, walkUpParenthesizedExpressions } from "./syntax.ts";
import type { Node } from "./syntax.ts";

// The name of the runtime export a symbol is (or is an alias of), or "" if it is none.
export function getRuntimeExportName(c: Own, symbol: TsSymbol | undefined): string {
  if (!symbol) return "";
  let name = c.runtimeExportNames.get(symbol);
  if (name !== undefined) return name;
  let target: TsSymbol | undefined = symbol;
  if (symbol.flags & SymbolFlags.Alias) target = c.host.resolveAlias(symbol);
  name = target && target.declarations.some((d) => c.isRuntimePath(d.path)) ? target.name : "";
  c.runtimeExportNames.set(symbol, name);
  return name;
}

// The marker a type node refers to: "Sending" or "Shared" for `Sending<T>` and `Shared<T>`, or "".
export function getTypeMarker(c: Own, t: Node | undefined): string {
  if (!t || t.kind !== K.TypeReference || t.typeArguments?.length !== 1) return "";
  const name = getRuntimeExportName(c, c.host.symbolAt(t.typeName));
  return name === "Sending" || name === "Shared" ? name : "";
}

// The marker function a call calls: "consume", "struct", "ref", or "".
export function getCallMarker(c: Own, call: Node | undefined): string {
  if (!call || call.kind !== K.CallExpression) return "";
  const callee = skipParentheses(call.expression);
  let name: string;
  if (callee.kind === K.PropertyAccessExpression) name = callee.name.text;
  else if (callee.kind === K.Identifier) name = callee.text;
  else return "";
  if (name !== "consume" && name !== "struct" && name !== "ref") return "";
  const handle = c.host.signatureOf(call).declaration;
  if (!handle || handle.kind !== K.FunctionDeclaration || !c.isRuntimePath(handle.path)) return "";
  const declared = c.host.declarationOf(handle)?.name?.text;
  return declared === "consume" || declared === "struct" || declared === "ref" ? declared : "";
}

// Reports whether an expression is `consume(x)`.
export function isConsumeCall(c: Own, expr: Node): boolean {
  return expr.kind === K.CallExpression && expr.arguments.length === 1 && getCallMarker(c, expr) === "consume";
}

// The runtime's interface or class of a given name, if it exports one.
export function getRuntimeType(c: Own, name: string): Type | undefined {
  if (c.runtimeTypes.has(name)) return c.runtimeTypes.get(name);
  let result: Type | undefined;
  for (const file of c.runtimeFiles) {
    const fileSymbol = c.host.checker.getSymbolOfSourceFile(file.fileName);
    const symbol = fileSymbol?.getExports().get(name as any);
    if (symbol && symbol.flags & (SymbolFlags.Interface | SymbolFlags.Class)) {
      result = c.host.declaredTypeOfSymbol(symbol);
      break;
    }
  }
  c.runtimeTypes.set(name, result);
  return result;
}

// Reports whether a type is a cell of the plain API: assignable to the runtime's `Cell` (Barrier,
// Slots, Channel, Thread, Scope, SharedArray, a struct's values), or a struct type or a field marker
// (immutable). Its values are shared, with no region.
export function isCellBranded(c: Own, t: Type | undefined): boolean {
  if (!t || t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Never | TypeFlags.Primitive)) return false;
  let result = c.cellBranded.get(t);
  if (result !== undefined) return result;
  result = false;
  if (t.flags & TypeFlags.Object) {
    const target = c.host.typeTarget(t);
    const symbol = target && c.host.typeSymbol(target);
    if (symbol && (symbol.name === "StructType" || symbol.name === "Field") && getRuntimeExportName(c, symbol) !== "") {
      result = true;
    }
  }
  if (!result) {
    const cell = getRuntimeType(c, "Cell");
    result = !!cell && !!(t.flags & (TypeFlags.Object | TypeFlags.Intersection)) && c.host.checker.isTypeAssignableTo(t, cell);
  }
  c.cellBranded.set(t, result);
  return result;
}

// The `struct(...)` calls of the program's source files, by the type of their structs' values
// (StructType<T>'s T).
export function getStructRegistry(c: Own): Map<Type, Node> {
  if (c.structs) return c.structs;
  const structs = new Map<Type, Node>();
  c.structs = structs;
  for (const file of c.files) {
    const visit = (node: Node): boolean => {
      if (node.kind === K.CallExpression && getCallMarker(c, node) === "struct") {
        const t = getStructTypeOfCall(c, node);
        if (t) structs.set(t, node);
      }
      return forEachChild(node, visit);
    };
    forEachChild(file as Node, visit);
  }
  return structs;
}

// The type of the values of the struct a `struct(...)` call declares: T in StructType<T>.
export function getStructTypeOfCall(c: Own, call: Node): Type | undefined {
  const t = c.host.typeOf(call);
  if (!t || !(t.flags & TypeFlags.Object) || !((t as any).objectFlags & ObjectFlags.Reference)) return undefined;
  return c.host.typeArguments(t)[0];
}

// The layout of the struct a `struct(...)` call declares: its fields in the order of the object
// literal, numbers (`f64`) and references (`ref<T>()`) by their type.
export function getStructOfCall(c: Own, call: Node): StructInfo | undefined {
  if (c.structCalls.has(call)) return c.structCalls.get(call);
  let info: StructInfo | undefined;
  const t = getStructTypeOfCall(c, call);
  if (t && call.arguments.length >= 1 && skipParentheses(call.arguments[0]).kind === K.ObjectLiteralExpression) {
    info = { decl: call, name: "Struct", fields: [], refs: [] };
    c.structCalls.set(call, info); // before its fields: a field may refer to the struct itself
    const parent = walkUpParenthesizedExpressions(call.parent as Node);
    if (parent && parent.kind === K.VariableDeclaration && parent.name.kind === K.Identifier) info.name = parent.name.text;
    for (const property of skipParentheses(call.arguments[0]).properties as Node[]) {
      const name = property.name as Node | undefined;
      if (!name || !(property.kind === K.PropertyAssignment || property.kind === K.ShorthandPropertyAssignment) || !isPropertyNameLiteral(name)) {
        continue; // reported by checkStructCall
      }
      const field = name.text as string;
      let isRef = false;
      const symbol = c.host.checker.getPropertyOfType(t, field);
      if (symbol) isRef = isCellType(c, c.host.typeOfSymbol(symbol));
      info.fields.push(field);
      info.refs.push(isRef);
    }
  }
  c.structCalls.set(call, info);
  return info;
}

// Checks a `struct(...)` call: its fields are given in an object literal, by name, and each is a
// number or a reference (a shared struct or a SharedArray, possibly null).
export function checkStructCall(c: Own, call: Node): void {
  const t = getStructTypeOfCall(c, call);
  if (!t || call.arguments.length < 1) return;
  const literal = skipParentheses(call.arguments[0]);
  if (literal.kind !== K.ObjectLiteralExpression) {
    c.error(call.arguments[0], Messages.StructField);
    return;
  }
  for (const property of literal.properties as Node[]) {
    const name = property.name as Node | undefined;
    if (!name || !(property.kind === K.PropertyAssignment || property.kind === K.ShorthandPropertyAssignment) || !isPropertyNameLiteral(name) || name.kind === K.NumericLiteral) {
      c.error(property, Messages.StructField);
      continue;
    }
    const symbol = c.host.checker.getPropertyOfType(t, name.text);
    if (!symbol) continue;
    const ft = c.host.typeOfSymbol(symbol);
    if (ft.flags & TypeFlags.Number && !(ft.flags & TypeFlags.Union) || nonNullishMembers(c, ft).length === 1 && isCellType(c, ft)) continue;
    c.error(property, Messages.StructField);
  }
}

