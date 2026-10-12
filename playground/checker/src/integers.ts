// Integers (ownintegers.go): the runtime's `i32` and `u8` hold integers. A value stored into one is
// converted as an Int32Array or a Uint8Array converts it, which wraps an integer out of range (as
// integer arithmetic does) but truncates a number that is not an integer with no sign at all, and the
// types cannot tell the two apart. So a value that flows into an i32 or a u8 (a field or an element,
// a variable, a parameter, a return value, a cast) must be an integer expression (96029):
//
//   - a value of an integer type: an i32 or a u8, or an integer literal type (`const k = 3`);
//   - `x | y`, `x & y`, `x ^ y`, `~x`, and the shifts: integers, whatever their operands;
//   - `x + y`, `x - y`, `x * y`, `x % y`, `-x`, `+x`, `x++`, and `c ? x : y`, of integers;
//   - Math.round, Math.floor, Math.ceil, Math.trunc, Math.sign, Math.clz32 and Math.imul of anything,
//     and Math.abs, Math.min and Math.max of integers;
//   - `.length`, and the results of charCodeAt, indexOf, lastIndexOf, findIndex and findLastIndex;
//   - a local variable whose every value is an integer expression: its initializer, and whatever is
//     assigned to it (not by destructuring, or as a for-in or for-of variable).

import type { FieldKind, Own } from "./context.ts";
import { SymbolFlags, TypeFlags } from "./host.ts";
import type { TsSymbol, Type } from "./host.ts";
import { getIntegerKind, nonNullishMembers } from "./layout.ts";
import { Messages } from "./messages.ts";
import { forEachChild, getAssignmentTarget, isAssignmentOperator, K, skipParentheses } from "./syntax.ts";
import type { Node } from "./syntax.ts";
import type { SourceFile } from "typescript/ast";

// The kind of integer, "i" or "u", a value that flows into a place of type t becomes (looking through
// null and undefined), or "".
export function getIntegerTargetKind(c: Own, t: Type | undefined): FieldKind {
  if (!t) return "";
  const members = nonNullishMembers(c, t);
  return members.length === 1 ? getIntegerKind(c, members[0]!) : "";
}

function maybeTypeOfKind(c: Own, t: Type, kind: number): boolean {
  if (t.flags & kind) return true;
  return !!(t.flags & TypeFlags.UnionOrIntersection) && c.host.memberTypes(t).some((m) => maybeTypeOfKind(c, m, kind));
}

// Reports a value that flows into a place of type target, an i32 or a u8, but may not be an integer.
export function checkIntegerTarget(c: Own, expr: Node, target: Type): void {
  const kind = getIntegerTargetKind(c, target);
  if (kind === "" || !maybeTypeOfKind(c, c.host.typeOf(expr), TypeFlags.NumberLike | TypeFlags.Any) || isIntegerExpression(c, expr)) return;
  c.error(expr, Messages.NotAnInteger, kind === "u" ? "a u8" : "an i32");
}

// Reports a compound assignment to an i32 or a u8 (`x /= 2`) whose result may not be an integer.
export function checkIntegerCompoundAssignment(c: Own, node: Node, target: Type): void {
  const kind = getIntegerTargetKind(c, target);
  if (kind !== "" && !isIntegerExpression(c, node)) c.error(node, Messages.NotAnInteger, kind === "u" ? "a u8" : "an i32");
}

// Reports whether a type's values are integers: an i32 or a u8, an integer literal type, or a union
// of them.
function isIntegerType(c: Own, t: Type): boolean {
  if (getIntegerKind(c, t) !== "") return true;
  if (t.flags & TypeFlags.NumberLiteral) {
    const value = (t as any).value;
    return typeof value === "number" && Number.isInteger(value);
  }
  return !!(t.flags & TypeFlags.Union) && c.host.memberTypes(t).every((m) => isIntegerType(c, m));
}

// Reports whether an expression's value is an integer. A cast is one by its type: a cast to an
// integer type is reported by itself, where it flows into one.
export function isIntegerExpression(c: Own, expr: Node): boolean {
  expr = skipParentheses(expr);
  if (isIntegerType(c, c.host.typeOf(expr))) return true;
  switch (expr.kind) {
    case K.NonNullExpression: case K.SatisfiesExpression:
      return isIntegerExpression(c, expr.expression);
    case K.PrefixUnaryExpression:
      switch (expr.operator) {
        case K.TildeToken: return true;
        case K.MinusToken: case K.PlusToken: case K.PlusPlusToken: case K.MinusMinusToken: return isIntegerExpression(c, expr.operand);
      }
      return false;
    case K.PostfixUnaryExpression:
      return isIntegerExpression(c, expr.operand);
    case K.BinaryExpression:
      switch (expr.operatorToken.kind) {
        case K.BarToken: case K.AmpersandToken: case K.CaretToken: case K.LessThanLessThanToken: case K.GreaterThanGreaterThanToken:
        case K.GreaterThanGreaterThanGreaterThanToken: case K.BarEqualsToken: case K.AmpersandEqualsToken: case K.CaretEqualsToken:
        case K.LessThanLessThanEqualsToken: case K.GreaterThanGreaterThanEqualsToken: case K.GreaterThanGreaterThanGreaterThanEqualsToken:
          return true;
        case K.PlusToken: case K.PlusEqualsToken:
          return !!(c.host.typeOf(expr).flags & TypeFlags.NumberLike) && isIntegerExpression(c, expr.left) && isIntegerExpression(c, expr.right);
        case K.MinusToken: case K.AsteriskToken: case K.PercentToken: case K.MinusEqualsToken: case K.AsteriskEqualsToken:
        case K.PercentEqualsToken: case K.AmpersandAmpersandToken: case K.BarBarToken: case K.QuestionQuestionToken:
          return isIntegerExpression(c, expr.left) && isIntegerExpression(c, expr.right);
        case K.CommaToken: case K.EqualsToken:
          return isIntegerExpression(c, expr.right);
      }
      return false;
    case K.ConditionalExpression:
      return isIntegerExpression(c, expr.whenTrue) && isIntegerExpression(c, expr.whenFalse);
    case K.CallExpression:
      return isIntegerCall(c, expr);
    case K.PropertyAccessExpression:
      return expr.name.text === "length" && !!(c.host.typeOf(expr).flags & TypeFlags.Number);
    case K.Identifier:
      return isIntegerVariable(c, expr);
  }
  return false;
}

const integerMath = new Set(["round", "floor", "ceil", "trunc", "sign", "clz32", "imul"]);
const integerMathOfInts = new Set(["abs", "min", "max"]);
const integerMethods = new Set(["charCodeAt", "indexOf", "lastIndexOf", "findIndex", "findLastIndex"]);

// Reports whether a call's result is an integer: one of Math's that are (of anything, or of integers),
// or a method that returns an index or a char code.
function isIntegerCall(c: Own, call: Node): boolean {
  const callee = skipParentheses(call.expression);
  if (callee.kind !== K.PropertyAccessExpression) return false;
  const name = callee.name.text as string;
  const object = skipParentheses(callee.expression);
  if (object.kind === K.Identifier && object.text === "Math" && isGlobalMath(c, object)) {
    if (integerMath.has(name)) return true;
    return integerMathOfInts.has(name) && call.arguments.length > 0 && (call.arguments as Node[]).every((a) => isIntegerExpression(c, a));
  }
  return integerMethods.has(name) && !!(c.host.typeOf(call).flags & TypeFlags.Number);
}

// Reports whether an identifier `Math` is the global one, declared in a default library.
function isGlobalMath(c: Own, id: Node): boolean {
  const symbol = c.host.resolvedSymbol(id);
  return !!symbol && symbol.declarations.some((d) => c.host.isDefaultLibraryPath(d.path));
}

// Reports whether an identifier is a local variable (declared in a source file, not a parameter)
// whose every value is an integer expression.
function isIntegerVariable(c: Own, id: Node): boolean {
  const symbol = c.host.resolvedSymbol(id);
  if (!symbol || !(symbol.flags & SymbolFlags.Variable)) return false;
  const decl = c.host.valueDeclaration(symbol);
  if (!decl || decl.kind !== K.VariableDeclaration || decl.name.kind !== K.Identifier) return false;
  const file = decl.getSourceFile() as SourceFile;
  if (file.isDeclarationFile) return false;
  computeIntegerVariables(c, file);
  return c.integerVariables.get(variableKey(c, symbol)) ?? false;
}

// Symbols by a stable number: the API may hand out one symbol as several objects.
const variableKey = (c: Own, symbol: TsSymbol): number => c.host.symbolId(symbol);

// Decides which local variables of a file are integers: every one starts as an integer, and one with
// a value that is not (given what the others are) stops being one, until none changes.
function computeIntegerVariables(c: Own, file: SourceFile): void {
  if (c.integerFiles.has(file)) return; // computed, or being computed: its variables' current values stand
  c.integerFiles.set(file, false);
  const values = new Map<number, Node[]>(); // what is assigned to each variable (a compound assignment as a whole)
  const variables: number[] = [];
  const notIntegers = new Set<number>();
  const add = (key: number, value: Node) => {
    const list = values.get(key);
    if (list) list.push(value);
    else values.set(key, [ value ]);
  };
  const visit = (node: Node): boolean => {
    if (node.kind === K.VariableDeclaration && node.name.kind === K.Identifier) {
      const symbol = c.host.symbolOfDeclaration(node);
      if (symbol) {
        const key = variableKey(c, symbol);
        variables.push(key);
        const statement = node.parent?.parent as Node | undefined;
        if (statement && (statement.kind === K.ForInStatement || statement.kind === K.ForOfStatement)) notIntegers.add(key);
        else if (node.initializer) add(key, node.initializer);
      }
    } else if (node.kind === K.BinaryExpression && isAssignmentOperator(node.operatorToken.kind) && skipParentheses(node.left).kind === K.Identifier) {
      const symbol = c.host.resolvedSymbol(skipParentheses(node.left));
      if (symbol) add(variableKey(c, symbol), node.operatorToken.kind === K.EqualsToken ? node.right : node);
    } else if (node.kind === K.Identifier) {
      // Assigned by destructuring, or as a for-in or for-of variable (an assignment's own left side
      // and the operand of ++ or -- are handled above, or keep an integer one).
      const target = getAssignmentTarget(node);
      if (target && !(target.kind === K.BinaryExpression && skipParentheses(target.left) === node) &&
        target.kind !== K.PrefixUnaryExpression && target.kind !== K.PostfixUnaryExpression) {
        const symbol = c.host.resolvedSymbol(node);
        if (symbol) notIntegers.add(variableKey(c, symbol));
      }
    }
    forEachChild(node, visit);
    return false;
  };
  forEachChild(file as unknown as Node, visit);
  for (const key of variables) c.integerVariables.set(key, !notIntegers.has(key));
  for (let changed = true; changed;) {
    changed = false;
    for (const key of variables) {
      if (c.integerVariables.get(key) && !(values.get(key) ?? []).every((v) => isIntegerExpression(c, v))) {
        c.integerVariables.set(key, false);
        changed = true;
      }
    }
  }
  c.integerFiles.set(file, true);
}
