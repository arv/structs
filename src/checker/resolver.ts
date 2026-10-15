// What the emit asks of the analysis (the fork's EmitResolver, as
// checker/emitresolver.go answers it): the layout of an expression, its box,
// unbox or null conversion, and how reference counting treats it: how a value
// is counted where it flows (owned, a stable or an unstable borrow), how a
// variable holds one, what a closure captures, which loops reach a quiescent
// point, which arguments and results carry a count, and which element accesses
// need no bounds check (ownrefcount.go and ownlayout.go). refcount.ts decides
// only whether a value is counted at all, for its errors; this is the rest.

import {CellKind, Conversion} from './context.ts';
import type {CellType, Own} from './context.ts';
import {SymbolFlags, TypeFlags} from './host.ts';
import type {TsSymbol} from './host.ts';
import {
  getAssignmentTargetType,
  getCellType,
  getConversion,
  getSharedArrayElementType,
  isCellType,
  isNarrowedReference,
  nonNullishMembers,
} from './layout.ts';
import {
  getAtomicOperation,
  getCallMarker,
  getStructOfCall,
  isConsumeCall,
} from './markers.ts';
import {Analyzer, ReturnKind} from './ownership.ts';
import {
  getCaptureInfo,
  declaringFunction,
  isAmbientHandle,
  isChannelReceiveLoop,
  referencedVariable,
} from './refcount.ts';
import {
  FunctionFlags,
  forEachChild,
  getCombinedNodeFlags,
  getContainingFunction,
  getFunctionFlags,
  isAssignmentTarget,
  isClassLike,
  isExpression,
  isFunctionLike,
  isFunctionLikeDeclaration,
  isOptionalChain,
  isOwnValueExpression,
  isTypeNode,
  isWithin,
  K,
  NodeFlags,
  skipParentheses,
} from './syntax.ts';
import type {Node} from './syntax.ts';

// How a raw address is counted (printer.OwnCount).
export const Count = {
  None: 0, // not a raw address: not counted
  Null: 1, // null or undefined: 0, which needs no count
  Stable: 2, // a stable borrow: a parameter, a local, an element of one
  OwnedLocal: 3, // a stable borrow of an owned local, which a return moves out
  Unstable: 4, // an unstable borrow: valid until the next quiescent point
  Owned: 5, // +1: `new`, a call that returns a counted value
} as const;
export type Count = (typeof Count)[keyof typeof Count];

// How a variable or parameter holds a counted value (printer.OwnLocal).
export const Local = {
  None: 0, // not counted
  Borrowed: 1, // a borrow: no counting
  Owned: 2, // holds a count, released when its block (or function) ends
  OwnedMoved: 3, // owned, and a return moves its count out (`let`, then)
  Module: 4, // a module's variable: holds a count, never released
} as const;
export type Local = (typeof Local)[keyof typeof Local];

// An atomic operation of the plain API: the `Atomics` function, and the i32
// field it acts on (-1: an element of a SharedArray<i32>).
export interface AtomicCall {
  op: string;
  field: number;
}

// A `struct({...})` call: the struct's name and layout.
export interface StructCall {
  name: string;
  layout: CellType;
}

const noCell: CellType = {kind: CellKind.None, fields: [], kinds: []};

export class Resolver {
  readonly c: Own;
  private readonly a: Analyzer;
  private readonly counts = new Map<Node, Count>();
  private readonly locals = new Map<number, Local>();
  private readonly assigned = new Map<number, boolean>();
  private readonly quiescent = new Map<Node, boolean>();

  constructor(c: Own) {
    this.c = c;
    this.a = new Analyzer(c);
  }

  // getOwnCellTypeOfExpression: the layout of an expression's type.
  cellType(expr: Node | undefined): CellType {
    if (!expr || !isExpression(expr)) return noCell;
    return getCellType(this.c, this.c.host.typeOf(expr));
  }

  conversion(expr: Node): Conversion {
    return getConversion(this.c, expr);
  }

  isCellExpression(expr: Node | undefined): boolean {
    return (
      !!expr &&
      isExpression(expr) &&
      isCellType(this.c, this.c.host.typeOf(expr))
    );
  }

  // getOwnCount: how the value of an expression is counted where it flows,
  // after its conversion.
  count(expr: Node | undefined): Count {
    if (!expr || !isOwnValueExpression(expr)) return Count.None;
    switch (this.conversion(expr)) {
      case Conversion.Unbox:
        return Count.Stable; // `__unbox(E)`
      case Conversion.Box:
        return Count.None; // a handle, which holds its own count
      case Conversion.Zero:
        return Count.Null;
    }
    return this.rawCount(expr);
  }

  // getOwnRawCount: the same before the conversion.
  rawCount(expr: Node | undefined): Count {
    if (!expr || !isOwnValueExpression(expr)) return Count.None;
    const cached = this.counts.get(expr);
    if (cached !== undefined) return cached;
    this.counts.set(expr, Count.Unstable); // provisional
    const count = this.computeRawCount(expr);
    this.counts.set(expr, count);
    return count;
  }

  private computeRawCount(expr: Node): Count {
    const c = this.c;
    if (expr.kind === K.ParenthesizedExpression)
      return this.count(expr.expression);
    const t = c.host.typeOf(expr);
    if (!isCellType(c, t)) {
      return t.flags & TypeFlags.Nullable &&
        nonNullishMembers(c, t).length === 0
        ? Count.Null
        : Count.None;
    }
    if (isNarrowedReference(c, expr)) return Count.None; // a handle
    switch (expr.kind) {
      case K.Identifier: {
        const symbol = referencedVariable(c, expr);
        if (symbol && this.isOwnedLocalReference(expr, symbol))
          return Count.OwnedLocal;
        return Count.Stable;
      }
      case K.NewExpression:
        return Count.Owned;
      case K.CallExpression:
        if (isConsumeCall(c, expr)) {
          const inner = this.count(expr.arguments[0]);
          return inner !== Count.None ? inner : Count.Unstable;
        }
        return this.isCountedCall(expr) ? Count.Owned : Count.Unstable;
      case K.ElementAccessExpression: {
        const object = expr.expression as Node;
        if (this.cellType(object).kind === CellKind.ArrayOfStruct) {
          // an element lives as long as its array
          const count = this.count(object);
          if (count === Count.Stable || count === Count.OwnedLocal)
            return Count.Stable;
        }
        return Count.Unstable;
      }
      case K.AsExpression:
      case K.SatisfiesExpression:
      case K.NonNullExpression:
      case K.TypeAssertionExpression: {
        const inner = this.count(expr.expression);
        return inner !== Count.None ? inner : Count.Unstable;
      }
      case K.AwaitExpression:
        if (this.isCountedAwait(expr)) return Count.Owned;
        break;
      case K.ConditionalExpression:
        return joinCounts(
          this.count(expr.whenTrue),
          this.count(expr.whenFalse),
        );
      case K.BinaryExpression:
        switch (expr.operatorToken.kind) {
          case K.BarBarToken:
          case K.QuestionQuestionToken:
            return joinCounts(this.count(expr.left), this.count(expr.right));
          case K.AmpersandAmpersandToken:
            return joinCounts(Count.Null, this.count(expr.right));
          case K.CommaToken:
            return this.count(expr.right);
          case K.EqualsToken:
          case K.BarBarEqualsToken:
          case K.QuestionQuestionEqualsToken:
          case K.AmpersandAmpersandEqualsToken:
            if (!isCellType(c, getAssignmentTargetType(c, expr.left)))
              return Count.None; // the value was boxed for its target
            if (skipParentheses(expr.left).kind === K.Identifier)
              return Count.Stable; // the variable's value
        }
    }
    return Count.Unstable;
  }

  // The declaration of the signature a call resolves to, unless it has none
  // (an unknown or `any` signature).
  private signatureDeclaration(call: Node) {
    const signature = this.c.host.signatureOf(call);
    if (
      !signature ||
      !signature.declaration ||
      this.c.host.checker.isUnknownSignature(signature)
    )
      return undefined;
    return signature;
  }

  // isOwnCountedCall: a call returns +1 when its signature's own return type
  // is counted and it is declared in a source file; a runtime function's when
  // it hands over ownership (`Sending<T>`).
  private isCountedCall(call: Node): boolean {
    const c = this.c;
    let signature = this.signatureDeclaration(call);
    if (!signature) return false;
    if (isAmbientHandle(c, signature.declaration)) {
      const decl = c.host.declarationOf(signature.declaration);
      return (
        !!decl &&
        isFunctionLike(decl) &&
        this.a.returnKind(decl) === ReturnKind.Sending
      );
    }
    for (
      let target = signature.getTarget();
      target;
      target = target.getTarget()
    )
      signature = target;
    return isCellType(c, c.host.checker.getReturnTypeOfSignature(signature));
  }

  // isOwnCountedAwait: `await E` is +1 when E calls a runtime function whose
  // result is `Promise<Sending<T>>`, or a function compiled here whose promise
  // resolves to a counted value.
  private isCountedAwait(expr: Node): boolean {
    const c = this.c;
    const call = skipParentheses(expr.expression);
    if (call.kind !== K.CallExpression) return false;
    let signature = this.signatureDeclaration(call);
    if (!signature) return false;
    const decl = c.host.declarationOf(signature.declaration);
    if (!decl || !isFunctionLike(decl)) return false;
    if (isAmbientHandle(c, signature.declaration)) {
      const t = this.a.resolveTypeNode(decl.type);
      if (
        !t ||
        t.kind !== K.TypeReference ||
        t.typeArguments?.length !== 1 ||
        t.typeName.kind !== K.Identifier ||
        t.typeName.text !== 'Promise'
      )
        return false;
      const promised = this.a.resolveTypeNode(t.typeArguments[0]);
      return (
        this.a.isSendingTypeNode(promised) ||
        (promised?.kind === K.UnionType &&
          (promised.types as Node[]).some(m => this.a.isSendingTypeNode(m)))
      );
    }
    for (
      let target = signature.getTarget();
      target;
      target = target.getTarget()
    )
      signature = target;
    return isCellType(
      c,
      c.host.awaitedType(c.host.checker.getReturnTypeOfSignature(signature)),
    );
  }

  // isOwnHoldable: a borrowed value stays valid as long as a local initialized
  // from it: it is not read through a variable that may be reassigned.
  private isHoldable(expr: Node): boolean {
    const c = this.c;
    expr = skipParentheses(expr);
    switch (this.conversion(expr)) {
      case Conversion.Unbox: {
        // the handle stays alive until the thread's next task, unless the
        // function is suspended
        const fn = getContainingFunction(expr);
        return (
          !fn ||
          (getFunctionFlags(fn) &
            (FunctionFlags.Async | FunctionFlags.Generator)) ===
            0
        );
      }
      case Conversion.Zero:
        return true;
      case Conversion.Box:
        return false;
    }
    const t = c.host.typeOf(expr);
    if (t.flags & TypeFlags.Nullable && nonNullishMembers(c, t).length === 0)
      return true;
    switch (expr.kind) {
      case K.Identifier: {
        const symbol = referencedVariable(c, expr);
        return !!symbol && !this.isAssigned(symbol);
      }
      case K.AsExpression:
      case K.SatisfiesExpression:
      case K.NonNullExpression:
      case K.TypeAssertionExpression:
        return this.isHoldable(expr.expression);
      case K.CallExpression:
        return isConsumeCall(c, expr) && this.isHoldable(expr.arguments[0]);
      case K.ElementAccessExpression:
        return (
          this.cellType(expr.expression).kind === CellKind.ArrayOfStruct &&
          this.isHoldable(expr.expression)
        );
      case K.ConditionalExpression:
        return (
          this.isHoldable(expr.whenTrue) && this.isHoldable(expr.whenFalse)
        );
      case K.BinaryExpression:
        switch (expr.operatorToken.kind) {
          case K.BarBarToken:
          case K.QuestionQuestionToken:
            return this.isHoldable(expr.left) && this.isHoldable(expr.right);
          case K.AmpersandAmpersandToken:
          case K.CommaToken:
            return this.isHoldable(expr.right);
        }
    }
    return false;
  }

  // getOwnLocal: how a variable or parameter (or the one an identifier refers
  // to) holds a counted value.
  local(decl: Node | undefined): Local {
    const c = this.c;
    if (!decl) return Local.None;
    if (decl.kind === K.Identifier) {
      const symbol = referencedVariable(c, decl);
      if (!symbol) return Local.None;
      decl = c.host.valueDeclaration(symbol);
      if (!decl) return Local.None;
    }
    if (
      (decl.kind !== K.VariableDeclaration && decl.kind !== K.Parameter) ||
      decl.name?.kind !== K.Identifier
    )
      return Local.None;
    const symbol = c.host.symbolOfDeclaration(decl);
    if (!symbol) return Local.None;
    const id = c.host.symbolId(symbol);
    const cached = this.locals.get(id);
    if (cached !== undefined) return cached;
    this.locals.set(id, Local.Owned); // provisional
    const local = this.computeLocal(decl, symbol);
    this.locals.set(id, local);
    return local;
  }

  private computeLocal(decl: Node, symbol: TsSymbol): Local {
    const c = this.c;
    if (!isCellType(c, c.host.typeOfSymbol(symbol))) return Local.None;
    if (decl.kind === K.Parameter) {
      const fn = decl.parent as Node | undefined;
      if (
        !fn ||
        !isFunctionLikeDeclaration(fn) ||
        !fn.body ||
        decl.dotDotDotToken
      )
        return Local.Borrowed;
      if (
        (decl.initializer && !this.isBorrowable(decl.initializer)) ||
        this.isAssigned(symbol) ||
        getFunctionFlags(fn) & (FunctionFlags.Async | FunctionFlags.Generator)
      )
        return this.ownedLocal(decl, symbol);
      return Local.Borrowed;
    }
    const list = decl.parent as Node | undefined;
    if (!list || list.kind !== K.VariableDeclarationList) return Local.None;
    const statement = list.parent as Node;
    if (
      statement.kind === K.ForInStatement ||
      statement.kind === K.ForOfStatement
    ) {
      if (isChannelReceiveLoop(c, statement))
        return this.ownedLocal(decl, symbol); // owns each received value
      return Local.Borrowed; // an error (checkRefCounts)
    }
    if (
      statement.kind === K.VariableStatement &&
      (statement.parent?.kind === K.SourceFile ||
        statement.parent?.kind === K.ModuleBlock)
    )
      return Local.Module;
    if (!this.isAssigned(symbol)) {
      if (!decl.initializer || this.isBorrowable(decl.initializer))
        return Local.Borrowed; // (always 0 without an initializer)
    }
    return this.ownedLocal(decl, symbol);
  }

  // isOwnBorrowable: a local (or a parameter's default value) can borrow null,
  // or a stable borrow that stays valid as long as the local.
  private isBorrowable(init: Node): boolean {
    switch (this.count(init)) {
      case Count.Null:
        return true;
      case Count.Stable:
      case Count.OwnedLocal:
        return this.isHoldable(init);
    }
    return false;
  }

  // An owned local, which a return moves out (rather than retaining it) if no
  // closure captures it.
  private ownedLocal(decl: Node, symbol: TsSymbol): Local {
    const fn = declaringFunction(decl);
    if (
      fn?.body &&
      !this.isCaptured(symbol) &&
      this.isReturnedLocal(fn.body, symbol)
    )
      return Local.OwnedMoved;
    return Local.Owned;
  }

  // Reports whether a return statement of a function (not of the functions in
  // it) returns a variable itself as its raw value.
  private isReturnedLocal(body: Node, symbol: TsSymbol): boolean {
    const c = this.c;
    const returns = (expr: Node | undefined): boolean => {
      if (!expr || this.conversion(expr) !== Conversion.None) return false;
      switch (expr.kind) {
        case K.Identifier:
          return referencedVariable(c, expr) === symbol;
        case K.ParenthesizedExpression:
        case K.AsExpression:
        case K.SatisfiesExpression:
        case K.NonNullExpression:
        case K.TypeAssertionExpression:
          return returns(expr.expression);
        case K.CallExpression:
          return isConsumeCall(c, expr) && returns(expr.arguments[0]);
        case K.ConditionalExpression:
          return returns(expr.whenTrue) || returns(expr.whenFalse);
        case K.BinaryExpression:
          switch (expr.operatorToken.kind) {
            case K.BarBarToken:
            case K.QuestionQuestionToken:
              return returns(expr.left) || returns(expr.right);
            case K.AmpersandAmpersandToken:
            case K.CommaToken:
              return returns(expr.right);
          }
      }
      return false;
    };
    // a concise body is an expression, not a return statement
    const visit = (node: Node): boolean => {
      if (isTypeNode(node) || isFunctionLike(node) || isClassLike(node))
        return false;
      if (node.kind === K.ReturnStatement && returns(node.expression))
        return true;
      return forEachChild(node, visit);
    };
    return forEachChild(body, visit);
  }

  // isOwnOwnedLocalReference: an identifier refers to an owned local (or
  // owned parameter) of the function it is in, which a return can move out.
  private isOwnedLocalReference(id: Node, symbol: TsSymbol): boolean {
    const decl = this.c.host.valueDeclaration(symbol);
    if (!decl) return false;
    const local = this.local(decl);
    if (local !== Local.Owned && local !== Local.OwnedMoved) return false;
    return (
      declaringFunction(decl) === getContainingFunction(id) &&
      !this.isCaptured(symbol)
    );
  }

  // isOwnAssigned: a variable or parameter is assigned anywhere (nested
  // functions included), other than by its declaration.
  isAssigned(symbol: TsSymbol): boolean {
    const c = this.c;
    const decl = c.host.valueDeclaration(symbol);
    if (
      !decl ||
      (decl.kind === K.VariableDeclaration &&
        getCombinedNodeFlags(decl) & NodeFlags.Constant)
    )
      return false;
    const id = c.host.symbolId(symbol);
    const cached = this.assigned.get(id);
    if (cached !== undefined) return cached;
    let scope: Node | undefined = decl.parent as Node | undefined;
    while (scope && !isFunctionLike(scope) && scope.kind !== K.SourceFile)
      scope = scope.parent as Node | undefined;
    const assigned = !!scope && this.isAssignedIn(scope, symbol);
    this.assigned.set(id, assigned);
    return assigned;
  }

  // Reports whether code assigns the variable an identifier refers to.
  assignsIn(node: Node, id: Node): boolean {
    const symbol = this.c.host.resolvedSymbol(id);
    return !!symbol && this.isAssignedIn(node, symbol);
  }

  // isOwnAssignedIn: a symbol is assigned (or updated) anywhere within node,
  // nested functions included.
  private isAssignedIn(node: Node | undefined, symbol: TsSymbol): boolean {
    if (!node) return false;
    const visit = (n: Node): boolean => {
      if (isTypeNode(n)) return false;
      if (n.kind === K.Identifier)
        return (
          isAssignmentTarget(n) && this.c.host.resolvedSymbol(n) === symbol
        );
      return forEachChild(n, visit);
    };
    return node.kind === K.Identifier ? visit(node) : forEachChild(node, visit);
  }

  // isOwnCaptured: a function other than the one that declares a counted
  // variable refers to it.
  private isCaptured(symbol: TsSymbol): boolean {
    const decl = this.c.host.valueDeclaration(symbol);
    if (!decl) return false;
    return getCaptureInfo(this.c, decl.getSourceFile()).captured.has(symbol);
  }

  // getOwnCaptures: the declarations of the counted locals of other functions
  // that a function refers to, in the order of their first reference.
  captures(fn: Node): Node[] {
    return getCaptureInfo(this.c, fn.getSourceFile()).captures.get(fn) ?? [];
  }

  // isOwnQuiescentLoop: a loop reads or stores a reference field (in its
  // condition, update or body, outside the functions in it), so each
  // iteration ends at a quiescent point.
  isQuiescentLoop(loop: Node): boolean {
    const cached = this.quiescent.get(loop);
    if (cached !== undefined) return cached;
    let parts: (Node | undefined)[] = [];
    switch (loop.kind) {
      case K.ForStatement:
        parts = [loop.condition, loop.incrementor, loop.statement];
        break;
      case K.ForInStatement:
      case K.ForOfStatement:
        parts = [loop.statement];
        break;
      case K.WhileStatement:
      case K.DoStatement:
        parts = [loop.expression, loop.statement];
        break;
    }
    const visit = (node: Node): boolean => {
      if (isTypeNode(node) || isFunctionLike(node) || isClassLike(node))
        return false;
      if (
        node.kind === K.PropertyAccessExpression &&
        this.isReferenceField(node)
      )
        return true;
      return forEachChild(node, visit);
    };
    const found = parts.some(part => !!part && visit(part));
    this.quiescent.set(loop, found);
    return found;
  }

  // A property access reads or writes a reference field of a shared struct.
  isReferenceField(access: Node): boolean {
    const cell = this.cellType(access.expression);
    if (cell.kind !== CellKind.Struct) return false;
    return cell.kinds[cell.fields.indexOf(access.name.text)] === 'r';
  }

  // isOwnRefArgument: an argument is a counted value that the callee takes a
  // count of (`__countedRef(E)`): a `Sending<T>` parameter of a runtime
  // function, other than a share-like one's.
  isRefArgument(arg: Node): boolean {
    const c = this.c;
    const call = arg.parent as Node | undefined;
    if (
      !call ||
      (call.kind !== K.CallExpression && call.kind !== K.NewExpression) ||
      arg.kind === K.SpreadElement
    )
      return false;
    const index = (call.arguments as Node[] | undefined)?.indexOf(arg) ?? -1;
    if (
      index < 0 ||
      !this.isCellExpression(arg) ||
      this.conversion(arg) === Conversion.Box
    )
      return false;
    const signature = this.signatureDeclaration(call);
    if (!signature || !isAmbientHandle(c, signature.declaration)) return false;
    const decl = c.host.declarationOf(signature.declaration);
    if (!decl) return false;
    const param = parameterAt(signatureParameters(decl), index);
    return (
      !!param &&
      this.a.isSendingTypeNode(param.type) &&
      !this.a.isConsumingSignature(decl)
    );
  }

  // isOwnMovedReturn: a returned expression is a counted value that moves into
  // the runtime (`__moved(E)`): the result of a function that a runtime
  // function type with a `Sending<T>` result types.
  isMovedReturn(expr: Node | undefined): boolean {
    const c = this.c;
    if (
      !expr ||
      !this.isCellExpression(expr) ||
      this.conversion(expr) === Conversion.Box
    )
      return false;
    const parent = expr.parent as Node | undefined;
    let fn: Node | undefined;
    if (!parent) return false;
    if (parent.kind === K.ReturnStatement) fn = getContainingFunction(parent);
    else if (parent.kind === K.ArrowFunction && parent.body === expr)
      fn = parent;
    if (
      !fn ||
      (fn.kind !== K.ArrowFunction && fn.kind !== K.FunctionExpression)
    )
      return false;
    const signature = c.host.contextualSignature(fn);
    if (!signature?.declaration || !isAmbientHandle(c, signature.declaration))
      return false;
    const decl = c.host.declarationOf(signature.declaration);
    return !!decl && this.a.isSendingTypeNode(decl.type);
  }

  // GetOwnStructCall: the struct a `struct({...})` call declares.
  structCall(call: Node): StructCall | undefined {
    if (call.kind !== K.CallExpression) return undefined;
    if (getCallMarker(this.c, call) !== 'struct') return undefined;
    const info = getStructOfCall(this.c, call);
    if (!info) return undefined;
    return {
      name: info.name,
      layout: {kind: CellKind.Struct, fields: info.fields, kinds: info.kinds},
    };
  }

  // GetOwnAtomicCall: the atomic operation a call is, if it is a valid one
  // (as markers.ts finds them: `atomic.add(...)`, `threads.atomic["add"](...)`
  // and the like).
  atomicCall(call: Node): AtomicCall | undefined {
    if (call.kind !== K.CallExpression) return undefined;
    const op = getAtomicOperation(this.c, call);
    if (op === '') return undefined;
    const args = call.arguments as Node[];
    if (args.length < 2) return undefined;
    const cell = this.cellType(args[0]);
    if (cell.kind === CellKind.ArrayOfI32) return {op, field: -1};
    if (cell.kind === CellKind.Struct) {
      const key = skipParentheses(args[1]!);
      if (
        key.kind === K.StringLiteral ||
        key.kind === K.NoSubstitutionTemplateLiteral
      ) {
        const k = cell.fields.indexOf(key.text);
        if (cell.kinds[k] === 'i') return {op, field: k};
      }
    }
    return undefined;
  }

  isConsumeCall(call: Node): boolean {
    return isConsumeCall(this.c, call);
  }

  // isOwnElementAccessInBounds: the emit may access the element of `A[I]`
  // without a bounds check (see "Bounds-check elimination" in the fork's
  // checker/ownlayout.go): A and I identifiers, A a SharedArray that is never
  // assigned, inside the body of `for (let I = <n>; I < A.length; I++)` that
  // assigns I nowhere else.
  isElementAccessInBounds(access: Node): boolean {
    const c = this.c;
    if (access.kind !== K.ElementAccessExpression || isOptionalChain(access))
      return false;
    const array = skipParentheses(access.expression);
    const index = skipParentheses(access.argumentExpression);
    if (array.kind !== K.Identifier || index.kind !== K.Identifier)
      return false;
    const arraySymbol = c.host.resolvedSymbol(array);
    const indexSymbol = c.host.resolvedSymbol(index);
    if (!arraySymbol || !indexSymbol || !this.isUnassignedVariable(arraySymbol))
      return false;
    if (!getSharedArrayElementType(c, c.host.typeOfSymbol(arraySymbol)))
      return false;
    for (
      let node = access.parent as Node | undefined;
      node;
      node = node.parent
    ) {
      if (
        isFunctionLike(node) ||
        node.kind === K.ClassStaticBlockDeclaration ||
        node.kind === K.SourceFile
      )
        return false;
      if (
        node.kind === K.ForStatement &&
        isWithin(access, node.statement) &&
        this.isCountingLoop(node, indexSymbol, arraySymbol)
      )
        return true;
    }
    return false;
  }

  // A `const`, or a parameter or `let` variable that is never assigned
  // (isParameterOrMutableLocalVariable && !isSymbolAssigned).
  private isUnassignedVariable(symbol: TsSymbol): boolean {
    const c = this.c;
    if (symbol.flags & SymbolFlags.Alias) return false;
    const decl = c.host.valueDeclaration(symbol);
    if (!decl) return false;
    if (decl.kind === K.VariableDeclaration) {
      const flags = getCombinedNodeFlags(decl);
      if (flags & NodeFlags.Constant) return true;
      const list = decl.parent as Node;
      if (!(list.flags & NodeFlags.Let)) return false;
      const statement = list.parent as Node | undefined;
      if (statement?.kind === K.VariableStatement) {
        if (statement.modifiers?.some((m: Node) => m.kind === K.ExportKeyword))
          return false;
        const file = statement.parent as Node | undefined;
        if (file?.kind === K.SourceFile && !isModuleFile(file)) return false; // a script's global
      }
    } else if (decl.kind !== K.Parameter) return false;
    return !this.isAssignedAnywhere(symbol);
  }

  // The checker's isSymbolAssigned: an assignment anywhere in the scope that
  // declares it (the parameter's function, the variable's function or file).
  private isAssignedAnywhere(symbol: TsSymbol): boolean {
    const decl = this.c.host.valueDeclaration(symbol)!;
    let scope: Node | undefined = decl.parent as Node | undefined;
    while (scope && !isFunctionLike(scope) && scope.kind !== K.SourceFile)
      scope = scope.parent as Node | undefined;
    return this.isAssignedIn(scope, symbol);
  }

  // `for (let I = <init>; I < <bound>; <update>)` as described above.
  private isCountingLoop(
    loop: Node,
    indexSymbol: TsSymbol,
    arraySymbol: TsSymbol,
  ): boolean {
    const c = this.c;
    const init = loop.initializer as Node | undefined;
    if (
      !init ||
      init.kind !== K.VariableDeclarationList ||
      !(init.flags & NodeFlags.Let)
    )
      return false;
    let declaration: Node | undefined;
    for (const decl of init.declarations as Node[]) {
      if (
        decl.name.kind === K.Identifier &&
        c.host.symbolOfDeclaration(decl) === indexSymbol
      )
        declaration = decl;
    }
    if (
      !declaration?.initializer ||
      !this.isNonNegativeIntegerLiteral(declaration.initializer)
    )
      return false;
    if (!loop.condition || !loop.incrementor) return false;
    const condition = skipParentheses(loop.condition);
    if (
      condition.kind !== K.BinaryExpression ||
      condition.operatorToken.kind !== K.LessThanToken ||
      !this.isReferenceTo(condition.left, indexSymbol) ||
      !this.isLengthOf(condition.right, arraySymbol)
    )
      return false;
    const update = skipParentheses(loop.incrementor);
    switch (update.kind) {
      case K.PrefixUnaryExpression:
      case K.PostfixUnaryExpression:
        if (
          update.operator !== K.PlusPlusToken ||
          !this.isReferenceTo(update.operand, indexSymbol)
        )
          return false;
        break;
      case K.BinaryExpression: {
        const right = skipParentheses(update.right);
        if (
          update.operatorToken.kind !== K.PlusEqualsToken ||
          !this.isReferenceTo(update.left, indexSymbol) ||
          right.kind !== K.NumericLiteral ||
          right.text !== '1'
        )
          return false;
        break;
      }
      default:
        return false;
    }
    // no other writes to I in the head or the body
    return (
      !this.isAssignedIn(loop.initializer, indexSymbol) &&
      !this.isAssignedIn(loop.condition, indexSymbol) &&
      !this.isAssignedIn(loop.statement, indexSymbol)
    );
  }

  private isReferenceTo(expr: Node, symbol: TsSymbol): boolean {
    expr = skipParentheses(expr);
    return (
      expr.kind === K.Identifier && this.c.host.resolvedSymbol(expr) === symbol
    );
  }

  // `A.length`, or an identifier declared `const n = A.length`.
  private isLengthOf(expr: Node, arraySymbol: TsSymbol): boolean {
    const c = this.c;
    expr = skipParentheses(expr);
    if (expr.kind === K.Identifier) {
      const symbol = c.host.resolvedSymbol(expr);
      const decl = symbol && c.host.valueDeclaration(symbol);
      if (
        !decl ||
        decl.kind !== K.VariableDeclaration ||
        !(getCombinedNodeFlags(decl) & NodeFlags.Constant) ||
        !decl.initializer
      )
        return false;
      expr = skipParentheses(decl.initializer);
    }
    return (
      expr.kind === K.PropertyAccessExpression &&
      expr.name.text === 'length' &&
      this.isReferenceTo(expr.expression, arraySymbol)
    );
  }

  // A non-negative integer literal type below 2^31: a literal, or a `const`
  // initialized with one.
  private isNonNegativeIntegerLiteral(expr: Node): boolean {
    const t = this.c.host.typeOf(expr);
    if (!(t.flags & TypeFlags.NumberLiteral)) return false;
    const value = (t as any).value as number;
    return (
      typeof value === 'number' &&
      value >= 0 &&
      value < 2 ** 31 &&
      Number.isInteger(value)
    );
  }
}

// The count of a value that is one of two (ownJoinCounts): owned if either is,
// else an unstable borrow if either is (or is not counted), else stable, else
// null.
function joinCounts(a: Count, b: Count): Count {
  const rank = (count: Count): number => {
    switch (count) {
      case Count.Null:
        return 0;
      case Count.Stable:
      case Count.OwnedLocal:
        return 1;
      case Count.Owned:
        return 3;
    }
    return 2;
  };
  switch (Math.max(rank(a), rank(b))) {
    case 0:
      return Count.Null;
    case 1:
      return Count.Stable;
    case 3:
      return Count.Owned;
  }
  return Count.Unstable;
}

// The parameters of a signature declaration, without a `this` parameter.
function signatureParameters(decl: Node): Node[] {
  if (!isFunctionLike(decl)) return [];
  const params = (decl.parameters ?? []) as Node[];
  return params.length > 0 &&
    params[0]!.name?.kind === K.Identifier &&
    params[0]!.name.text === 'this'
    ? params.slice(1)
    : [...params];
}

function parameterAt(params: Node[], index: number): Node | undefined {
  if (index < 0 || params.length === 0) return undefined;
  if (index < params.length) return params[index];
  const last = params[params.length - 1]!;
  return last.dotDotDotToken ? last : undefined;
}

// Reports whether a file is a module (has an import or an export), rather than
// a script whose top-level declarations are globals.
export function isModuleFile(file: Node): boolean {
  return (file.statements as Node[]).some(
    s =>
      s.kind === K.ImportDeclaration ||
      s.kind === K.ImportEqualsDeclaration ||
      s.kind === K.ExportDeclaration ||
      s.kind === K.ExportAssignment ||
      !!s.modifiers?.some((m: Node) => m.kind === K.ExportKeyword),
  );
}
