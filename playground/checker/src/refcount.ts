// Reference counting (ownrefcount.go): a shared struct or SharedArray is freed when nothing refers to
// it, and the emit adds the increments and decrements. The checker reports what counting cannot
// follow:
//
//   - a raw address stored in an ordinary array or object (96021), or bound by destructuring (96024),
//     or used as a for-of variable (96022);
//   - a captured counted variable that is reassigned (96020), and a counted local captured by a
//     method or a class (96023);
//   - a generator's counted parameter (96025), and a `struct(...)` field that is not a number or a
//     reference (96015).
//
// Only the part of the counting rules that these errors depend on is here: whether the value of an
// expression is counted at all (getCount), not how (owned, borrowed, ...), which only the emit needs.

import { Conversion } from "./context.ts";
import type { CaptureInfo, Own } from "./context.ts";
import { ObjectFlags, TypeFlags } from "./host.ts";
import type { NodeHandle, TsSymbol, Type } from "./host.ts";
import { getAssignmentTargetType, getConversion, isCellExpression, isCellType, isNarrowedReference, nonNullishMembers } from "./layout.ts";
import { checkStructCall, getCallMarker, isConsumeCall } from "./markers.ts";
import { Messages } from "./messages.ts";
import {
  FunctionFlags, forEachChild, getAssignmentTarget, getContainingFunction, getFunctionFlags, isAccessExpression, isAssignmentTarget,
  isClassLike, isFunctionLikeDeclaration, isOwnReferencePosition, isOwnValueExpression, isParameterPropertyDeclaration, isTypeNode, K,
  NodeFlags, skipParentheses,
} from "./syntax.ts";
import type { Node } from "./syntax.ts";
import type { SourceFile } from "typescript/ast";

// Whether the value of an expression is counted where it flows: not at all (a handle, a primitive),
// null, or a counted address. (printer.OwnCount, with its counted kinds merged.)
const Count = { None: 0, Null: 1, Counted: 2 } as const;
type Count = (typeof Count)[keyof typeof Count];

// The count of a value that is one of two: null only if both are (ownJoinCounts ranks every other
// count, "not counted" included, above null).
function join(a: Count, b: Count): Count {
  return a === Count.Null && b === Count.Null ? Count.Null : Count.Counted;
}

// getOwnCount: how the value of an expression is counted where it flows, after its conversion.
function getCount(c: Own, expr: Node | undefined): Count {
  if (!expr || !isOwnValueExpression(expr)) return Count.None;
  switch (getConversion(c, expr)) {
    case Conversion.Unbox: return Count.Counted; // `__unbox(E)`
    case Conversion.Box: return Count.None; // a handle, which holds its own count
    case Conversion.Zero: return Count.Null;
  }
  return getRawCount(c, expr);
}

// computeOwnRawCount
function getRawCount(c: Own, expr: Node): Count {
  if (expr.kind === K.ParenthesizedExpression) return getCount(c, expr.expression);
  const t = c.host.typeOf(expr);
  if (!isCellType(c, t)) {
    return t.flags & TypeFlags.Nullable && nonNullishMembers(c, t).length === 0 ? Count.Null : Count.None;
  }
  if (isNarrowedReference(c, expr)) return Count.None; // a handle
  switch (expr.kind) {
    case K.CallExpression:
      if (isConsumeCall(c, expr)) {
        // `consume(x)` is x.
        const inner = getCount(c, expr.arguments[0]);
        return inner !== Count.None ? inner : Count.Counted;
      }
      return Count.Counted;
    case K.AsExpression: case K.SatisfiesExpression: case K.NonNullExpression: case K.TypeAssertionExpression: {
      const inner = getCount(c, expr.expression);
      return inner !== Count.None ? inner : Count.Counted;
    }
    case K.ConditionalExpression:
      return join(getCount(c, expr.whenTrue), getCount(c, expr.whenFalse));
    case K.BinaryExpression:
      switch (expr.operatorToken.kind) {
        case K.BarBarToken: case K.QuestionQuestionToken:
          return join(getCount(c, expr.left), getCount(c, expr.right));
        case K.AmpersandAmpersandToken:
          return join(Count.Null, getCount(c, expr.right));
        case K.CommaToken:
          return getCount(c, expr.right);
        case K.EqualsToken: case K.BarBarEqualsToken: case K.QuestionQuestionEqualsToken: case K.AmpersandAmpersandEqualsToken:
          if (!isCellType(c, getAssignmentTargetType(c, expr.left))) return Count.None; // boxed for its target
      }
  }
  return Count.Counted;
}

// Reports whether a declaration is ambient: declared in a declaration file or with `declare`.
function isAmbientDeclaration(decl: Node): boolean {
  return (decl.flags & NodeFlags.Ambient) !== 0 || decl.getSourceFile().isDeclarationFile;
}

// The same for a declaration's handle (without fetching a declaration file, whose declarations all
// are).
function isAmbientHandle(c: Own, handle: NodeHandle | undefined): boolean {
  if (!handle) return false;
  if (/\.d\.([^./]+\.)?[cm]?ts$/i.test(handle.path)) return true;
  const decl = c.host.declarationOf(handle);
  return !!decl && isAmbientDeclaration(decl);
}

// The element type of a channel, if t is one: `Channel<T>` (or `ChannelCell<T>`), declared ambiently.
export function getChannelElementType(c: Own, t: Type | undefined): Type | undefined {
  if (!t || !(t.flags & TypeFlags.Object) || !((t as any).objectFlags & ObjectFlags.Reference)) return undefined;
  const target = c.host.typeTarget(t);
  const symbol = target && c.host.typeSymbol(target);
  if (!symbol || symbol.name !== "ChannelCell" && symbol.name !== "Channel") return undefined;
  if (!symbol.declarations.some((d) => (d.kind === K.InterfaceDeclaration || d.kind === K.ClassDeclaration) && isAmbientHandle(c, d))) {
    return undefined;
  }
  return c.host.typeArguments(t)[0];
}

// Reports whether a for-of statement receives counted values from a channel: its variable owns each.
export function isChannelReceiveLoop(c: Own, loop: Node): boolean {
  return loop.kind === K.ForOfStatement && isCellType(c, getChannelElementType(c, c.host.typeOf(loop.expression)));
}

// The function that declares a variable or parameter; undefined for a module's variables.
function declaringFunction(decl: Node): Node | undefined {
  if (decl.kind === K.Parameter) return decl.parent as Node;
  return getContainingFunction(decl);
}

// The variable or parameter (with an identifier name) that an identifier in an expression refers to.
function referencedVariable(c: Own, id: Node): TsSymbol | undefined {
  if (id.kind !== K.Identifier || !isOwnReferencePosition(id)) return undefined;
  let symbol = c.host.resolvedSymbol(id);
  if (!symbol) return undefined;
  symbol = c.host.exportSymbolIfExported(symbol);
  const handle = symbol.valueDeclaration;
  if (!handle || handle.kind !== K.VariableDeclaration && handle.kind !== K.Parameter) return undefined;
  if (c.host.isDefaultLibraryPath(handle.path)) return symbol; // `declare var x: T`, never counted
  const decl = c.host.declarationOf(handle);
  if (!decl?.name || decl.name.kind !== K.Identifier) return undefined;
  return symbol;
}

// The counted variables that functions other than the declaring one refer to, and the references
// from methods and classes (getOwnCaptureInfo).
function getCaptureInfo(c: Own, file: SourceFile): CaptureInfo {
  let info = c.captures.get(file);
  if (info) return info;
  const result: CaptureInfo = { captured: new Set(), members: [] };
  c.captures.set(file, result);
  const scopes: Node[] = []; // the functions and classes around the current node, innermost last
  const visit = (node: Node): boolean => {
    if (isTypeNode(node)) return false;
    if (isFunctionLikeDeclaration(node) || node.kind === K.ClassStaticBlockDeclaration || isClassLike(node)) {
      scopes.push(node);
      forEachChild(node, visit);
      scopes.pop();
      return false;
    }
    if (node.kind === K.Identifier) {
      recordCapture(c, result, node, scopes);
      return false;
    }
    return forEachChild(node, visit);
  };
  forEachChild(file as Node, visit);
  return result;
}

function recordCapture(c: Own, info: CaptureInfo, id: Node, scopes: Node[]): void {
  const symbol = referencedVariable(c, id);
  if (!symbol || !isCellType(c, c.host.typeOfSymbol(symbol))) return;
  const declaring = declaringFunction(c.host.valueDeclaration(symbol)!);
  let member = false;
  for (let i = scopes.length - 1; i >= 0 && scopes[i] !== declaring; i--) {
    const scope = scopes[i]!;
    info.captured.add(symbol);
    if (!declaring) continue; // a module's variable lives as long as the module
    switch (scope.kind) {
      case K.ArrowFunction: case K.FunctionExpression: case K.FunctionDeclaration:
        break;
      default:
        member = true;
    }
  }
  if (member) info.members.push(id);
}

// A counted element type of an array or tuple type, if any.
function getCountedElementType(c: Own, t: Type): Type | undefined {
  const checker = c.host.checker;
  if (checker.isTupleType(t)) {
    return c.host.typeArguments(t).find((element) => isCellType(c, element));
  }
  if (checker.isArrayType(t)) {
    const element = c.host.typeArguments(t)[0];
    if (isCellType(c, element)) return element;
  }
  return undefined;
}

function targetName(target: Node): string {
  if (target.kind === K.PropertyAccessExpression) return target.name.text;
  if (target.kind === K.Identifier) return target.text;
  return "element";
}

// Reports the reference counting errors of a file (checkOwnRefCounts).
export function checkRefCounts(c: Own, file: SourceFile): void {
  const host = c.host;
  const info = getCaptureInfo(c, file);
  for (const id of info.members) c.error(id, Messages.CapturedByMember, id.text);
  const stored = (expr: Node | undefined): void => {
    if (!expr) return;
    const count = getCount(c, expr);
    if (count === Count.None || count === Count.Null) return;
    c.error(expr, Messages.StoredInOrdinary, host.typeToString(host.typeOf(expr)));
  };
  const destructured = (name: Node, t: Type): void => {
    if (isCellType(c, t)) c.error(name, Messages.BoundByDestructuring, name.text);
  };
  const checkPattern = (pattern: Node): void => {
    // An assignment pattern: its targets must not be counted.
    const elements = (pattern.kind === K.ObjectLiteralExpression ? pattern.properties : pattern.elements) as Node[];
    for (const element of elements) {
      let target: Node = element;
      switch (element.kind) {
        case K.SpreadElement: case K.SpreadAssignment:
          target = element.expression;
          break;
        case K.PropertyAssignment:
          target = element.initializer;
          break;
        case K.ShorthandPropertyAssignment:
          target = element.name;
          break;
        case K.OmittedExpression:
          continue;
      }
      if (target.kind === K.BinaryExpression && target.operatorToken.kind === K.EqualsToken) target = target.left;
      target = skipParentheses(target);
      if (target.kind === K.ArrayLiteralExpression || target.kind === K.ObjectLiteralExpression) {
        checkPattern(target);
        continue;
      }
      if ((target.kind === K.Identifier || isAccessExpression(target)) && isCellType(c, getAssignmentTargetType(c, target))) {
        c.error(target, Messages.BoundByDestructuring, targetName(target));
      }
    }
  };
  const visit = (node: Node): boolean => {
    if (isTypeNode(node)) return false;
    switch (node.kind) {
      case K.Identifier:
        if (getAssignmentTarget(node)) {
          const symbol = referencedVariable(c, node);
          if (symbol && info.captured.has(symbol) && isCellType(c, host.typeOfSymbol(symbol))) {
            c.error(node, Messages.CapturedReassigned, node.text);
          }
        }
        return false;
      case K.ArrayLiteralExpression:
        if (isAssignmentTarget(node)) {
          checkPattern(node);
        } else {
          for (const element of node.elements as Node[]) {
            if (element.kind !== K.SpreadElement && element.kind !== K.OmittedExpression) stored(element);
          }
        }
        break;
      case K.ObjectLiteralExpression:
        if (isAssignmentTarget(node)) {
          checkPattern(node);
        } else {
          for (const property of node.properties as Node[]) {
            if (property.kind === K.PropertyAssignment) {
              stored(property.initializer);
            } else if (property.kind === K.ShorthandPropertyAssignment) {
              const t = host.typeOf(property.name);
              if (isCellType(c, t) && getConversion(c, property.name) !== Conversion.Box) {
                c.error(property.name, Messages.StoredInOrdinary, host.typeToString(t));
              }
            }
          }
        }
        break;
      case K.BinaryExpression:
        switch (node.operatorToken.kind) {
          case K.EqualsToken: case K.BarBarEqualsToken: case K.QuestionQuestionEqualsToken: case K.AmpersandAmpersandEqualsToken: {
            const left = skipParentheses(node.left);
            if (isAccessExpression(left) && !isCellExpression(c, left.expression)) stored(node.right);
          }
        }
        break;
      case K.PropertyDeclaration:
        stored(node.initializer);
        break;
      case K.Parameter: {
        const fn = node.parent as Node | undefined;
        if (node.name.kind === K.Identifier && fn && isFunctionLikeDeclaration(fn) && fn.body) {
          const symbol = host.symbolOfDeclaration(node);
          const t = symbol ? host.typeOfSymbol(symbol) : undefined;
          if (!t) break;
          if (node.dotDotDotToken && host.checker.isArrayType(t)) {
            // The arguments are stored in an ordinary array.
            const element = host.typeArguments(t)[0];
            if (isCellType(c, element)) c.error(node.name, Messages.StoredInOrdinary, host.typeToString(element!));
          } else if (!isCellType(c, t)) {
            // not counted
          } else if (isParameterPropertyDeclaration(node, fn)) {
            c.error(node.name, Messages.StoredInOrdinary, host.typeToString(t));
          } else if (getFunctionFlags(fn) & FunctionFlags.Generator) {
            // A generator's body (and so the retain of an owned parameter) runs at its first `next()`.
            c.error(node.name, Messages.GeneratorParameter, host.typeToString(t));
          }
        }
        break;
      }
      case K.BindingElement:
        if (node.name?.kind === K.Identifier) {
          const symbol = host.symbolOfDeclaration(node);
          if (symbol) destructured(node.name, host.typeOfSymbol(symbol));
        }
        break;
      case K.ForOfStatement: case K.ForInStatement: {
        let init = node.initializer as Node;
        let t: Type | undefined;
        if (init.kind === K.VariableDeclarationList) {
          const decls = init.declarations as Node[];
          if (decls.length === 1 && decls[0]!.name.kind === K.Identifier) {
            const symbol = host.symbolOfDeclaration(decls[0]!);
            if (symbol) t = host.typeOfSymbol(symbol);
            init = decls[0]!.name;
          }
        } else if (skipParentheses(init).kind === K.Identifier || isAccessExpression(skipParentheses(init))) {
          t = getAssignmentTargetType(c, init);
        }
        if (t && isCellType(c, t) && !isChannelReceiveLoop(c, node)) {
          c.error(init, Messages.LoopVariable, host.typeToString(t));
        }
        break;
      }
      case K.CallExpression: {
        if (getCallMarker(c, node) === "struct") checkStructCall(c, node);
        // A runtime function that returns addresses in an ordinary array or tuple (`select` on
        // channels of counted values): nothing could count them.
        if (isAmbientHandle(c, host.signatureOf(node).declaration)) {
          const element = getCountedElementType(c, host.typeOf(node));
          if (element) c.error(node, Messages.StoredInOrdinary, host.typeToString(element));
        }
        break;
      }
    }
    return forEachChild(node, visit);
  };
  forEachChild(file as Node, visit);
}
