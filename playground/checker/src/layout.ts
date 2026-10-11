// Typed layouts (ownlayout.go): a value whose static type is a shared struct or a SharedArray is, at
// run time, an address in the shared heap. The checker classifies types by layout, decides where the
// emit boxes and unboxes such values (the conversions, which the counting rules read), and reports
// what the layouts cannot express:
//
//   - the elements of a SharedArray must be numbers or a shared struct (96016);
//   - the elements of a SharedArray of structs are stored inline, so they cannot be assigned (96017);
//   - no optional chaining on an address (96018), no destructuring of a parameter or a for-of variable
//     that holds one (96019);
//   - a field of a union of structs must be at the same place in all of them (96026).

import { CellKind, Conversion } from "./context.ts";
import type { CellType, Own, StructInfo } from "./context.ts";
import { IndexKind, ObjectFlags, SymbolFlags, TypeFlags } from "./host.ts";
import type { Type } from "./host.ts";
import { getStructOfCall, getStructRegistry } from "./markers.ts";
import { Messages } from "./messages.ts";
import {
  FunctionFlags, forEachChild, getContainingFunction, getFunctionFlags, isAssignmentTarget, isBindingPattern, isExpression,
  isFunctionExpressionOrArrowFunction, isFunctionLike, isObjectLiteralMethod, isOptionalChain, isTypeNode, K, NodeFlags, skipParentheses,
} from "./syntax.ts";
import type { Node } from "./syntax.ts";
import type { SourceFile } from "typescript/ast";

const noCell: CellType = { kind: CellKind.None, fields: [], refs: [] };

// The shared struct whose instances have type t, if any: a `struct(...)` call (whose values' type
// may be intersected with Cell).
export function getStructOfType(c: Own, t: Type | undefined): StructInfo | undefined {
  if (!t) return undefined;
  if (c.structOfType.has(t)) return c.structOfType.get(t);
  let result: StructInfo | undefined;
  if (t.flags & TypeFlags.Intersection) {
    for (const member of c.host.memberTypes(t)) {
      result = getStructOfType(c, member);
      if (result) break;
    }
  } else if (t.flags & TypeFlags.Object) {
    const call = getStructRegistry(c).get(t);
    if (call) result = getStructOfCall(c, call);
  }
  c.structOfType.set(t, result);
  return result;
}

// The element type of a SharedArray type, if t is one.
export function getSharedArrayElementType(c: Own, t: Type | undefined): Type | undefined {
  if (!t || !(t.flags & TypeFlags.Object) || !((t as any).objectFlags & ObjectFlags.Reference)) return undefined;
  if (c.sharedArrayElements.has(t)) return c.sharedArrayElements.get(t);
  let result: Type | undefined;
  const target = c.host.typeTarget(t);
  const symbol = target && c.host.typeSymbol(target);
  if (symbol && symbol.name === "SharedArray" && symbol.declarations.some((d) => d.kind === K.InterfaceDeclaration && c.isRuntimePath(d.path))) {
    result = c.host.typeArguments(t)[0];
  }
  c.sharedArrayElements.set(t, result);
  return result;
}

// The non-nullish members of a type.
export function nonNullishMembers(c: Own, t: Type): Type[] {
  if (t.flags & TypeFlags.Union) return c.host.memberTypes(t).filter((m) => !(m.flags & TypeFlags.Nullable));
  if (t.flags & TypeFlags.Nullable) return [];
  return [t];
}

function isNullishOnly(c: Own, t: Type): boolean {
  return !!(t.flags & TypeFlags.Nullable) && nonNullishMembers(c, t).length === 0;
}

// Classifies a type for the layout emit: a shared struct (or a union of them), a SharedArray of
// numbers or a SharedArray of a shared struct (looking through null and undefined).
export function getCellType(c: Own, t: Type | undefined): CellType {
  if (!t) return noCell;
  const members = nonNullishMembers(c, t);
  if (members.length > 1) {
    const s = getStructOfUnion(c, t, members);
    return s ? { kind: CellKind.Struct, fields: s.fields, refs: s.refs } : noCell;
  }
  if (members.length === 0) return noCell;
  const m = members[0]!;
  const s = getStructOfType(c, m);
  if (s) return { kind: CellKind.Struct, fields: s.fields, refs: s.refs };
  const element = getSharedArrayElementType(c, m);
  if (element) {
    if (element.flags & TypeFlags.Number) return { kind: CellKind.ArrayOfNumber, fields: [], refs: [] };
    const es = getStructOfType(c, element);
    if (es) return { kind: CellKind.ArrayOfStruct, fields: es.fields, refs: es.refs };
  }
  return noCell;
}

// Reports whether a value of type t is a shared struct or a SharedArray (possibly with null or
// undefined), which is represented by an address: isOwnCellType.
export function isCellType(c: Own, t: Type | undefined): boolean {
  if (!t) return false;
  let result = c.cellTypes.get(t);
  if (result !== undefined) return result;
  const members = nonNullishMembers(c, t);
  result = members.length > 0 && members.every((m) => getStructOfType(c, m) !== undefined || getSharedArrayElementType(c, m) !== undefined);
  c.cellTypes.set(t, result);
  return result;
}

export function isCellExpression(c: Own, expr: Node | undefined): boolean {
  return !!expr && isExpression(expr) && isCellType(c, c.host.typeOf(expr));
}

// Checks the element type of a SharedArray type reference (or of a `new` of one): numbers or a shared
// struct.
export function checkSharedArrayElementType(c: Own, node: Node, t: Type): void {
  if (node.flags & NodeFlags.Ambient) return;
  const element = getSharedArrayElementType(c, t);
  if (!element || element.flags & TypeFlags.Number && !(element.flags & TypeFlags.Union) || getStructOfType(c, element)) return;
  c.error(node, Messages.SharedArrayElement);
}

// The layout of a union of shared structs, given its non-nullish members, or undefined if they are
// not all shared structs: a field where it is at the same place, stored the same way, in every
// member, and "" in the other slots.
function getStructOfUnion(c: Own, t: Type, members: Type[]): StructInfo | undefined {
  if (c.structUnions.has(t)) return c.structUnions.get(t);
  const structs: StructInfo[] = [];
  for (const m of members) {
    const s = getStructOfType(c, m);
    if (!s) {
      c.structUnions.set(t, undefined);
      return undefined;
    }
    structs.push(s);
  }
  let n = structs[0]!.fields.length;
  for (const s of structs.slice(1)) n = Math.min(n, s.fields.length);
  const info: StructInfo = { decl: undefined, name: "", fields: structs[0]!.fields.slice(0, n), refs: structs[0]!.refs.slice(0, n) };
  for (const s of structs.slice(1)) {
    for (let k = 0; k < n; k++) {
      if (s.fields[k] !== info.fields[k] || s.refs[k] !== info.refs[k]) {
        info.fields[k] = "";
        info.refs[k] = false;
      }
    }
  }
  c.structUnions.set(t, info);
  return info;
}

// Reports an access to a field of a union of shared structs that is at different places in them.
function checkStructUnionField(c: Own, access: Node, t: Type): void {
  const members = nonNullishMembers(c, t);
  const name = access.name.text as string;
  if (members.length > 1 && members.every((m) => getStructOfType(c, m)?.fields.includes(name))) {
    c.error(access.name, Messages.UnionField, name);
  }
}

// Boxing

// Reports whether an expression holds a handle although its type is a struct or SharedArray: a
// variable or property declared with another type and narrowed to one.
export function isNarrowedReference(c: Own, expr: Node): boolean {
  let symbol;
  if (expr.kind === K.Identifier) {
    symbol = c.host.resolvedSymbol(expr);
    if (symbol) symbol = c.host.exportSymbolIfExported(symbol);
  } else if (expr.kind === K.PropertyAccessExpression) {
    symbol = c.host.symbolAt(expr.name);
  }
  if (!symbol || !(symbol.flags & (SymbolFlags.Variable | SymbolFlags.Property))) return false;
  return !isCellType(c, c.host.typeOfSymbol(symbol));
}

// Records the conversion of an expression flowing into a place whose representation is raw
// (targetRaw) or a handle. Conditional and logical expressions pass the target on to their operands.
function setTarget(c: Own, expr: Node | undefined, targetRaw: boolean): void {
  if (!expr) return;
  switch (expr.kind) {
    case K.ParenthesizedExpression:
      setTarget(c, expr.expression, targetRaw);
      return;
    case K.ConditionalExpression:
      setTarget(c, expr.whenTrue, targetRaw);
      setTarget(c, expr.whenFalse, targetRaw);
      return;
    case K.BinaryExpression:
      switch (expr.operatorToken.kind) {
        case K.AmpersandAmpersandToken: case K.BarBarToken: case K.QuestionQuestionToken:
          setTarget(c, expr.left, targetRaw);
          setTarget(c, expr.right, targetRaw);
          return;
        case K.CommaToken:
          setTarget(c, expr.right, targetRaw);
          return;
      }
  }
  if (!isExpression(expr)) return;
  const t = c.host.typeOf(expr);
  const sourceRaw = isCellType(c, t) && !isNarrowedReference(c, expr);
  if (targetRaw && !sourceRaw && nonNullishMembers(c, t).length > 0) {
    c.conversions.set(expr, Conversion.Unbox);
  } else if (targetRaw && isNullishOnly(c, t)) {
    c.conversions.set(expr, Conversion.Zero);
  } else if (!targetRaw && sourceRaw) {
    c.conversions.set(expr, Conversion.Box);
  } else {
    c.conversions.delete(expr);
  }
}

// The type a place has: undefined for none, or null for the error type (a handle).
type Target = Type | undefined | null;

function setTargetType(c: Own, expr: Node | undefined, target: Target): void {
  if (!expr || target === undefined) return;
  setTarget(c, expr, target !== null && isCellType(c, target));
}

export function getConversion(c: Own, expr: Node): Conversion {
  return c.conversions.get(expr) ?? Conversion.None;
}

// Computes the box and unbox conversions of a file, and reports the layout errors (assigning an
// inline struct element, optional chaining, destructuring a struct parameter, a field at different
// places in a union, a SharedArray of other elements).
export function computeConversions(c: Own, file: SourceFile): void {
  const visit = (node: Node): boolean => {
    if (isTypeNode(node)) {
      // Type references are checked as the checker checks them (checkTypeReferenceNode).
      checkTypeReferences(c, node);
      return false;
    }
    computeConversion(c, node);
    forEachChild(node, visit);
    return false;
  };
  forEachChild(file as Node, visit);
}

function checkTypeReferences(c: Own, node: Node): void {
  if (node.kind === K.TypeReference) checkSharedArrayElementType(c, node, c.host.checker.getTypeFromTypeNode(node as any));
  forEachChild(node, (child) => {
    checkTypeReferences(c, child);
  });
}

function computeConversion(c: Own, node: Node): void {
  const host = c.host;
  switch (node.kind) {
    case K.CallExpression: case K.NewExpression: {
      if (node.kind === K.NewExpression) checkSharedArrayElementType(c, node, host.typeOf(node));
      const args = node.arguments as Node[] | undefined;
      if (!args || args.length === 0 || node.kind === K.CallExpression && node.expression.kind === K.ImportKeyword) return;
      const signature = host.signatureOf(node);
      const unresolved = !signature.declaration && signature.parameters.length === 0 || host.checker.isUnknownSignature(signature);
      args.forEach((arg, i) => {
        if (arg.kind === K.SpreadElement) {
          setTarget(c, arg.expression, false);
          return;
        }
        if (unresolved) {
          setTarget(c, arg, false);
          return;
        }
        setTargetType(c, arg, host.parameterTypeAt(signature, i));
      });
      return;
    }
    case K.VariableDeclaration: case K.PropertyDeclaration: case K.Parameter: {
      const init = node.initializer as Node | undefined;
      if (isBindingPattern(node.name)) {
        if (init) {
          setTarget(c, init, false); // destructured through the handle
        } else if (node.kind === K.Parameter || node.kind === K.VariableDeclaration && node.parent?.parent?.kind === K.ForOfStatement) {
          // A parameter or loop variable cannot be boxed before it is destructured.
          const t = host.typeOf(node.name);
          if (isCellType(c, t)) c.error(node.name, Messages.Destructured, host.typeToString(t));
        }
        return;
      }
      if (init) {
        const symbol = host.symbolOfDeclaration(node);
        if (symbol) setTargetType(c, init, host.typeOfSymbol(symbol));
      }
      return;
    }
    case K.BinaryExpression:
      computeBinaryConversion(c, node);
      return;
    case K.ReturnStatement:
      if (node.expression) setTargetType(c, node.expression, getReturnTargetType(c, getContainingFunction(node)));
      return;
    case K.ArrowFunction:
      if (node.body && node.body.kind !== K.Block) setTargetType(c, node.body, getReturnTargetType(c, node));
      return;
    case K.ArrayLiteralExpression: {
      if (isAssignmentTarget(node)) return;
      const literalType = host.typeOf(node);
      (node.elements as Node[]).forEach((element, i) => {
        if (element.kind === K.SpreadElement) {
          setTarget(c, element.expression, false);
          return;
        }
        if (element.kind === K.OmittedExpression) return;
        let target: Target = host.checker.getContextualType(element as any);
        if (!target) {
          if (host.checker.isTupleType(literalType)) target = host.typeArguments(literalType)[i];
          else target = host.checker.getIndexTypeOfType(literalType, IndexKind.Number);
        }
        setTargetType(c, element, target);
      });
      return;
    }
    case K.PropertyAssignment:
      if (!isAssignmentTarget(node.parent)) setTargetType(c, node.initializer, host.checker.getContextualType(node.initializer));
      return;
    case K.ShorthandPropertyAssignment:
      if (!isAssignmentTarget(node.parent)) setTargetType(c, node.name, host.checker.getContextualType(node.name));
      return;
    case K.SpreadAssignment: case K.TemplateSpan: case K.TypeOfExpression:
      setTarget(c, node.expression, false);
      return;
    case K.AsExpression: case K.TypeAssertionExpression:
      setTargetType(c, node.expression, host.checker.getTypeFromTypeNode(node.type));
      return;
    case K.ForOfStatement: case K.ForInStatement:
      setTarget(c, node.expression, false);
      return;
    case K.CaseClause: {
      // `case null:` against an address compares with 0.
      const switchExpression = (node.parent!.parent as Node).expression as Node;
      if (isCellExpression(c, switchExpression) && !isNarrowedReference(c, switchExpression)) {
        if (isNullishOnly(c, host.typeOf(node.expression))) setTarget(c, node.expression, true);
      }
      return;
    }
    case K.PropertyAccessExpression: {
      const object = node.expression as Node;
      const t = host.typeOf(object);
      if (!isCellType(c, t)) return;
      if (isOptionalChain(node)) {
        c.error(node, Messages.OptionalChaining, host.typeToString(t));
        return;
      }
      const name = node.name.text as string;
      const cell = getCellType(c, t);
      switch (cell.kind) {
        case CellKind.Struct: {
          // A field is read through the layout; anything else through the handle.
          const inLayout = cell.fields.includes(name);
          if (!inLayout) checkStructUnionField(c, node, t);
          setTarget(c, object, inLayout);
          break;
        }
        case CellKind.ArrayOfNumber: case CellKind.ArrayOfStruct:
          setTarget(c, object, name === "length");
          break;
        default:
          setTarget(c, object, false);
      }
      return;
    }
    case K.ElementAccessExpression: {
      const object = node.expression as Node;
      const t = host.typeOf(object);
      if (!isCellType(c, t)) return;
      if (isOptionalChain(node)) {
        c.error(node, Messages.OptionalChaining, host.typeToString(t));
        return;
      }
      const kind = getCellType(c, t).kind;
      setTarget(c, object, kind === CellKind.ArrayOfNumber || kind === CellKind.ArrayOfStruct);
      return;
    }
  }
}

function computeBinaryConversion(c: Own, node: Node): void {
  const host = c.host;
  const op = node.operatorToken.kind;
  const left = node.left as Node;
  const right = node.right as Node;
  switch (op) {
    case K.EqualsToken:
      if (left.kind === K.ArrayLiteralExpression || left.kind === K.ObjectLiteralExpression) {
        setTarget(c, right, false); // destructured through the handle
        return;
      }
      if (left.kind === K.ElementAccessExpression && getCellType(c, host.typeOf(left.expression)).kind === CellKind.ArrayOfStruct) {
        c.error(left, Messages.InlineStructElement);
        return;
      }
      setTargetType(c, right, getAssignmentTargetType(c, left));
      return;
    case K.BarBarEqualsToken: case K.AmpersandAmpersandEqualsToken: case K.QuestionQuestionEqualsToken:
      setTargetType(c, right, getAssignmentTargetType(c, left));
      return;
    case K.PlusToken: case K.PlusEqualsToken:
      // String concatenation (arithmetic on a struct is already a type error).
      if (isCellExpression(c, left) && op === K.PlusToken) setTarget(c, left, false);
      if (isCellExpression(c, right)) setTarget(c, right, false);
      return;
    case K.EqualsEqualsEqualsToken: case K.ExclamationEqualsEqualsToken: case K.EqualsEqualsToken: case K.ExclamationEqualsToken: {
      const leftType = host.typeOf(left);
      const rightType = host.typeOf(right);
      const leftCell = isCellType(c, leftType);
      const rightCell = isCellType(c, rightType);
      if (leftCell && rightCell) {
        setTarget(c, left, true);
        setTarget(c, right, true);
      } else if (leftCell) {
        // Compare addresses with null and undefined (as 0), handles with anything else.
        const rightNullish = isNullishOnly(c, rightType);
        setTarget(c, left, rightNullish);
        if (rightNullish) setTarget(c, right, true);
      } else if (rightCell) {
        const leftNullish = isNullishOnly(c, leftType);
        setTarget(c, right, leftNullish);
        if (leftNullish) setTarget(c, left, true);
      }
      return;
    }
    case K.InKeyword:
      setTarget(c, right, false);
      return;
    case K.InstanceOfKeyword:
      setTarget(c, left, false);
      return;
  }
}

// The type a function's returned values flow into: its declared, contextual or inferred return type.
function getReturnTargetType(c: Own, fn: Node | undefined): Target {
  if (!fn || !isFunctionLike(fn)) return undefined;
  const flags = getFunctionFlags(fn);
  if (flags & FunctionFlags.Generator) return undefined;
  const host = c.host;
  const unwrap = (t: Type): Target => flags & FunctionFlags.Async ? host.checker.getAwaitedType(t) ?? null : t;
  if (fn.type) return unwrap(host.checker.getTypeFromTypeNode(fn.type));
  if (isFunctionExpressionOrArrowFunction(fn) || isObjectLiteralMethod(fn)) {
    const signature = host.contextualSignature(fn);
    if (signature) return unwrap(host.checker.getReturnTypeOfSignature(signature));
  }
  return unwrap(host.checker.getReturnTypeOfSignature(host.checker.getSignatureFromDeclaration(fn)));
}

// The declared type of an assignment target.
export function getAssignmentTargetType(c: Own, target: Node): Type {
  target = skipParentheses(target);
  const host = c.host;
  if (target.kind === K.Identifier) {
    const symbol = host.resolvedSymbol(target);
    if (symbol) return host.typeOfSymbol(host.exportSymbolIfExported(symbol));
  }
  if (target.kind === K.PropertyAccessExpression) {
    const symbol = host.symbolAt(target.name);
    if (symbol) return host.typeOfSymbol(symbol);
  }
  return host.typeOf(target);
}
