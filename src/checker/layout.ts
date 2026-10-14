// Typed layouts (ownlayout.go): a value whose static type is a shared struct or
// a SharedArray is, at run time, an address in the shared heap. The checker
// classifies types by layout, decides where the emit boxes and unboxes such
// values (the conversions, which the counting rules read), and reports what the
// layouts cannot express:
//
//   - the elements of a SharedArray must be numbers, booleans, strings or a
//     shared struct (96016);
//   - the elements of a SharedArray of structs are stored inline, so they
//     cannot be assigned (96017);
//   - no optional chaining on an address (96018), no destructuring of a
//     parameter or a for-of variable that holds one (96019);
//   - a field of a union of structs must be at the same place in all of them
//     (96026);
//   - a string or channel field, or a string element, is not assigned by
//     destructuring or as a loop variable (96027);
//   - an atomic operation acts on an i32 field named by a string literal, or on
//     an element of a SharedArray<i32> (96028, reported with the struct calls,
//     in refcount.ts).

import type {SourceFile} from 'typescript/ast';
import {CellKind, Conversion, isArrayKind} from './context.ts';
import type {CellType, FieldKind, Own, StructInfo} from './context.ts';
import {IndexKind, ObjectFlags, SymbolFlags, TypeFlags} from './host.ts';
import type {Signature, Type} from './host.ts';
import {
  checkIntegerCompoundAssignment,
  checkIntegerTarget,
} from './integers.ts';
import {
  getRuntimeExportName,
  getStructOfCall,
  getStructRegistry,
} from './markers.ts';
import {Messages} from './messages.ts';
import {
  FunctionFlags,
  forEachChild,
  getAssignmentTarget,
  getContainingFunction,
  getFunctionFlags,
  isAssignmentTarget,
  isBindingPattern,
  isExpression,
  isFunctionExpressionOrArrowFunction,
  isFunctionLike,
  isObjectLiteralMethod,
  isOptionalChain,
  isTypeNode,
  K,
  NodeFlags,
  skipParentheses,
} from './syntax.ts';
import type {Node} from './syntax.ts';

const noCell: CellType = {kind: CellKind.None, fields: [], kinds: []};
const arrayOf = (kind: CellKind): CellType => ({kind, fields: [], kinds: []});
const structCell = (kind: CellKind, s: StructInfo): CellType => ({
  kind,
  fields: s.fields,
  kinds: s.kinds,
});

// The shared struct whose instances have type t, if any: a `struct(...)` call
// (whose values' type may be intersected with Cell).
function getStructOfType(c: Own, t: Type | undefined): StructInfo | undefined {
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
export function getSharedArrayElementType(
  c: Own,
  t: Type | undefined,
): Type | undefined {
  if (
    !t ||
    !(t.flags & TypeFlags.Object) ||
    !((t as any).objectFlags & ObjectFlags.Reference)
  )
    return undefined;
  if (c.sharedArrayElements.has(t)) return c.sharedArrayElements.get(t);
  let result: Type | undefined;
  const target = c.host.typeTarget(t);
  const symbol = target && c.host.typeSymbol(target);
  if (
    symbol &&
    symbol.name === 'SharedArray' &&
    symbol.declarations.some(
      d => d.kind === K.InterfaceDeclaration && c.isRuntimePath(d.path),
    )
  ) {
    result = c.host.typeArguments(t)[0];
  }
  c.sharedArrayElements.set(t, result);
  return result;
}

// The non-nullish members of a type.
export function nonNullishMembers(c: Own, t: Type): Type[] {
  if (t.flags & TypeFlags.Union)
    return c.host.memberTypes(t).filter(m => !(m.flags & TypeFlags.Nullable));
  if (t.flags & TypeFlags.Nullable) return [];
  return [t];
}

function isNullishOnly(c: Own, t: Type): boolean {
  return (
    !!(t.flags & TypeFlags.Nullable) && nonNullishMembers(c, t).length === 0
  );
}

// Reports whether a field or element of type t is a boolean: `boolean` , `true`
// or `false` (not a union with anything else).
function isBooleanType(t: Type): boolean {
  return !!(t.flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral));
}

// Reports whether a field or element of type t is a string: `string` , a string
// literal type, or a union of them (`"a" | "b"`), but not with null or
// undefined.
function isStringType(c: Own, t: Type): boolean {
  if (t.flags & TypeFlags.Union)
    return c.host.memberTypes(t).every(m => !!(m.flags & TypeFlags.StringLike));
  return !!(t.flags & TypeFlags.StringLike);
}

// The runtime's integer type t is: "i" for `i32` , "u" for `u8` , or "". Each
// is a number with a phantom brand,
// `number & { readonly [int32Brand]?: never }` , recognized by the brand's
// declaration in the runtime module (getOwnIntegerKind).
export function getIntegerKind(c: Own, t: Type): FieldKind {
  if (!(t.flags & TypeFlags.Intersection)) return '';
  let kind = c.integerKinds.get(t);
  if (kind !== undefined) return kind;
  kind = '';
  search: for (const member of c.host.memberTypes(t)) {
    if (!(member.flags & TypeFlags.Object)) continue;
    for (const property of c.host.checker.getPropertiesOfType(member as any)) {
      const handle = property.valueDeclaration;
      if (!handle || !c.isRuntimePath(handle.path)) continue;
      const name = c.host.declarationOf(handle)?.name as Node | undefined;
      if (
        name?.kind !== K.ComputedPropertyName ||
        name.expression.kind !== K.Identifier
      )
        continue;
      if (name.expression.text === 'int32Brand') {
        kind = 'i';
        break search;
      }
      if (name.expression.text === 'uint8Brand') {
        kind = 'u';
        break search;
      }
    }
  }
  c.integerKinds.set(t, kind);
  return kind;
}

// The runtime's cells that last as long as the program: a field holds one by
// address, uncounted (ownLastingCells).
const lastingCells = new Set(['Channel', 'Condition', 'Lock']);

// Reports whether a field of type t holds a lasting cell: the runtime's
// Channel, Lock or Condition, possibly with null or undefined
// (isOwnLastingCellFieldType).
function isLastingCellFieldType(c: Own, t: Type): boolean {
  const members = nonNullishMembers(c, t);
  if (members.length !== 1 || !(members[0]!.flags & TypeFlags.Object))
    return false;
  const target = c.host.typeTarget(members[0]!);
  const symbol = target && c.host.typeSymbol(target);
  return (
    !!symbol &&
    lastingCells.has(symbol.name) &&
    getRuntimeExportName(c, symbol) === symbol.name
  );
}

// The kind of a field of type t: an f64 for a number (and for a type no field
// may have, which is reported), an i32 or a u8, a boolean, a string, a
// reference, or a lasting cell: a Channel, a Lock or a Condition
// (getOwnFieldKind).
export function getFieldKind(c: Own, t: Type): FieldKind {
  const integer = getIntegerKind(c, t);
  if (integer !== '') return integer;
  if (isLastingCellFieldType(c, t)) return 'c';
  if (isBooleanType(t)) return 'b';
  if (isStringType(c, t)) return 's';
  if (isCellType(c, t)) return 'r';
  return 'f';
}

// Reports whether a shared struct may have a field of type t: a number (or an
// i32 or a u8), a boolean, a string, or a reference (a shared struct, a
// SharedArray, a Channel, a Lock or a Condition, possibly with null or
// undefined).
export function isFieldType(c: Own, t: Type): boolean {
  return (
    (!!(t.flags & TypeFlags.Number) && !(t.flags & TypeFlags.Union)) ||
    getIntegerKind(c, t) !== '' ||
    isBooleanType(t) ||
    isStringType(c, t) ||
    (nonNullishMembers(c, t).length === 1 && isCellType(c, t)) ||
    isLastingCellFieldType(c, t)
  );
}

// Classifies a type for the layout emit: a shared struct (or a union of them),
// a SharedArray of numbers, i32s, u8s, booleans or strings, or a SharedArray of
// a shared struct (looking through null and undefined).
export function getCellType(c: Own, t: Type | undefined): CellType {
  if (!t) return noCell;
  const members = nonNullishMembers(c, t);
  if (members.length > 1) {
    const s = getStructOfUnion(c, t, members);
    return s ? structCell(CellKind.Struct, s) : noCell;
  }
  if (members.length === 0) return noCell;
  const m = members[0]!;
  const s = getStructOfType(c, m);
  if (s) return structCell(CellKind.Struct, s);
  const element = getSharedArrayElementType(c, m);
  if (element) {
    const integer = getIntegerKind(c, element);
    if (integer === 'i') return arrayOf(CellKind.ArrayOfI32);
    if (integer === 'u') return arrayOf(CellKind.ArrayOfU8);
    if (element.flags & TypeFlags.Number)
      return arrayOf(CellKind.ArrayOfNumber);
    if (isBooleanType(element)) return arrayOf(CellKind.ArrayOfBoolean);
    if (isStringType(c, element)) return arrayOf(CellKind.ArrayOfString);
    const es = getStructOfType(c, element);
    if (es) return structCell(CellKind.ArrayOfStruct, es);
  }
  return noCell;
}

// Reports whether a value of type t is a shared struct or a SharedArray
// (possibly with null or undefined), which is represented by an address:
// isOwnCellType.
export function isCellType(c: Own, t: Type | undefined): boolean {
  if (!t) return false;
  let result = c.cellTypes.get(t);
  if (result !== undefined) return result;
  const members = nonNullishMembers(c, t);
  result =
    members.length > 0 &&
    members.every(
      m =>
        getStructOfType(c, m) !== undefined ||
        getSharedArrayElementType(c, m) !== undefined,
    );
  c.cellTypes.set(t, result);
  return result;
}

export function isCellExpression(c: Own, expr: Node | undefined): boolean {
  return !!expr && isExpression(expr) && isCellType(c, c.host.typeOf(expr));
}

// Checks the element type of a SharedArray type reference (or of a `new` of
// one): numbers, booleans, strings or a shared struct.
function checkSharedArrayElementType(c: Own, node: Node, t: Type): void {
  if (node.flags & NodeFlags.Ambient) return;
  const element = getSharedArrayElementType(c, t);
  if (
    !element ||
    (element.flags & TypeFlags.Number && !(element.flags & TypeFlags.Union)) ||
    getIntegerKind(c, element) !== '' ||
    isBooleanType(element) ||
    isStringType(c, element) ||
    getStructOfType(c, element)
  )
    return;
  c.error(node, Messages.SharedArrayElement);
}

// The layout of a union of shared structs, given its non-nullish members, or
// undefined if they are not all shared structs: a field where it is at the same
// place, stored the same way, in every member, and "" in the other slots.
function getStructOfUnion(
  c: Own,
  t: Type,
  members: Type[],
): StructInfo | undefined {
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
  const first = structs[0]!;
  const info: StructInfo = {
    decl: undefined,
    name: '',
    fields: first.fields.slice(0, n),
    kinds: first.kinds.slice(0, n),
    types: first.types.slice(0, n),
  };
  for (const s of structs.slice(1)) {
    for (let k = 0; k < n; k++) {
      if (s.fields[k] !== info.fields[k] || s.kinds[k] !== info.kinds[k]) {
        info.fields[k] = '';
        info.kinds[k] = '';
      }
      if (s.types[k] !== info.types[k]) info.types[k] = undefined;
    }
  }
  c.structUnions.set(t, info);
  return info;
}

// Reports an access to a field of a union of shared structs that is at
// different places in them.
function checkStructUnionField(c: Own, access: Node, t: Type): void {
  const members = nonNullishMembers(c, t);
  const name = access.name.text as string;
  if (
    members.length > 1 &&
    members.every(m => getStructOfType(c, m)?.fields.includes(name))
  ) {
    c.error(access.name, Messages.UnionField, name);
  }
}

// Boxing

// Reports whether an expression holds a handle although its type is a struct or
// SharedArray: a variable or property declared with another type and narrowed
// to one.
export function isNarrowedReference(c: Own, expr: Node): boolean {
  let symbol;
  if (expr.kind === K.Identifier) {
    symbol = c.host.resolvedSymbol(expr);
    if (symbol) symbol = c.host.exportSymbolIfExported(symbol);
  } else if (expr.kind === K.PropertyAccessExpression) {
    symbol = c.host.symbolAt(expr.name);
  }
  if (
    !symbol ||
    !(symbol.flags & (SymbolFlags.Variable | SymbolFlags.Property))
  )
    return false;
  return !isCellType(c, c.host.typeOfSymbol(symbol));
}

// Records the conversion of an expression flowing into a place whose
// representation is raw (targetRaw) or a handle. Conditional and logical
// expressions pass the target on to their operands.
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
        case K.AmpersandAmpersandToken:
        case K.BarBarToken:
        case K.QuestionQuestionToken:
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

// The type a place has: undefined for none, or null for the error type (a
// handle).
type Target = Type | undefined | null;

// cast: a type assertion's, which may name a struct laid out as the value's and
// more (a downcast) as well as one laid out as a part of it
function setTargetType(
  c: Own,
  expr: Node | undefined,
  target: Target,
  cast = false,
): void {
  if (!expr || target === undefined) return;
  if (target !== null) {
    checkIntegerTarget(c, expr, target);
    checkLayoutTarget(c, expr, target, cast);
  }
  setTarget(c, expr, target !== null && isCellType(c, target));
}

// A shared struct value used as another struct type (TypeScript relates struct
// types by their members, not by their layouts): the other's fields must be
// this one's first, in order and of the same kinds, as the reads and writes
// typed by the other go by its places. A SharedArray's elements must be laid
// out as the other's, as its element size is theirs. The expression's
// branches are checked as setTarget walks them.
function checkLayoutTarget(
  c: Own,
  expr: Node,
  target: Type,
  cast: boolean,
): void {
  switch (expr.kind) {
    case K.ParenthesizedExpression:
      checkLayoutTarget(c, expr.expression, target, cast);
      return;
    case K.ConditionalExpression:
      checkLayoutTarget(c, expr.whenTrue, target, cast);
      checkLayoutTarget(c, expr.whenFalse, target, cast);
      return;
    case K.BinaryExpression:
      switch (expr.operatorToken.kind) {
        case K.AmpersandAmpersandToken:
          // a struct is truthy: a struct on the left is never the result
          checkLayoutTarget(c, expr.right, target, cast);
          return;
        case K.BarBarToken:
        case K.QuestionQuestionToken: {
          // the right is the result only if the left may be falsy (||), or
          // null or undefined (??): not after a struct, which is neither
          checkLayoutTarget(c, expr.left, target, cast);
          const left = c.host.typeOf(expr.left);
          const members =
            left.flags & TypeFlags.Union ? c.host.memberTypes(left) : [left];
          const passes =
            expr.operatorToken.kind === K.BarBarToken
              ? members.some(
                  m =>
                    !(
                      m.flags &
                      (TypeFlags.Object |
                        TypeFlags.NonPrimitive |
                        TypeFlags.ESSymbolLike |
                        TypeFlags.Intersection)
                    ),
                )
              : members.some(
                  m =>
                    !!(
                      m.flags &
                      (TypeFlags.Any |
                        TypeFlags.Unknown |
                        TypeFlags.Nullable |
                        TypeFlags.Void |
                        TypeFlags.InstantiableNonPrimitive |
                        TypeFlags.InstantiablePrimitive)
                    ),
                );
          if (passes) checkLayoutTarget(c, expr.right, target, cast);
          return;
        }
        case K.CommaToken:
          checkLayoutTarget(c, expr.right, target, cast);
          return;
      }
  }
  if (!isExpression(expr)) return;
  const source = c.host.typeOf(expr);
  const why = layoutMismatch(c, source, target, cast);
  if (why)
    c.error(
      expr,
      Messages.LayoutMismatch,
      c.host.typeToString(source),
      c.host.typeToString(target),
      why,
    );
}

// The shared structs of t's members other than null, undefined and the
// primitives (a falsy 0 beside a struct), or none when one of them is not a
// struct (a handle's type, a type parameter).
function structsOf(c: Own, t: Type): StructInfo[] {
  const result: StructInfo[] = [];
  for (const member of nonNullishMembers(c, t)) {
    if (member.flags & TypeFlags.Primitive) continue;
    const s = getStructOfType(c, member);
    if (!s) return [];
    result.push(s);
  }
  return result;
}

// The pairs being compared (a struct's reference field may refer to the
// struct, a function return one): a pair met again is taken to hold, as what
// it holds by is being compared already.
interface Seen {
  structs: Map<StructInfo, Set<StructInfo>>;
  types: Map<Type, Set<Type>>;
}
const newSeen = (): Seen => ({structs: new Map(), types: new Map()});
function within<K, R>(
  pairs: Map<K, Set<K>>,
  a: K,
  b: K,
  held: R,
  compare: () => R,
): R {
  let bs = pairs.get(a);
  if (bs?.has(b)) return held;
  if (!bs) pairs.set(a, (bs = new Set()));
  bs.add(b);
  try {
    return compare();
  } finally {
    bs.delete(b);
  }
}

// why a value of struct `from` may not be used as struct `to`, or undefined if
// it may: `to`'s fields first in `from`, in order and of the same kinds, and
// what each reference field refers to as what `to`'s field is read as, so on
// down (a cast may go either way there too)
function unfit(
  c: Own,
  from: StructInfo,
  to: StructInfo,
  cast: boolean,
  seen: Seen,
): string | undefined {
  if (from === to) return undefined;
  for (let k = 0; k < to.fields.length; k++) {
    const f = to.fields[k]!;
    if (from.fields[k] === f && from.kinds[k] === to.kinds[k]) continue;
    const at = from.fields.indexOf(f);
    if (at < 0) return `'${from.name}' has no field '${f}'`;
    if (at !== k)
      return `field '${f}' is at place ${at} of '${from.name}' and ${k} of '${to.name}'`;
    return `field '${f}' is of another kind in '${from.name}' than in '${to.name}'`;
  }
  return within(seen.structs, from, to, undefined, () => {
    for (let k = 0; k < to.fields.length; k++) {
      const a = from.types[k],
        b = to.types[k];
      if (to.kinds[k] !== 'r' || !a || !b) continue;
      const why = layoutMismatch(c, a, b, cast, seen);
      if (why)
        return `field '${to.fields[k]}' of '${from.name}' refers to what that of '${to.name}' cannot stand for: ${why}`;
    }
    return undefined;
  });
}

function layoutMismatch(
  c: Own,
  source: Type,
  target: Type,
  cast: boolean,
  seen: Seen = newSeen(),
): string | undefined {
  // SharedArrays, member by member (a place may be one or null): each array of
  // the value's must have the elements, laid out the same, of one of the
  // place's, as its element size is theirs
  const elements = (t: Type) =>
    nonNullishMembers(c, t)
      .map(m => getSharedArrayElementType(c, m))
      .filter((e): e is Type => e !== undefined);
  const sourceElements = elements(source),
    targetElements = elements(target);
  if (sourceElements.length !== 0 && targetElements.length !== 0) {
    for (const e of sourceElements) {
      const from = getStructOfType(c, e);
      if (!from) continue;
      // only the place's arrays whose elements these can be: one of numbers
      // takes no struct, and must not let one through
      const into = targetElements.filter(t =>
        c.host.checker.isTypeAssignableTo(e as any, t as any),
      );
      const tos = (into.length !== 0 ? into : targetElements).map(t =>
        getStructOfType(c, t),
      );
      if (
        !tos.some(
          to =>
            !to ||
            (from.fields.length === to.fields.length &&
              !unfit(c, from, to, false, seen)),
        )
      )
        return `the elements are '${from.name}' structs, which '${tos[0]!.name}' structs, of another layout or size, cannot stand for`;
    }
    return undefined;
  }
  const tos = structsOf(c, target);
  if (tos.length === 0) {
    // a promise: what it resolves to, into what the place's does
    if (source.flags & TypeFlags.Object && target.flags & TypeFlags.Object) {
      const from = c.host.awaitedType(source),
        to = c.host.awaitedType(target);
      if (from !== source && to !== target) {
        const why = layoutMismatch(c, from, to, cast, seen);
        return why && `what it resolves to: ${why}`;
      }
    }
    return callableMismatch(c, source, target, cast, seen);
  }
  for (const from of structsOf(c, source)) {
    let why: string | undefined;
    for (const to of tos) {
      const up = unfit(c, from, to, cast, seen);
      if (!up || (cast && !unfit(c, to, from, cast, seen))) {
        why = undefined;
        break;
      }
      why ??= up;
    }
    if (why) return why;
  }
  return undefined;
}

// A function used as one of another type: what it returns is taken for what
// the other returns, and what the other is called with is passed as its
// parameters, so both go as a value into a place (a callback's own, as deep
// as they go). Each of the place's signatures against the value's one that
// TypeScript relates to it: the first whose parameters and result are
// assignable to it, or its only one.
function callableMismatch(
  c: Own,
  source: Type,
  target: Type,
  cast: boolean,
  seen: Seen,
): string | undefined {
  const composite = TypeFlags.Object | TypeFlags.Union | TypeFlags.Intersection;
  if (!(source.flags & composite) || !(target.flags & composite))
    return undefined;
  const host = c.host;
  // a union of functions: any of them may be the one called
  if (source.flags & TypeFlags.Union) {
    for (const member of host.memberTypes(source)) {
      const why = callableMismatch(c, member, target, cast, seen);
      if (why) return why;
    }
    return undefined;
  }
  const assignable = (a: Type | undefined, b: Type | undefined) =>
    !a || !b || host.checker.isTypeAssignableTo(a as any, b as any);
  const returnOf = (s: Signature) =>
    host.checker.getReturnTypeOfSignature(s as any) as Type;
  return within(seen.types, source, target, undefined, () => {
    // its calls, then its constructions (a struct type's new () makes one)
    for (const construct of [false, true]) {
      const froms = host.callSignatures(source, construct);
      if (froms.length === 0) continue;
      for (const to of host.callSignatures(target, construct)) {
        // a call of `to` passes its parameters' worth of arguments, which an
        // overload that needs more cannot take
        const from =
          froms.length === 1
            ? froms[0]
            : froms.find(
                f =>
                  host.requiredArguments(f) <= to.parameters.length &&
                  to.parameters.every((_, i) => {
                    const passed = host.parameterTypeAt(to, i),
                      taken = host.parameterTypeAt(f, i);
                    return (
                      assignable(passed, taken) || assignable(taken, passed)
                    );
                  }) &&
                  assignable(returnOf(f), returnOf(to)),
              );
        if (!from) continue;
        const result = layoutMismatch(
          c,
          returnOf(from),
          returnOf(to),
          cast,
          seen,
        );
        if (result)
          return `${construct ? 'what it constructs' : 'what it returns'}: ${result}`;
        for (let i = 0; i < to.parameters.length; i++) {
          const passed = host.parameterTypeAt(to, i),
            taken = host.parameterTypeAt(from, i);
          if (!passed || !taken) break;
          const why = layoutMismatch(c, passed, taken, cast, seen);
          if (why) return `what it is called with, parameter ${i + 1}: ${why}`;
        }
      }
    }
    return undefined;
  });
}

export function getConversion(c: Own, expr: Node): Conversion {
  return c.conversions.get(expr) ?? Conversion.None;
}

// Computes the box and unbox conversions of a file, and reports the layout
// errors (assigning an inline struct element, optional chaining, destructuring
// a struct parameter, a field at different places in a union, a SharedArray of
// other elements).
export function computeConversions(c: Own, file: SourceFile): void {
  const visit = (node: Node): boolean => {
    if (isTypeNode(node)) {
      // Type references are checked as the checker checks them
      // (checkTypeReferenceNode).
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
  if (node.kind === K.TypeReference)
    checkSharedArrayElementType(
      c,
      node,
      c.host.checker.getTypeFromTypeNode(node as any),
    );
  forEachChild(node, child => {
    checkTypeReferences(c, child);
  });
}

function computeConversion(c: Own, node: Node): void {
  const host = c.host;
  switch (node.kind) {
    case K.CallExpression:
    case K.NewExpression: {
      if (node.kind === K.NewExpression)
        checkSharedArrayElementType(c, node, host.typeOf(node));
      const args = node.arguments as Node[] | undefined;
      if (
        !args ||
        args.length === 0 ||
        (node.kind === K.CallExpression &&
          node.expression.kind === K.ImportKeyword)
      )
        return;
      const signature = host.signatureOf(node);
      const unresolved =
        (!signature.declaration && signature.parameters.length === 0) ||
        host.checker.isUnknownSignature(signature);
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
    case K.VariableDeclaration:
    case K.PropertyDeclaration:
    case K.Parameter: {
      const init = node.initializer as Node | undefined;
      if (isBindingPattern(node.name)) {
        if (init) {
          setTarget(c, init, false); // destructured through the handle
        } else if (
          node.kind === K.Parameter ||
          (node.kind === K.VariableDeclaration &&
            node.parent?.parent?.kind === K.ForOfStatement)
        ) {
          // A parameter or loop variable cannot be boxed before it is
          // destructured.
          const t = host.typeOf(node.name);
          if (isCellType(c, t))
            c.error(node.name, Messages.Destructured, host.typeToString(t));
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
      if (node.expression)
        setTargetType(
          c,
          node.expression,
          getReturnTargetType(c, getContainingFunction(node)),
        );
      return;
    case K.ArrowFunction:
      if (node.body && node.body.kind !== K.Block)
        setTargetType(c, node.body, getReturnTargetType(c, node));
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
          if (host.checker.isTupleType(literalType))
            target = host.typeArguments(literalType)[i];
          else
            target = host.checker.getIndexTypeOfType(
              literalType,
              IndexKind.Number,
            );
        }
        setTargetType(c, element, target);
      });
      return;
    }
    case K.PropertyAssignment:
      if (!isAssignmentTarget(node.parent))
        setTargetType(
          c,
          node.initializer,
          host.checker.getContextualType(node.initializer),
        );
      return;
    case K.ShorthandPropertyAssignment:
      if (!isAssignmentTarget(node.parent))
        setTargetType(c, node.name, host.checker.getContextualType(node.name));
      return;
    case K.SpreadAssignment:
    case K.TemplateSpan:
    case K.TypeOfExpression:
      setTarget(c, node.expression, false);
      return;
    case K.AsExpression:
    case K.TypeAssertionExpression:
      setTargetType(
        c,
        node.expression,
        host.checker.getTypeFromTypeNode(node.type),
        true,
      );
      return;
    case K.ForOfStatement:
    case K.ForInStatement:
      setTarget(c, node.expression, false);
      return;
    case K.CaseClause: {
      // `case null:` against an address compares with 0.
      const switchExpression = (node.parent!.parent as Node).expression as Node;
      if (
        isCellExpression(c, switchExpression) &&
        !isNarrowedReference(c, switchExpression)
      ) {
        if (isNullishOnly(c, host.typeOf(node.expression)))
          setTarget(c, node.expression, true);
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
          // A field is read through the layout; anything else through the
          // handle.
          const k = cell.fields.indexOf(name);
          if (k < 0) checkStructUnionField(c, node, t);
          if (cell.kinds[k] === 's' || cell.kinds[k] === 'c')
            checkConvertedTarget(c, node);
          setTarget(c, object, k >= 0);
          break;
        }
        default:
          setTarget(c, object, isArrayKind(cell.kind) && name === 'length');
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
      if (kind === CellKind.ArrayOfString) checkConvertedTarget(c, node);
      setTarget(c, object, isArrayKind(kind));
      return;
    }
  }
}

// Reports a string or channel field, or a string element, that is assigned by
// destructuring or as a for-in or for-of variable: the emit converts the value
// (interns a string, takes a channel's address) only where it is assigned on
// its own.
function checkConvertedTarget(c: Own, access: Node): void {
  const target = getAssignmentTarget(access);
  if (
    !target ||
    target.kind === K.PrefixUnaryExpression ||
    target.kind === K.PostfixUnaryExpression
  )
    return; // `++` on a string is a type error already
  if (
    target.kind === K.BinaryExpression &&
    skipParentheses(target.left) === access
  )
    return;
  c.error(access, Messages.StringTarget);
}

function computeBinaryConversion(c: Own, node: Node): void {
  const host = c.host;
  const op = node.operatorToken.kind;
  const left = node.left as Node;
  const right = node.right as Node;
  switch (op) {
    case K.EqualsToken:
      if (
        left.kind === K.ArrayLiteralExpression ||
        left.kind === K.ObjectLiteralExpression
      ) {
        setTarget(c, right, false); // destructured through the handle
        return;
      }
      if (
        left.kind === K.ElementAccessExpression &&
        getCellType(c, host.typeOf(left.expression)).kind ===
          CellKind.ArrayOfStruct
      ) {
        c.error(left, Messages.InlineStructElement);
        return;
      }
      setTargetType(c, right, getAssignmentTargetType(c, left));
      return;
    case K.BarBarEqualsToken:
    case K.AmpersandAmpersandEqualsToken:
    case K.QuestionQuestionEqualsToken:
      setTargetType(c, right, getAssignmentTargetType(c, left));
      return;
    case K.PlusToken:
    case K.PlusEqualsToken:
      // String concatenation (arithmetic on a struct is already a type error).
      if (isCellExpression(c, left) && op === K.PlusToken)
        setTarget(c, left, false);
      if (isCellExpression(c, right)) setTarget(c, right, false);
      if (op === K.PlusEqualsToken)
        checkIntegerCompoundAssignment(
          c,
          node,
          getAssignmentTargetType(c, left),
        );
      return;
    case K.MinusEqualsToken:
    case K.AsteriskEqualsToken:
    case K.SlashEqualsToken:
    case K.PercentEqualsToken:
    case K.AsteriskAsteriskEqualsToken:
      checkIntegerCompoundAssignment(c, node, getAssignmentTargetType(c, left));
      return;
    case K.EqualsEqualsEqualsToken:
    case K.ExclamationEqualsEqualsToken:
    case K.EqualsEqualsToken:
    case K.ExclamationEqualsToken: {
      const leftType = host.typeOf(left);
      const rightType = host.typeOf(right);
      const leftCell = isCellType(c, leftType);
      const rightCell = isCellType(c, rightType);
      if (leftCell && rightCell) {
        setTarget(c, left, true);
        setTarget(c, right, true);
      } else if (leftCell) {
        // Compare addresses with null and undefined (as 0), handles with
        // anything else.
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

// The type a function's returned values flow into: its declared, contextual or
// inferred return type.
function getReturnTargetType(c: Own, fn: Node | undefined): Target {
  if (!fn || !isFunctionLike(fn)) return undefined;
  const flags = getFunctionFlags(fn);
  if (flags & FunctionFlags.Generator) return undefined;
  const host = c.host;
  const unwrap = (t: Type): Target =>
    flags & FunctionFlags.Async ? (host.checker.getAwaitedType(t) ?? null) : t;
  if (fn.type) return unwrap(host.checker.getTypeFromTypeNode(fn.type));
  if (isFunctionExpressionOrArrowFunction(fn) || isObjectLiteralMethod(fn)) {
    const signature = host.contextualSignature(fn);
    if (signature)
      return unwrap(host.checker.getReturnTypeOfSignature(signature));
  }
  return unwrap(
    host.checker.getReturnTypeOfSignature(
      host.checker.getSignatureFromDeclaration(fn),
    ),
  );
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
