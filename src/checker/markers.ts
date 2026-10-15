// The plain TypeScript API of threads (ownmarkers.go): the module the runtime
// specifier names (threads.d.ts) exports markers that stock TypeScript accepts,
// and the checker gives them their meaning:
//
//   Sending<T>                 a value whose ownership moves (a parameter, a
//                              rest parameter, a result)
//   Shared<T>                  a shared value (deeply readonly)
//   consume(x)                 ends x's lifetime
//   a type assignable to Cell  a cell: shared and region-less
//   const S = struct({ a: f64, next: ref<T>() }), const S = struct<I>({ ... })
//                              a shared struct: its fields in the order of the
//                              object literal, `f64` a number field and
//                              `ref<T>()` a reference field.
//
// A marker is recognized by its declaration: an export of the runtime module,
// by name.

import {CellKind} from './context.ts';
import type {FieldKind, Own, StructInfo} from './context.ts';
import {IndexKind, ObjectFlags, SymbolFlags, TypeFlags} from './host.ts';
import type {Signature, TsSymbol, Type} from './host.ts';
import {getCellType, getFieldKind, isFieldType} from './layout.ts';
import {Messages} from './messages.ts';
import {
  forEachChild,
  isPropertyNameLiteral,
  isThisParameter,
  K,
  NodeFlags,
  skipParentheses,
  walkUpParenthesizedExpressions,
} from './syntax.ts';
import type {Node} from './syntax.ts';

// The name of the runtime export a symbol is (or is an alias of), or "" if it
// is none.
export function getRuntimeExportName(
  c: Own,
  symbol: TsSymbol | undefined,
): string {
  if (!symbol) return '';
  let name = c.runtimeExportNames.get(symbol);
  if (name !== undefined) return name;
  let target: TsSymbol | undefined = symbol;
  if (symbol.flags & SymbolFlags.Alias) target = c.host.resolveAlias(symbol);
  name =
    target && target.declarations.some(d => c.isRuntimePath(d.path))
      ? target.name
      : '';
  c.runtimeExportNames.set(symbol, name);
  return name;
}

// The name an expression reads a member by: a property's, or a literal key's
// (`ns["f64"]` , ns[`f64`] ), or "" for another.
function memberName(expr: Node): string {
  if (expr.kind === K.PropertyAccessExpression) return expr.name.text;
  if (expr.kind !== K.ElementAccessExpression) return '';
  const key = skipParentheses(expr.argumentExpression);
  return key.kind === K.StringLiteral ||
    key.kind === K.NoSubstitutionTemplateLiteral
    ? key.text
    : '';
}

// The symbol an expression refers to: a name's, or a member's read by a
// property or a literal key (`threads.f64` and `threads["f64"]` alike).
function referencedSymbol(c: Own, expr: Node): TsSymbol | undefined {
  if (expr.kind === K.Identifier) return c.host.resolvedSymbol(expr);
  if (expr.kind === K.PropertyAccessExpression)
    return c.host.symbolAt(expr.name);
  const name = memberName(expr);
  if (name === '') return undefined;
  return c.host.checker.getPropertyOfType(
    c.host.typeOf(expr.expression) as any,
    name,
  ) as TsSymbol | undefined;
}

// The runtime's export an expression is, by the name it exports it by: the
// export itself (through an import alias, or a namespace's member read by its
// property or a literal key), a const that holds one, or a const destructured
// from the namespace (`const { f64: double } = threads` ); "" for another.
function runtimeExportOf(c: Own, expr: Node, seen = new Set<Node>()): string {
  while (
    expr.kind === K.ParenthesizedExpression ||
    expr.kind === K.AsExpression ||
    expr.kind === K.SatisfiesExpression ||
    expr.kind === K.NonNullExpression ||
    expr.kind === K.TypeAssertionExpression
  )
    expr = expr.expression;
  if (seen.has(expr)) return '';
  seen.add(expr);
  let symbol = referencedSymbol(c, expr);
  const name = getRuntimeExportName(c, symbol);
  if (name !== '') return name;
  if (symbol && symbol.flags & SymbolFlags.Alias)
    symbol = c.host.resolveAlias(symbol);
  const decl = symbol && c.host.valueDeclaration(symbol);
  if (!decl) return '';
  if (
    decl.kind === K.VariableDeclaration &&
    decl.initializer &&
    (decl.parent as Node).flags & NodeFlags.Const
  )
    return runtimeExportOf(c, decl.initializer, seen);
  // the member a const's object pattern selects from what it destructures
  const variable = (decl.parent as Node | undefined)?.parent as
    | Node
    | undefined;
  if (
    decl.kind === K.BindingElement &&
    !decl.dotDotDotToken &&
    decl.parent.kind === K.ObjectBindingPattern &&
    variable?.kind === K.VariableDeclaration &&
    variable.initializer &&
    (variable.parent as Node).flags & NodeFlags.Const
  ) {
    const key = (decl.propertyName ?? decl.name) as Node;
    if (key.kind !== K.Identifier && key.kind !== K.StringLiteral) return '';
    return getRuntimeExportName(
      c,
      c.host.checker.getPropertyOfType(
        c.host.typeOf(variable.initializer) as any,
        key.text,
      ) as TsSymbol | undefined,
    );
  }
  return '';
}

// The marker a type node refers to: "Sending" or "Shared" for `Sending<T>` and
// `Shared<T>` , or "".
export function getTypeMarker(c: Own, t: Node | undefined): string {
  if (!t || t.kind !== K.TypeReference || t.typeArguments?.length !== 1)
    return '';
  const name = getRuntimeExportName(c, c.host.symbolAt(t.typeName));
  return name === 'Sending' || name === 'Shared' ? name : '';
}

// The marker function a call calls: "consume", "struct", "ref", or "". By the
// declaration the call resolves to, whatever the callee looks like: `consume as
// take`, a const that holds it, `threads["consume"]`, an asserted alias, are
// consume too. (The signature is fetched once per call and cached; a
// declaration is looked up for the runtime's own only.) An `import()` is no
// call of a declaration.
export function getCallMarker(c: Own, call: Node | undefined): string {
  if (!call || call.kind !== K.CallExpression) return '';
  if (call.expression.kind === K.ImportKeyword) return '';
  const handle = c.host.signatureOf(call).declaration;
  if (
    !handle ||
    handle.kind !== K.FunctionDeclaration ||
    !c.isRuntimePath(handle.path)
  )
    return '';
  const declared = c.host.declarationOf(handle)?.name?.text;
  return declared === 'consume' || declared === 'struct' || declared === 'ref'
    ? declared
    : '';
}

// The operations of the runtime's `atomic` , which are those of `Atomics` by
// the same names.
const atomicOperations = new Set([
  'load',
  'store',
  'add',
  'sub',
  'and',
  'or',
  'xor',
  'exchange',
  'compareExchange',
  'wait',
  'notify',
]);

// Whether a call is an atomic operation (getOwnAtomicCall): undefined if it is
// not one, true if it acts on an i32 field of a shared struct named by a string
// literal or on an element of a SharedArray<i32>, and false if it acts on
// anything else, which is an error.
export function isAtomicCallValid(c: Own, call: Node): boolean | undefined {
  if (getAtomicOperation(c, call) === '') return undefined;
  if (call.arguments.length < 2) return false;
  const cell = getCellType(c, c.host.typeOf(call.arguments[0]));
  if (cell.kind === CellKind.ArrayOfI32) return true;
  if (cell.kind !== CellKind.Struct) return false;
  const key = skipParentheses(call.arguments[1]);
  if (
    key.kind !== K.StringLiteral &&
    key.kind !== K.NoSubstitutionTemplateLiteral
  )
    return false;
  return cell.kinds[cell.fields.indexOf(key.text)] === 'i';
}

// The operation of the runtime's `atomic` a call calls (`atomic.add(...)` ,
// `threads.atomic["add"](...)` and the like), or "".
export function getAtomicOperation(c: Own, call: Node): string {
  const callee = skipParentheses(call.expression);
  const op = memberName(callee);
  if (!atomicOperations.has(op)) return '';
  return runtimeExportOf(c, callee.expression) === 'atomic' ? op : '';
}

// The runtime's calls that block their thread, by declaring class and name, and
// what an async function calls instead ("" for none). The fork's table has no
// recvOk yet.
const blockingCalls = new Map([
  ['Channel.send', 'sendAsync'],
  ['Channel.recv', 'recvAsync'],
  ['Channel.recvOk', 'recvOkAsync'],
  ['ChannelCell.send', 'sendAsync'],
  ['ChannelCell.recv', 'recvAsync'],
  ['Thread.join', 'joinAsync'],
  ['Lock.hold', 'holdAsync'],
  ['Condition.wait', 'waitAsync'],
  ['select', 'selectAsync'],
  ['scope', ''],
]);

// A call of the runtime's that blocks its thread (getOwnBlockingCall): its
// name, and what an async function calls instead ("" for none).
export function getBlockingCall(
  c: Own,
  call: Node,
): {name: string; instead: string} | undefined {
  const op = getAtomicOperation(c, call);
  if (op !== '')
    return op === 'wait' ? {name: `atomic.${op}`, instead: ''} : undefined;
  const handle = c.host.signatureOf(call).declaration;
  if (!handle || !c.isRuntimePath(handle.path)) return undefined;
  const decl = c.host.declarationOf(handle);
  if (!decl || decl.name?.kind !== K.Identifier) return undefined;
  let key = decl.name.text as string;
  const owner = decl.parent as Node | undefined;
  if (
    (decl.kind === K.MethodDeclaration || decl.kind === K.MethodSignature) &&
    owner?.name
  )
    key = `${owner.name.text}.${key}`;
  const instead = blockingCalls.get(key);
  return instead === undefined ? undefined : {name: decl.name.text, instead};
}

// Reports whether an expression is `consume(x)`.
export function isConsumeCall(c: Own, expr: Node): boolean {
  return (
    expr.kind === K.CallExpression &&
    expr.arguments.length === 1 &&
    getCallMarker(c, expr) === 'consume'
  );
}

// The runtime's interface or class of a given name, if it exports one.
function getRuntimeType(c: Own, name: string): Type | undefined {
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

// Reports whether a type is a cell of the plain API: assignable to the
// runtime's `Cell` (Lock, Condition, Channel, SharedArray, SharedMap,
// SharedSet, a struct's values), or a struct type or a field marker (immutable,
// `IntegerField` included). Its values are shared, with no region. A Thread and
// a Scope are not cells: they stay on the thread that made them.
export function isCellBranded(c: Own, t: Type | undefined): boolean {
  if (
    !t ||
    t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Never | TypeFlags.Primitive)
  )
    return false;
  let result = c.cellBranded.get(t);
  if (result !== undefined) return result;
  result = false;
  if (t.flags & TypeFlags.Object) {
    const target = c.host.typeTarget(t);
    const symbol = target && c.host.typeSymbol(target);
    if (
      symbol &&
      (symbol.name === 'StructType' ||
        symbol.name === 'Field' ||
        symbol.name === 'IntegerField') &&
      getRuntimeExportName(c, symbol) !== ''
    ) {
      result = true;
    }
  }
  if (!result) result = isAssignableToCell(c, t);
  c.cellBranded.set(t, result);
  return result;
}

// Reports whether a type is assignable to the runtime's `Cell` : its values
// are cells the runtime made (not a struct type or a field marker, which are
// ordinary objects at run time).
export function isAssignableToCell(c: Own, t: Type): boolean {
  const cell = getRuntimeType(c, 'Cell');
  return (
    !!cell &&
    !!(t.flags & (TypeFlags.Object | TypeFlags.Intersection)) &&
    c.host.checker.isTypeAssignableTo(t, cell)
  );
}

// What the thread that made a Thread or a Scope does with it (StaysHere).
const staysWith: Record<string, string> = {
  Thread: 'joins it',
  Scope: 'spawns on it in its body',
};

// "Thread" or "Scope" if t is the runtime's, an interface that extends it, or
// a view of it that keeps its properties (Readonly<T>, Partial<T>, Shared<T>),
// else "".
function threadOrScope(c: Own, t: Type, depth = 0): string {
  if (!(t.flags & TypeFlags.Object) || depth > 8) return '';
  if ((t as any).objectFlags & ObjectFlags.Mapped) {
    const source = viewOf(c, t);
    return source ? viewed(c, source, depth + 1) : '';
  }
  const symbol = c.host.typeSymbol(t);
  if (!symbol) return '';
  if (
    Object.hasOwn(staysWith, symbol.name) &&
    getRuntimeExportName(c, symbol) === symbol.name
  )
    return symbol.name;
  if (!(symbol.flags & SymbolFlags.Interface)) return '';
  for (const base of c.host.checker.getBaseTypes(
    (c.host.typeTarget(t) ?? t) as any,
  ) as readonly Type[]) {
    const name = threadOrScope(c, base, depth + 1);
    if (name) return name;
  }
  return '';
}

// What the source of a view may be at run time, as threadOrScope names it: a
// type parameter by its constraint, a union or an intersection by a member.
function viewed(c: Own, t: Type, depth: number): string {
  if (depth > 8) return '';
  if (t.flags & TypeFlags.Instantiable) {
    const constraint = c.host.checker.getBaseConstraintOfType(t as any) as
      | Type
      | undefined;
    return constraint ? viewed(c, constraint, depth + 1) : '';
  }
  if (t.flags & (TypeFlags.Union | TypeFlags.Intersection)) {
    for (const m of c.host.memberTypes(t)) {
      const name = viewed(c, m, depth + 1);
      if (name) return name;
    }
    return '';
  }
  return threadOrScope(c, t, depth);
}

// The T a mapped type is a view of, keeping T's properties: its template is
// T[P] (with undefined for an optional property, as Partial<T>'s), or else
// every property is of the type T's of that name has (Shared<T> of a Thread,
// whose properties are methods). Not one that makes other properties of T's,
// which is checked by what it makes.
function viewOf(c: Own, t: Type): Type | undefined {
  const host = c.host;
  const parameter = (t as any).getTypeParameter() as Type;
  const template = (t as any).getTemplateType() as Type;
  const exact = (x: Type | undefined) =>
    x &&
    x.flags & TypeFlags.IndexedAccess &&
    (x as any).getIndexType() === parameter
      ? ((x as any).getObjectType() as Type)
      : undefined;
  const defined =
    template.flags & TypeFlags.Union
      ? host.memberTypes(template).filter(m => !(m.flags & TypeFlags.Undefined))
      : [template];
  const source = defined.length === 1 ? exact(defined[0]) : undefined;
  if (source) return source;
  const read = mappedSource(template);
  if (!read) return undefined;
  const properties = host.checker.getPropertiesOfType(t as any);
  return properties.length > 0 &&
    properties.every(p => {
      const theirs = host.checker.getPropertyOfType(read as any, p.name);
      return !!theirs && host.typeOfSymbol(theirs) === host.typeOfSymbol(p);
    })
    ? read
    : undefined;
}

// The T a mapped type over T reads, by its template: the T of `T[P]` , in a
// union (`T[P] | undefined`) or checked by a conditional type (`Shared<T[P]>`).
function mappedSource(template: Type): Type | undefined {
  if (template.flags & TypeFlags.IndexedAccess)
    return (template as any).getObjectType() as Type;
  if (template.flags & TypeFlags.Conditional)
    return mappedSource((template as any).getCheckType() as Type);
  if (template.flags & TypeFlags.Union)
    for (const m of (template as any).getTypes() as Type[]) {
      const source = mappedSource(m);
      if (source) return source;
    }
  return undefined;
}

// A Thread or a Scope of the runtime's in a value of type t, where a message or
// a share reaches at run time: t itself, a member of a union or an
// intersection, a type parameter's constraint, an element of an array or a
// tuple, or a property of an object type (a plain object, at run time). Not in
// a cell, which goes by reference, nor in a function or an object of the
// default library's (a Map, a Promise), which are not sent as plain objects
// are; its mapped types (Record, Readonly) are plain objects.
function findStaysHere(c: Own, t: Type, seen: Set<Type>): Type | undefined {
  if (
    seen.has(t) ||
    t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Never | TypeFlags.Primitive)
  )
    return undefined;
  seen.add(t);
  const host = c.host;
  const inAny = (ts: readonly Type[]) => {
    for (const m of ts) {
      const found = findStaysHere(c, m, seen);
      if (found) return found;
    }
    return undefined;
  };
  if (t.flags & TypeFlags.Union) return inAny(host.memberTypes(t));
  if (t.flags & TypeFlags.Instantiable) {
    const constraint = host.checker.getBaseConstraintOfType(t as any) as
      | Type
      | undefined;
    return constraint ? findStaysHere(c, constraint, seen) : undefined;
  }
  if (!(t.flags & (TypeFlags.Object | TypeFlags.Intersection)))
    return undefined;
  if (threadOrScope(c, t)) return t;
  if (isCellBranded(c, t)) return undefined;
  if (t.flags & TypeFlags.Intersection) return inAny(host.memberTypes(t));
  if (host.checker.isArrayType(t as any) || host.checker.isTupleType(t as any))
    return inAny(host.typeArguments(t));
  const handle = host.typeSymbol(t)?.declarations[0];
  if (
    handle &&
    host.isDefaultLibraryPath(handle.path) &&
    !((t as any).objectFlags & ObjectFlags.Mapped)
  )
    return undefined;
  if (host.callSignatures(t).length > 0) return undefined;
  const apparent = host.checker.getApparentType(t as any) as any;
  return inAny([
    ...host.checker
      .getPropertiesOfType(apparent)
      .map(p => host.typeOfSymbol(p)),
    ...[IndexKind.String, IndexKind.Number]
      .map(k => host.checker.getIndexTypeOfType(apparent, k) as Type)
      .filter(Boolean),
  ]);
}

// Reports a Thread or a Scope that a call or `new` of the runtime's would send
// to another thread or share, which the runtime refuses: an argument to a
// `Sending` parameter, which a thread, a goroutine, a channel or a map takes,
// or share() freezes (partition's but for, which splits an array on its
// thread), or for an iterable, what its iteration gives (a map's or a set's
// entries);
// and the result of a function argument declared to return `Sending<T>` , a
// thread's, which moves to the thread that joins it, or a map's computed value.
export function checkStaysHere(c: Own, call: Node): void {
  const host = c.host;
  const resolved = host.signatureOf(call);
  const handle = resolved.declaration;
  if (!handle || !c.isRuntimePath(handle.path)) return;
  const decl = host.declarationOf(handle);
  if (
    !decl ||
    (decl.kind === K.FunctionDeclaration && decl.name?.text === 'partition')
  )
    return;
  const report = (node: Node, t: Type): boolean => {
    const found = findStaysHere(c, t, new Set());
    if (found)
      c.error(
        node,
        Messages.StaysHere,
        host.typeToString(found),
        staysWith[threadOrScope(c, found)]!,
      );
    return !!found;
  };
  const params = ((decl.parameters ?? []) as Node[]).filter(
    p => !isThisParameter(p),
  );
  const last = params[params.length - 1];
  // whether a signature takes the arguments of another's fixed parameters
  const takes = (signature: Signature, args: Signature): boolean => {
    const n = args.parameters.length - (args.hasRestParameter ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const arg = host.parameterTypeAt(args, i),
        to = host.parameterTypeAt(signature, i);
      if (arg && to && !host.checker.isTypeAssignableTo(arg as any, to as any))
        return false;
    }
    return true;
  };
  // an argument of type t at a position (Infinity: somewhere in the rest)
  const check = (pos: number, t: Type, node: Node): void => {
    const param =
      pos < params.length
        ? params[pos]
        : last?.dotDotDotToken
          ? last
          : undefined;
    if (!param) return;
    let sent = sendingOperand(c, param.type);
    // `...entry: Sending<[key: K, callback: ...]>` : its element there
    if (param === last && param.dotDotDotToken && sent?.kind === K.TupleType) {
      const element = (sent.elements as Node[])[pos - params.indexOf(param)];
      sent = element?.kind === K.NamedTupleMember ? element.type : element;
    }
    const declared = sent ?? param.type;
    if (returnsSending(c, declared)) {
      // what the runtime calls it with, as the call instantiates the
      // parameter: an overload that does not take it is not called
      const expected = Number.isFinite(pos)
        ? host.parameterTypeAt(resolved, pos)
        : undefined;
      const called =
        expected && host.callSignatures(expected).length === 1
          ? host.callSignatures(expected)[0]
          : undefined;
      for (const signature of host.callSignatures(t))
        if (
          (!called || takes(signature, called)) &&
          report(
            node,
            host.awaitedType(
              host.checker.getReturnTypeOfSignature(signature as any) as Type,
            ),
          )
        )
          return;
      return;
    }
    if (!sent) return;
    // an iterable's values are taken one by one (a map's or a set's entries):
    // not the iterable itself
    if (sent.kind === K.TypeReference && sent.typeName.text === 'Iterable') {
      for (const e of host.iteratedTypes(t)) if (report(node, e)) return;
      return;
    }
    report(node, t);
  };
  // a spread tuple's elements at their places; a spread array, which TypeScript
  // passes to a rest parameter, at the rest
  let pos = 0;
  for (const arg of (call.arguments ?? []) as Node[]) {
    if (arg.kind !== K.SpreadElement) {
      check(pos++, host.typeOf(arg), arg);
      continue;
    }
    const expr = arg.expression as Node;
    const t = host.typeOf(expr);
    if (!host.checker.isTupleType(t as any)) {
      for (const e of host.iteratedTypes(t)) check(Infinity, e, expr);
      pos = Infinity;
      continue;
    }
    const fixed = (host.typeTarget(t) as any).fixedLength as number;
    host
      .typeArguments(t)
      .forEach((e, k) => check(k < fixed ? pos + k : Infinity, e, expr));
    pos = fixed === host.typeArguments(t).length ? pos + fixed : Infinity;
  }
}

// The T of a parameter type `Sending<T>` , or of a union of it with null or
// undefined (a SharedMap's entries), as the runtime's declarations write a
// parameter that moves.
function sendingOperand(c: Own, t: Node | undefined): Node | undefined {
  const marked = (m: Node) =>
    getTypeMarker(c, m) === 'Sending'
      ? (m.typeArguments[0] as Node)
      : undefined;
  if (t?.kind === K.UnionType)
    for (const m of t.types as Node[]) {
      const operand = marked(m);
      if (operand) return operand;
    }
  return t && marked(t);
}

// Reports whether a parameter's type is a function's that returns
// `Sending<T>` or `Promise<Sending<T>>` (a thread's function, a map's
// callback): what it returns moves.
function returnsSending(c: Own, t: Node | undefined): boolean {
  if (t?.kind !== K.FunctionType) return false;
  const result = t.type as Node | undefined;
  if (getTypeMarker(c, result) === 'Sending') return true;
  return (
    result?.kind === K.TypeReference &&
    result.typeName.kind === K.Identifier &&
    result.typeName.text === 'Promise' &&
    getTypeMarker(c, result.typeArguments?.[0]) === 'Sending'
  );
}

// The `struct(...)` calls of the program's source files, by the type of their
// structs' values (StructType<T>'s T).
export function getStructRegistry(c: Own): Map<Type, Node> {
  if (c.structs) return c.structs;
  const structs = new Map<Type, Node>();
  c.structs = structs;
  for (const file of c.files) {
    const visit = (node: Node): boolean => {
      if (
        node.kind === K.CallExpression &&
        getCallMarker(c, node) === 'struct'
      ) {
        const t = getStructTypeOfCall(c, node);
        if (t) structs.set(t, node);
      }
      return forEachChild(node, visit);
    };
    forEachChild(file as Node, visit);
  }
  return structs;
}

// The type of the values of the struct a `struct(...)` call declares: T in
// StructType<T>.
function getStructTypeOfCall(c: Own, call: Node): Type | undefined {
  const t = c.host.typeOf(call);
  if (
    !t ||
    !(t.flags & TypeFlags.Object) ||
    !((t as any).objectFlags & ObjectFlags.Reference)
  )
    return undefined;
  return c.host.typeArguments(t)[0];
}

// The layout of the struct a `struct(...)` call declares: its fields in the
// order of the object literal, and their kinds by their types (see
// getFieldKind).
export function getStructOfCall(c: Own, call: Node): StructInfo | undefined {
  if (c.structCalls.has(call)) return c.structCalls.get(call);
  let info: StructInfo | undefined;
  const t = getStructTypeOfCall(c, call);
  if (
    t &&
    call.arguments.length >= 1 &&
    skipParentheses(call.arguments[0]).kind === K.ObjectLiteralExpression
  ) {
    info = {decl: call, name: 'Struct', fields: [], kinds: [], types: []};
    // before its fields: a field may refer to the struct itself
    c.structCalls.set(call, info);
    const parent = walkUpParenthesizedExpressions(call.parent as Node);
    if (
      parent &&
      parent.kind === K.VariableDeclaration &&
      parent.name.kind === K.Identifier
    )
      info.name = parent.name.text;
    for (const property of skipParentheses(call.arguments[0])
      .properties as Node[]) {
      const name = property.name as Node | undefined;
      if (
        !name ||
        !(
          property.kind === K.PropertyAssignment ||
          property.kind === K.ShorthandPropertyAssignment
        ) ||
        !isPropertyNameLiteral(name)
      ) {
        continue; // reported by checkStructCall
      }
      const field = name.text as string;
      const symbol = c.host.checker.getPropertyOfType(t, field);
      const type = symbol && c.host.typeOfSymbol(symbol);
      info.fields.push(field);
      info.types.push(type);
      // the kind its marker gives it, which the runtime lays out: the type's
      // field may be a number for an i32 marker
      info.kinds.push(
        markerKind(
          c,
          property.kind === K.PropertyAssignment ? property.initializer : name,
        ).kind ?? (type ? getFieldKind(c, type) : 'f'),
      );
    }
  }
  c.structCalls.set(call, info);
  return info;
}

// A struct's fields with their markers, for a message.
const markerNames: Record<FieldKind, string> = {
  'f': 'f64',
  'i': 'i32',
  'u': 'u8',
  'b': 'bool',
  's': 'str',
  'r': 'ref',
  'c': 'ref',
  '': '?',
};
// The type of a number field of each kind.
const numberTypeNames: Partial<Record<FieldKind, string>> = {
  f: 'number',
  i: 'i32',
  u: 'u8',
};
const laidOut = (s: StructInfo) =>
  s.fields.map((f, k) => `${f}: ${markerNames[s.kinds[k]!]}`).join(', ');

// The runtime's markers of a value's kind, by the names it exports them by.
const scalarMarkers: Record<string, FieldKind> = {
  f64: 'f',
  i32: 'i',
  u8: 'u',
  bool: 'b',
  str: 's',
};

// The runtime's marker of a value's kind an expression is, by the name it
// exports it by, or "" when the checker cannot tell (see runtimeExportOf).
function scalarMarkerOf(c: Own, expr: Node): string {
  const name = runtimeExportOf(c, expr);
  return name in scalarMarkers ? name : '';
}

// The kind of a field's marker (f64, i32, u8, bool, str, ref<T>()), and
// whether it is known: by the runtime's marker it is, where the checker can
// follow it there, else by its type: an IntegerField's literal `kind` , which
// the runtime lays an integer out by, or what its Field<T> holds, T. A
// number's Field<T> alone does not tell: TypeScript takes an i32 or a u8 for
// an f64, and one for the other.
function markerKind(
  c: Own,
  marker: Node,
): {kind: FieldKind | undefined; known: boolean} {
  const scalar = scalarMarkerOf(c, marker);
  if (scalar !== '') return {kind: scalarMarkers[scalar], known: true};
  const host = c.host;
  const properties = host.checker.getPropertiesOfType(
    host.checker.getApparentType(host.typeOf(marker) as any) as any,
  );
  const kind = properties.find(
    p =>
      p.name === 'kind' &&
      !!p.valueDeclaration &&
      c.isRuntimePath(p.valueDeclaration.path),
  );
  const literal = kind && (host.typeOfSymbol(kind) as any).value;
  if (literal === 'i32') return {kind: 'i', known: true};
  if (literal === 'u8') return {kind: 'u', known: true};
  const brand = properties.find(p => p.name.startsWith('__@fieldBrand@'));
  if (!brand) return {kind: undefined, known: true};
  const held = getFieldKind(c, host.typeOfSymbol(brand));
  return {kind: held, known: !(held in numberTypeNames)};
}

// Checks a `struct(...)` call: its fields are given in an object literal, by
// name, and each is a number, a boolean, a string or a reference (a shared
// struct or a SharedArray, possibly null), a number marked as its type says.
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
    if (
      !name ||
      !(
        property.kind === K.PropertyAssignment ||
        property.kind === K.ShorthandPropertyAssignment
      ) ||
      !isPropertyNameLiteral(name) ||
      name.kind === K.NumericLiteral
    ) {
      c.error(property, Messages.StructField);
      continue;
    }
    const symbol = c.host.checker.getPropertyOfType(t, name.text);
    if (!symbol) continue;
    const type = c.host.typeOfSymbol(symbol);
    if (!isFieldType(c, type)) {
      c.error(property, Messages.StructField);
      continue;
    }
    // a number's marker lays it out as an f64, an i32 or a u8, which its type
    // must say too: TypeScript takes one for another, and what is stored into
    // an integer is checked by the type
    const {kind: marked, known} = markerKind(
      c,
      property.kind === K.PropertyAssignment ? property.initializer : name,
    );
    const typed = getFieldKind(c, type);
    if (!known && typed in numberTypeNames)
      c.error(property, Messages.UnknownMarker, name.text);
    else if (
      marked !== undefined &&
      marked !== typed &&
      marked in numberTypeNames &&
      typed in numberTypeNames
    )
      c.error(
        property,
        Messages.MarkerMismatch,
        name.text,
        markerNames[marked],
        c.host.typeToString(type),
        numberTypeNames[marked]!,
        markerNames[typed],
      );
  }
  // another struct(...) for the same type: the registry keeps one, by which
  // every value of the type is read; one laid out otherwise is refused
  const registered = getStructRegistry(c).get(t);
  if (registered !== undefined && registered !== call) {
    const mine = getStructOfCall(c, call),
      theirs = getStructOfCall(c, registered);
    if (
      mine &&
      theirs &&
      (mine.fields.length !== theirs.fields.length ||
        mine.fields.some(
          (f, k) => f !== theirs.fields[k] || mine.kinds[k] !== theirs.kinds[k],
        ))
    )
      c.error(
        call,
        Messages.StructRedeclared,
        c.host.typeToString(t),
        `[${laidOut(mine)}] here, [${laidOut(theirs)}] at its other declaration`,
      );
  }
}
