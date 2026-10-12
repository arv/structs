// Ownership (region) analysis (ownership.go).
//
// The analysis is intraprocedural and flow-sensitive, in the style of Swift's region-based isolation
// (SE-0414). Every value an expression evaluates to is either SHARED (it has no region: primitives,
// values declared `Shared<T>`, cells, code) or lives in a REGION, a set of objects that may reference
// each other. Regions are the classes of a union-find. A region can be SENT (handed to another owner
// through a `Sending<T>` parameter, `share(...)` and the like); using a variable whose region was sent
// is an error. CALLER regions (ordinary parameters and `this`) and OUTER regions (variables captured
// from an enclosing scope) can never be sent.
//
// Counted values (shared structs and SharedArrays) live in COUNTED regions of their own, which never
// merge with ordinary ones: `new`, a call and a received value give a fresh one; only a `Sending`
// parameter that is not a rest parameter moves one (a channel's `send`).
//
// The approximations are those of the fork, which this follows rule for rule; see ownership.go.

import type { Own } from "./context.ts";
import { SymbolFlags, TypeFlags } from "./host.ts";
import type { NodeHandle, Signature, TsSymbol, Type } from "./host.ts";
import { getSharedArrayElementType, isCellType } from "./layout.ts";
import { getTypeMarker, isCellBranded, isConsumeCall } from "./markers.ts";
import { Messages } from "./messages.ts";
import type { Message } from "./messages.ts";
import { getChannelElementType } from "./refcount.ts";
import {
  forEachChild, getCombinedNodeFlags, isAssignmentOperator, isBindingPattern, isClassLike, isExpression,
  isFunctionExpressionOrArrowFunction, isFunctionLike, isObjectLiteralMethod, isOwnValueReference, isThisParameter, isTypeNode,
  isWithin, K, NodeFlags, OEK, skipOuterExpressions, skipParentheses, walkUpParenthesizedExpressions,
} from "./syntax.ts";
import type { Node } from "./syntax.ts";
import type { SourceFile } from "typescript/ast";

const maxLoopIterations = 4;

type Region = number;

const ValueKind = { Shared: 0, InRegion: 1, Consumed: 2 } as const;
type ValueKind = (typeof ValueKind)[keyof typeof ValueKind];

interface Value {
  readonly kind: ValueKind;
  readonly region: Region;
  readonly consumed?: Send; // for Consumed
  readonly maybe: boolean; // for Consumed: consumed on some paths only
}

const sharedValue: Value = { kind: ValueKind.Shared, region: 0, maybe: false };

function regionValue(r: Region): Value {
  return { kind: ValueKind.InRegion, region: r, maybe: false };
}

const RegionFlags = { Caller: 1, Outer: 2, Counted: 4 } as const;

// A send (or consume) of a region.
interface Send {
  readonly site: Node; // the sent expression
  readonly callee: string; // what it was sent to
  readonly via: string; // the variable (or expression) through which it was sent
  readonly consume: boolean; // consumed rather than sent
}

interface RegionInfo {
  readonly flags: number;
  readonly sent: Send | undefined;
  readonly maybe: boolean; // sent on some paths only
}

const noInfo: RegionInfo = { flags: 0, sent: undefined, maybe: false };

// The abstract state at a program point. Region infos are immutable, so copies share them.
class State {
  unreachable = false;
  vars = new Map<TsSymbol, Value>();
  parent = new Map<Region, Region>(); // union-find links (absent for roots)
  info = new Map<Region, RegionInfo>(); // by root

  static unreachable(): State {
    const s = new State();
    s.unreachable = true;
    return s;
  }

  copy(): State {
    const r = new State();
    r.unreachable = this.unreachable;
    r.vars = new Map(this.vars);
    r.parent = new Map(this.parent);
    r.info = new Map(this.info);
    return r;
  }

  assign(other: State): void {
    this.unreachable = other.unreachable;
    this.vars = other.vars;
    this.parent = other.parent;
    this.info = other.info;
  }

  find(r: Region): Region {
    for (;;) {
      const p = this.parent.get(r);
      if (p === undefined) return r;
      r = p;
    }
  }

  infoOf(r: Region): RegionInfo {
    return this.info.get(r) ?? noInfo;
  }

  root(v: Value): [Region, RegionInfo] {
    const r = this.find(v.region);
    return [r, this.infoOf(r)];
  }

  addFlags(r: Region, flags: number): void {
    r = this.find(r);
    const inf = this.infoOf(r);
    this.info.set(r, { ...inf, flags: inf.flags | flags });
  }

  addSend(r: Region, send: Send, maybe: boolean): void {
    r = this.find(r);
    const inf = this.infoOf(r);
    if (!inf.sent || inf.maybe && !maybe) {
      this.info.set(r, { ...inf, sent: send, maybe });
    } else {
      this.info.set(r, inf);
    }
  }

  union(a: Region, b: Region): Region {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    const ia = this.infoOf(ra);
    const ib = this.infoOf(rb);
    if ((ia.flags ^ ib.flags) & RegionFlags.Counted) {
      // A counted value and an ordinary one never alias: keep them apart (the ordinary one stands for
      // the pair, so that sending it still sends the ordinary objects).
      return ia.flags & RegionFlags.Counted ? rb : ra;
    }
    this.parent.set(rb, ra);
    this.info.delete(rb);
    let merged: RegionInfo = { ...ia, flags: ia.flags | ib.flags };
    if (ib.sent && (!merged.sent || merged.maybe && !ib.maybe)) {
      merged = { ...merged, sent: ib.sent, maybe: ib.maybe };
    }
    this.info.set(ra, merged);
    return ra;
  }

  isSentDefinitely(r: Region): boolean {
    const inf = this.infoOf(this.find(r));
    return !!inf.sent && !inf.maybe;
  }

  isCounted(v: Value): boolean {
    if (v.kind !== ValueKind.InRegion) return false;
    return (this.root(v)[1].flags & RegionFlags.Counted) !== 0;
  }

  // Merges two values into one: the union of their regions.
  mergeValues(a: Value, b: Value): Value {
    if (a.kind === ValueKind.InRegion && b.kind === ValueKind.InRegion) return regionValue(this.union(a.region, b.region));
    if (a.kind === ValueKind.InRegion) return a;
    if (b.kind === ValueKind.InRegion) return b;
    return sharedValue;
  }

  joinValues(a: Value, b: Value): Value {
    if (a.kind === ValueKind.Consumed && b.kind === ValueKind.Consumed) {
      return { kind: ValueKind.Consumed, region: 0, consumed: a.consumed, maybe: a.maybe || b.maybe };
    }
    if (a.kind === ValueKind.Consumed) return { kind: ValueKind.Consumed, region: 0, consumed: a.consumed, maybe: true };
    if (b.kind === ValueKind.Consumed) return { kind: ValueKind.Consumed, region: 0, consumed: b.consumed, maybe: true };
    return this.mergeValues(a, b);
  }

  // A canonical description of the state, used to detect that a loop has reached a fixpoint.
  signature(idOf: (symbol: TsSymbol) => number): string {
    if (this.unreachable) return "unreachable";
    const symbols = [...this.vars.keys()].sort((a, b) => idOf(a) - idOf(b));
    const roots = new Map<Region, number>();
    let out = "";
    for (const symbol of symbols) {
      const v = this.vars.get(symbol)!;
      out += idOf(symbol);
      switch (v.kind) {
        case ValueKind.Shared:
          out += "=s;";
          break;
        case ValueKind.Consumed:
          out += v.maybe ? "=c?;" : "=c;";
          break;
        case ValueKind.InRegion: {
          const [r, inf] = this.root(v);
          let index = roots.get(r);
          if (index === undefined) {
            index = roots.size;
            roots.set(r, index);
          }
          out += `=r${index}f${inf.flags}${inf.sent ? (inf.maybe ? "s?" : "s") : ""};`;
        }
      }
    }
    return out;
  }
}

// Joins the states of two paths. Equivalences, flags and sends of both are kept; a region sent on
// only one of the paths is "maybe sent".
function joinStates(a: State, b: State): State {
  if (a.unreachable) return b.copy();
  if (b.unreachable) return a.copy();
  const r = new State();
  for (const [k, v] of a.parent) r.parent.set(k, v);
  for (const [k, v] of b.parent) r.union(k, v);
  for (const [k, inf] of a.info) r.addFlags(k, inf.flags);
  for (const [k, inf] of b.info) r.addFlags(k, inf.flags);
  for (const [k, inf] of a.info) {
    if (inf.sent) r.addSend(k, inf.sent, inf.maybe || !b.isSentDefinitely(k));
  }
  for (const [k, inf] of b.info) {
    if (inf.sent) r.addSend(k, inf.sent, inf.maybe || !a.isSentDefinitely(k));
  }
  for (const [symbol, va] of a.vars) {
    const vb = b.vars.get(symbol);
    r.vars.set(symbol, vb === undefined ? va : r.joinValues(va, vb));
  }
  for (const [symbol, vb] of b.vars) {
    if (!a.vars.has(symbol)) r.vars.set(symbol, vb);
  }
  return r;
}

function joinAllStates(first: State, rest: State[]): State {
  let result = first;
  for (const s of rest) result = joinStates(result, s);
  return result;
}

// Entry point

// Runs the ownership analysis on the top-level statements and every function body of a file.
export function checkOwnership(c: Own, file: SourceFile): void {
  const a = new Analyzer(c);
  a.analyzeFunction(file as Node);
  const visit = (node: Node): boolean => {
    if (isTypeNode(node)) return false;
    if (isFunctionBody(node)) a.analyzeFunction(node);
    forEachChild(node, visit);
    return false;
  };
  forEachChild(file as Node, visit);
}

// Function-like declarations whose body the analysis visits.
function isFunctionBody(node: Node): boolean {
  switch (node.kind) {
    case K.FunctionDeclaration: case K.FunctionExpression: case K.ArrowFunction: case K.MethodDeclaration:
    case K.Constructor: case K.GetAccessor: case K.SetAccessor:
      return !!node.body;
    case K.ClassStaticBlockDeclaration:
      return true;
  }
  return false;
}

const ReportKind = { Use: 0, Send: 1, Return: 2, Write: 3 } as const;

interface FunctionResult {
  returnsFresh: boolean; // every returned value is shared or in a region not linked to the caller or outer scopes
}

interface Captures {
  symbols: TsSymbol[];
  nodes: Node[]; // first reference of each symbol
  usesThis: boolean; // an arrow function (or a closure nested in one) uses the enclosing `this`
}

const ReturnKind = { Ordinary: 0, Sending: 1, Shared: 2 } as const;
type ReturnKind = (typeof ReturnKind)[keyof typeof ReturnKind];

interface Target {
  labels: string[];
  isLoop: boolean;
  isSwitch: boolean;
  breaks: State[];
  continues: State[];
}

const arrayMutators = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

class Analyzer {
  readonly c: Own;
  nextRegion = 0;
  readonly results = new Map<Node, FunctionResult>();
  readonly reported = new Map<Node, Set<number>>();
  readonly shared = new Map<TsSymbol, boolean>();
  readonly captures = new Map<Node, Captures>();
  readonly loopFresh = new Map<Node, Set<TsSymbol>>();
  readonly primitiveOrShared = new Map<Type, boolean>();
  readonly idOf: (symbol: TsSymbol) => number;

  constructor(c: Own) {
    this.c = c;
    this.idOf = (symbol) => c.host.symbolId(symbol);
  }

  newRegion(): Region {
    return ++this.nextRegion;
  }

  // A fresh region, counted if `counted`.
  newRegionOf(counted: boolean, s: State): Region {
    const r = this.newRegion();
    if (counted) s.addFlags(r, RegionFlags.Counted);
    return r;
  }

  // Reports whether values of a type are counted addresses in the shared heap.
  isCountedType(t: Type | undefined): boolean {
    return isCellType(this.c, t);
  }

  typeOf(node: Node): Type {
    return this.c.host.typeOf(node);
  }

  analyzeFunction(node: Node): FunctionResult {
    const existing = this.results.get(node);
    if (existing) return existing;
    const r: FunctionResult = { returnsFresh: true };
    this.results.set(node, r);
    const f = new FunctionAnalysis(this, node, r);
    const s = new State();
    let body: Node | undefined;
    if (node.kind === K.SourceFile) {
      f.statements(node.statements, s);
      return r;
    } else if (node.kind === K.ClassStaticBlockDeclaration) {
      body = node.body;
    } else {
      body = node.body;
      f.returnsSending = this.returnsSending(node);
      for (const p of node.parameters as Node[]) {
        if (isThisParameter(p)) continue;
        f.bindName(p.name, p, f.parameterValue(p, s), s);
      }
    }
    if (node.kind !== K.ArrowFunction) {
      f.thisRegion = this.newRegion();
      f.thisFlags = RegionFlags.Caller;
      s.addFlags(f.thisRegion, f.thisFlags);
    }
    if (!body) return r;
    if (body.kind === K.Block) {
      f.statements(body.statements, s);
    } else {
      const v = f.eval(body, s);
      f.checkReturn(body, v, s);
    }
    return r;
  }

  // Reporting

  report(node: Node, kind: number, at: Node, message: Message, ...args: (string | number)[]): boolean {
    let kinds = this.reported.get(node);
    if (!kinds) {
      kinds = new Set();
      this.reported.set(node, kinds);
    }
    if (kinds.has(kind)) return false;
    kinds.add(kind);
    this.c.error(at, message, ...args);
    return true;
  }

  reportUseAfterSend(node: Node, name: string, send: Send, maybe: boolean): void {
    const line = lineOf(send.site);
    if (send.consume && send.via === name) {
      this.report(node, ReportKind.Use, node, maybe ? Messages.MaybeConsumed : Messages.Consumed, name, send.callee, line);
    } else if (send.via === name) {
      this.report(node, ReportKind.Use, node, maybe ? Messages.MaybeUsedAfterSend : Messages.UsedAfterSend, name, send.callee, line);
    } else {
      this.report(node, ReportKind.Use, node, maybe ? Messages.SharesWithMaybeSent : Messages.SharesWithSent, name, send.via, send.callee, line);
    }
  }

  // Symbols, declarations and type nodes

  // Resolves an identifier in an expression.
  symbolOfIdentifier(id: Node): TsSymbol | undefined {
    return this.c.host.resolvedSymbol(id);
  }

  // A declaration node, unless it is in a default library file: those never use the markers, so
  // every question about their type nodes has the answer of a missing one.
  declarationOutsideLibrary(handle: NodeHandle | undefined): Node | undefined {
    if (!handle || this.c.host.isDefaultLibraryPath(handle.path)) return undefined;
    return this.c.host.declarationOf(handle);
  }

  // Reports whether a symbol is declared in the function (or file, for top-level code) `owner`.
  isLocalTo(symbol: TsSymbol, owner: Node): boolean {
    if (symbol.flags & SymbolFlags.Alias) return false;
    const handle = symbol.valueDeclaration ?? symbol.declarations[0];
    if (!handle || handle.path !== owner.getSourceFile().path) return false;
    const decl = this.c.host.declarationOf(handle);
    return !!decl && ownerOf(decl) === owner;
  }

  // Binds a value to a variable, making it shared if the variable is declared shared (or is a
  // primitive).
  normalize(symbol: TsSymbol, v: Value): Value {
    return v.kind === ValueKind.InRegion && this.isSharedSymbol(symbol) ? sharedValue : v;
  }

  // Reports whether a symbol's value is shared regardless of the program point: code, library values,
  // cells, variables declared `Shared<T>` and variables of primitive types.
  isSharedSymbol(symbol: TsSymbol): boolean {
    const cached = this.shared.get(symbol);
    if (cached !== undefined) return cached;
    this.shared.set(symbol, false); // breaks cycles
    const result = this.computeIsSharedSymbol(symbol);
    this.shared.set(symbol, result);
    return result;
  }

  computeIsSharedSymbol(symbol: TsSymbol): boolean {
    const host = this.c.host;
    let target: TsSymbol | undefined = symbol;
    if (symbol.flags & SymbolFlags.Alias) {
      target = host.resolveAlias(symbol);
      if (!target) return true;
    }
    if (target.flags & (SymbolFlags.Function | SymbolFlags.Class | SymbolFlags.Enum | SymbolFlags.ValueModule | SymbolFlags.Method) &&
      !(target.flags & SymbolFlags.Variable)) {
      return true;
    }
    if (target.declarations.length === 0) return false;
    if (target.declarations.every((d) => host.isDefaultLibraryPath(d.path))) return true;
    if (this.isDeclaredShared(target)) return true;
    const t = host.typeOfSymbol(target);
    if (this.isCountedType(t)) return false; // tracked in a counted region
    return this.isPrimitiveOrSharedStructType(t);
  }

  // Reports whether a variable, parameter or property is declared with a `Shared<T>` type, or is a
  // `const` initialized with a shared value.
  isDeclaredShared(symbol: TsSymbol): boolean {
    const handle = symbol.valueDeclaration;
    if (!handle) return false;
    switch (handle.kind) {
      case K.Parameter: case K.PropertySignature: case K.PropertyDeclaration: case K.VariableDeclaration:
        break;
      default:
        return false;
    }
    const decl = this.declarationOutsideLibrary(handle);
    if (!decl) return false;
    switch (decl.kind) {
      case K.Parameter:
        return this.isSharedTypeNode(this.parameterTypeNode(decl));
      case K.PropertySignature: case K.PropertyDeclaration:
        return this.isSharedTypeNode(decl.type);
      case K.VariableDeclaration:
        if (decl.type) return this.isSharedTypeNode(decl.type);
        if (decl.initializer && getCombinedNodeFlags(decl) & NodeFlags.Const) return this.isStaticallyShared(decl.initializer);
    }
    return false;
  }

  // Reports whether an expression's value is shared on every path, using declarations only.
  isStaticallyShared(expr: Node): boolean {
    expr = skipOuterExpressions(expr, OEK.All);
    switch (expr.kind) {
      case K.NumericLiteral: case K.BigIntLiteral: case K.StringLiteral: case K.NoSubstitutionTemplateLiteral:
      case K.TemplateExpression: case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword:
        return true;
      case K.Identifier: {
        const symbol = this.symbolOfIdentifier(expr);
        return !!symbol && this.isSharedSymbol(symbol);
      }
      case K.PropertyAccessExpression: {
        if (this.isStaticallyShared(expr.expression)) return true;
        const prop = this.c.host.symbolAt(expr.name);
        return !!prop && this.isDeclaredShared(prop);
      }
      case K.CallExpression: case K.NewExpression:
        return this.returnKind(this.signatureDeclarationOf(expr)) === ReturnKind.Shared;
    }
    return false;
  }

  // The declaration of the signature a call or `new` resolves to (outside the default library).
  signatureDeclarationOf(call: Node): Node | undefined {
    return this.declarationOutsideLibrary(this.c.host.signatureOf(call).declaration);
  }

  // Reports whether the elements of an array-typed expression are declared shared, as in
  // `xs: Shared<T>[]`.
  isElementDeclaredShared(expr: Node): boolean {
    const t = this.resolveTypeNode(this.declaredTypeNodeOf(expr));
    if (!t) return false;
    switch (t.kind) {
      case K.ArrayType:
        return this.isSharedTypeNode(t.elementType);
      case K.TypeReference: {
        const args = t.typeArguments as Node[] | undefined;
        if (args?.length === 1) {
          const name = t.typeName as Node;
          if (name.kind === K.Identifier && (name.text === "Array" || name.text === "ReadonlyArray")) return this.isSharedTypeNode(args[0]);
        }
      }
    }
    return false;
  }

  // The type node an expression was declared with, if it has one.
  declaredTypeNodeOf(expr: Node): Node | undefined {
    expr = skipOuterExpressions(expr, OEK.All);
    const host = this.c.host;
    switch (expr.kind) {
      case K.Identifier: {
        const symbol = this.symbolOfIdentifier(expr);
        const decl = symbol && this.declarationOutsideLibrary(symbol.valueDeclaration);
        if (!decl) return undefined;
        switch (decl.kind) {
          case K.Parameter:
            return this.parameterTypeNode(decl);
          case K.VariableDeclaration: case K.PropertyDeclaration: case K.PropertySignature:
            return decl.type;
        }
        return undefined;
      }
      case K.PropertyAccessExpression: {
        const prop = host.symbolAt(expr.name);
        const handle = prop?.valueDeclaration;
        if (handle && (handle.kind === K.PropertyDeclaration || handle.kind === K.PropertySignature)) {
          return this.declarationOutsideLibrary(handle)?.type;
        }
        return undefined;
      }
      case K.CallExpression: case K.NewExpression: {
        const decl = this.signatureDeclarationOf(expr);
        return decl && isFunctionLike(decl) ? decl.type : undefined;
      }
      case K.ElementAccessExpression: {
        const t = this.resolveTypeNode(this.declaredTypeNodeOf(expr.expression));
        return t?.kind === K.ArrayType ? t.elementType : undefined;
      }
    }
    return undefined;
  }

  // The element value of iterating over a value.
  elementValue(iterable: Node, v: Value): Value {
    return v.kind !== ValueKind.InRegion || this.isElementDeclaredShared(iterable) ? sharedValue : v;
  }

  // Skips parentheses and `readonly`, and follows type aliases (a few levels deep).
  resolveTypeNode(t: Node | undefined): Node | undefined {
    for (let i = 0; i < 5; i++) {
      if (!t) return undefined;
      while (t.kind === K.ParenthesizedType || t.kind === K.TypeOperator && t.operator === K.ReadonlyKeyword) t = t.type as Node;
      if (t.kind !== K.TypeReference || getTypeMarker(this.c, t) !== "") {
        return t; // `Sending<T>` and `Shared<T>` are aliases of T: keep the marker
      }
      const symbol = this.c.host.symbolAt(t.typeName);
      if (!symbol || !(symbol.flags & SymbolFlags.TypeAlias)) return t;
      const handle = symbol.declarations.find((d) => d.kind === K.TypeAliasDeclaration);
      // The default library's aliases (Record, Readonly...) never lead to a marker: stop there.
      if (!handle || this.c.host.isDefaultLibraryPath(handle.path)) return t;
      const decl = this.c.host.declarationOf(handle);
      if (!decl) return t;
      t = decl.type as Node;
    }
    return t;
  }

  // `Shared<T>`, possibly behind parentheses, `readonly` or an alias, or a union of such types with
  // null and undefined.
  isSharedTypeNode(t: Node | undefined): boolean {
    t = this.resolveTypeNode(t);
    if (!t) return false;
    switch (t.kind) {
      case K.TypeReference:
        return getTypeMarker(this.c, t) === "Shared";
      case K.UnionType: {
        let sawShared = false;
        for (const member of t.types as Node[]) {
          const m = this.resolveTypeNode(member)!;
          if (m.kind === K.UndefinedKeyword || m.kind === K.NullKeyword || m.kind === K.LiteralType && m.literal.kind === K.NullKeyword) {
            continue;
          }
          if (this.isSharedTypeNode(m)) {
            sawShared = true;
          } else {
            return false;
          }
        }
        return sawShared;
      }
    }
    return false;
  }

  isSendingTypeNode(t: Node | undefined): boolean {
    t = this.resolveTypeNode(t);
    return !!t && getTypeMarker(this.c, t) === "Sending";
  }

  // The T of `Sending<T>` or `Shared<T>`.
  markedTypeOperand(t: Node | undefined): Node | undefined {
    t = this.resolveTypeNode(t);
    if (t?.kind === K.TypeReference && t.typeArguments?.length === 1) return t.typeArguments[0];
    return undefined;
  }

  // The declared type of a parameter, or the type of the corresponding parameter of the contextual
  // signature for an unannotated parameter of a function expression.
  parameterTypeNode(p: Node): Node | undefined {
    if (p.type) return p.type;
    const fn = p.parent as Node | undefined;
    if (!fn || !(isFunctionExpressionOrArrowFunction(fn) || isObjectLiteralMethod(fn))) return undefined;
    const signature = this.c.host.contextualSignature(fn);
    if (!signature) return undefined;
    const index = signatureParameters(fn).lastIndexOf(p);
    return parameterAt(signatureParameters(this.declarationOutsideLibrary(signature.declaration)), index)?.type;
  }

  returnKind(decl: Node | undefined): ReturnKind {
    if (!decl || !isFunctionLike(decl)) return ReturnKind.Ordinary;
    const t = this.unwrapPromiseTypeNode(decl.type as Node | undefined);
    if (!t) return ReturnKind.Ordinary;
    if (this.isSendingTypeNode(t)) return ReturnKind.Sending;
    const resolved = this.resolveTypeNode(t);
    if (resolved?.kind === K.UnionType && (resolved.types as Node[]).some((m) => this.isSendingTypeNode(m))) {
      // `Sending<T> | undefined`, as a channel's `recv()` returns.
      return ReturnKind.Sending;
    }
    if (this.isSharedTypeNode(t)) return ReturnKind.Shared;
    return ReturnKind.Ordinary;
  }

  // The X of a result type `Promise<X>`, which an async function's returns resolve; any other type
  // itself. A result `Promise<Sending<T>>` hands over ownership as `Sending<T>` does (`recvAsync()`,
  // `joinAsync()`).
  unwrapPromiseTypeNode(t: Node | undefined): Node | undefined {
    const r = this.resolveTypeNode(t);
    if (r?.kind === K.TypeReference && r.typeArguments?.length === 1 && r.typeName.kind === K.Identifier && r.typeName.text === "Promise") {
      return r.typeArguments[0];
    }
    return t;
  }

  returnsSending(fn: Node): boolean {
    if (fn.type) return this.isSendingTypeNode(this.unwrapPromiseTypeNode(fn.type));
    if (isFunctionExpressionOrArrowFunction(fn) || isObjectLiteralMethod(fn)) {
      const signature: Signature | undefined = this.c.host.contextualSignature(fn);
      if (signature) return this.returnKind(this.declarationOutsideLibrary(signature.declaration)) === ReturnKind.Sending;
    }
    return false;
  }

  // A share-like signature `<T>(x: Sending<T>) => Shared<T>` turns its argument into a shared value;
  // the argument is then reported as consumed rather than sent.
  isConsumingSignature(decl: Node | undefined): boolean {
    if (!decl || this.returnKind(decl) !== ReturnKind.Shared) return false;
    const result = typeParameterName(decl, this.markedTypeOperand(decl.type));
    if (result === "") return false;
    for (const p of signatureParameters(decl)) {
      if (p.type && this.isSendingTypeNode(p.type) && typeParameterName(decl, this.markedTypeOperand(p.type)) === result) return true;
    }
    return false;
  }

  // Reports whether a signature is Array.prototype.map or flatMap (or the ReadonlyArray versions) from
  // the default library.
  isLibArrayMethod(handle: NodeHandle | undefined): boolean {
    if (!handle || !this.c.host.isDefaultLibraryPath(handle.path)) return false;
    const decl = this.c.host.declarationOf(handle);
    const parent = decl?.parent as Node | undefined;
    if (!parent || parent.kind !== K.InterfaceDeclaration) return false;
    return parent.name.text === "Array" || parent.name.text === "ReadonlyArray";
  }

  isArrayExpression(expr: Node): boolean {
    const t = this.typeOf(expr);
    return this.c.host.checker.isArrayType(t) || this.c.host.checker.isTupleType(t);
  }

  // Reports whether an expression is a shared value in the sense of the extension, which is immutable:
  // it must be declared shared (a variable, parameter or member declared `Shared<T>`, a call returning
  // `Shared<T>`, or something read out of such a value).
  isImmutableShared(expr: Node): boolean {
    return !this.isPrimitiveOrSharedStructType(this.typeOf(expr)) && this.isDeclaredSharedExpression(expr);
  }

  isDeclaredSharedExpression(expr: Node): boolean {
    expr = skipOuterExpressions(expr, OEK.All);
    switch (expr.kind) {
      case K.Identifier: {
        let symbol = this.symbolOfIdentifier(expr);
        if (!symbol) return false;
        if (symbol.flags & SymbolFlags.Alias) symbol = this.c.host.resolveAlias(symbol);
        if (!symbol) return false;
        if (this.isDeclaredShared(symbol)) return true;
        // `for (const x of xs)` where xs is shared or has shared elements.
        const handle = symbol.valueDeclaration;
        if (handle?.kind === K.VariableDeclaration) {
          const decl = this.declarationOutsideLibrary(handle);
          const list = decl?.parent as Node | undefined;
          if (list?.kind === K.VariableDeclarationList && list.parent?.kind === K.ForOfStatement) {
            const iterable = (list.parent as Node).expression as Node;
            return this.isDeclaredSharedExpression(iterable) || this.isElementDeclaredShared(iterable);
          }
        }
        return false;
      }
      case K.PropertyAccessExpression: {
        if (this.isDeclaredSharedExpression(expr.expression)) return true;
        const prop = this.c.host.symbolAt(expr.name);
        return !!prop && this.isDeclaredShared(prop);
      }
      case K.ElementAccessExpression:
        return this.isDeclaredSharedExpression(expr.expression) || this.isElementDeclaredShared(expr.expression);
      case K.CallExpression: case K.NewExpression:
        return this.returnKind(this.signatureDeclarationOf(expr)) === ReturnKind.Shared;
    }
    return false;
  }

  isPrimitiveOrSharedStructType(t: Type | undefined): boolean {
    if (!t) return false;
    let result = this.primitiveOrShared.get(t);
    if (result !== undefined) return result;
    if (t.flags & TypeFlags.Union) {
      result = this.c.host.memberTypes(t).every((m) => this.isPrimitiveOrSharedStructType(m));
    } else {
      // SharedArrays are cells in the shared heap, like shared structs, and so is every Cell of the
      // plain API.
      result = !!(t.flags & (TypeFlags.Primitive | TypeFlags.Never)) || getSharedArrayElementType(this.c, t) !== undefined || isCellBranded(this.c, t);
    }
    this.primitiveOrShared.set(t, result);
    return result;
  }

  // Closure captures

  capturesOf(fn: Node): Captures {
    const existing = this.captures.get(fn);
    if (existing) return existing;
    const captures: Captures = { symbols: [], nodes: [], usesThis: false };
    this.captures.set(fn, captures);
    const seen = new Set<TsSymbol>();
    const path = fn.getSourceFile().path;
    const visit = (node: Node, inArrow: boolean): void => {
      if (isTypeNode(node)) return;
      if (node.kind === K.Identifier) {
        if (!isOwnValueReference(node)) return;
        const symbol = this.symbolOfIdentifier(node);
        if (!symbol || seen.has(symbol) || this.isSharedSymbol(symbol)) return;
        const handle = symbol.valueDeclaration ?? symbol.declarations[0];
        if (handle && (handle.path !== path || !isWithin(this.c.host.declarationOf(handle), fn))) {
          seen.add(symbol);
          captures.symbols.push(symbol);
          captures.nodes.push(node);
        }
        return;
      }
      if (node.kind === K.ThisKeyword || node.kind === K.SuperKeyword) {
        if (inArrow) captures.usesThis = true;
        return;
      }
      let childInArrow = inArrow;
      if (node !== fn && isFunctionBody(node)) childInArrow = inArrow && node.kind === K.ArrowFunction;
      forEachChild(node, (child) => {
        visit(child, childInArrow);
      });
    };
    forEachChild(fn, (child) => {
      visit(child, fn.kind === K.ArrowFunction);
    });
    return captures;
  }

  // The variables with a fresh binding in each iteration of a loop: those its body declares with `let`
  // or `const` (catch clause variables included), outside the functions and classes in it.
  loopBindings(loop: Node): Set<TsSymbol> {
    const existing = this.loopFresh.get(loop);
    if (existing) return existing;
    const bindings = new Set<TsSymbol>();
    const bindName = (name: Node | undefined, decl: Node): void => {
      if (!name) return;
      if (name.kind === K.Identifier) {
        const symbol = this.c.host.symbolOfDeclaration(decl);
        if (symbol) bindings.add(symbol);
      } else if (isBindingPattern(name)) {
        for (const element of name.elements as Node[]) {
          if (element.kind === K.BindingElement) bindName(element.name, element);
        }
      }
    };
    const visit = (node: Node): boolean => {
      if (isTypeNode(node) || isFunctionLike(node) || isClassLike(node)) return false;
      if (node.kind === K.VariableDeclaration) {
        const parent = node.parent as Node;
        if (parent.kind === K.CatchClause || parent.flags & NodeFlags.BlockScoped) bindName(node.name, node);
      }
      return forEachChild(node, visit);
    };
    if (loop.statement) visit(loop.statement);
    this.loopFresh.set(loop, bindings);
    return bindings;
  }
}

// The analysis of one function body (or of the top-level statements of a file).
class FunctionAnalysis {
  readonly a: Analyzer;
  readonly node: Node;
  readonly result: FunctionResult;
  returnsSending = false;
  thisRegion: Region = 0;
  thisFlags = 0;
  readonly targets: Target[] = [];
  readonly building = new Set<Node>(); // closures whose value is being computed

  constructor(a: Analyzer, node: Node, result: FunctionResult) {
    this.a = a;
    this.node = node;
    this.result = result;
  }

  parameterValue(p: Node, s: State): Value {
    const a = this.a;
    const symbol = a.c.host.symbolOfDeclaration(p);
    const counted = !!symbol && a.isCountedType(a.c.host.typeOfSymbol(symbol));
    const t = a.parameterTypeNode(p);
    if (t && a.isSendingTypeNode(t)) {
      // `Sending<T>`: the function owns the argument.
      return regionValue(a.newRegionOf(counted, s));
    }
    if (symbol && a.isSharedSymbol(symbol)) return sharedValue;
    const r = a.newRegionOf(counted, s);
    s.addFlags(r, RegionFlags.Caller);
    return regionValue(r);
  }

  thisValue(s: State): Value {
    if (this.thisRegion === 0) {
      if (this.node.kind === K.SourceFile) return sharedValue;
      // `this` in an arrow function is captured from the enclosing function.
      this.thisRegion = this.a.newRegion();
      this.thisFlags = RegionFlags.Outer;
    }
    // Re-apply the flags: the region may have been created on another path.
    s.addFlags(this.thisRegion, this.thisFlags);
    return regionValue(this.thisRegion);
  }

  // Statements

  statements(nodes: readonly Node[], s: State): void {
    for (const node of nodes) {
      if (s.unreachable) return;
      this.statement(node, s);
    }
  }

  statement(node: Node, s: State): void {
    switch (node.kind) {
      case K.Block:
        this.statements(node.statements, s);
        break;
      case K.VariableStatement:
        this.variableDeclarationList(node.declarationList, s);
        break;
      case K.ExpressionStatement:
        this.eval(node.expression, s);
        break;
      case K.IfStatement: {
        this.eval(node.expression, s);
        const thenState = s.copy();
        this.statement(node.thenStatement, thenState);
        if (node.elseStatement) this.statement(node.elseStatement, s);
        s.assign(joinStates(thenState, s));
        break;
      }
      case K.ReturnStatement:
        if (node.expression) {
          const v = this.eval(node.expression, s);
          this.checkReturn(node.expression, v, s);
        }
        s.unreachable = true;
        break;
      case K.ThrowStatement:
        this.eval(node.expression, s);
        s.unreachable = true;
        break;
      case K.WhileStatement: case K.DoStatement: case K.ForStatement: case K.ForInStatement: case K.ForOfStatement:
        this.loop(node, [], s);
        break;
      case K.LabeledStatement:
        this.labeledStatement(node, s);
        break;
      case K.BreakStatement: case K.ContinueStatement:
        this.jump(node, s);
        break;
      case K.SwitchStatement:
        this.switchStatement(node, s);
        break;
      case K.TryStatement:
        this.tryStatement(node, s);
        break;
      case K.ExportAssignment:
        this.eval(node.expression, s);
        break;
      case K.WithStatement:
        this.eval(node.expression, s);
        this.statement(node.statement, s);
        break;
    }
    // Function and class declarations are analyzed on their own; the closures they create are
    // accounted for where they are referenced. Type declarations, imports and the like have no effect.
  }

  variableDeclarationList(list: Node, s: State): void {
    for (const decl of list.declarations as Node[]) {
      let v = sharedValue;
      if (decl.initializer) v = this.eval(decl.initializer, s);
      this.bindName(decl.name, decl, v, s);
    }
  }

  // Binds the names declared by a variable, parameter or binding element. Every name in a binding
  // pattern is bound to the region of the destructured value.
  bindName(name: Node | undefined, decl: Node, v: Value, s: State): void {
    if (!name) return;
    if (name.kind === K.Identifier) {
      const symbol = this.a.c.host.symbolOfDeclaration(decl);
      if (symbol) s.vars.set(symbol, this.a.normalize(symbol, v));
      return;
    }
    if (isBindingPattern(name)) {
      for (const element of name.elements as Node[]) {
        if (element.kind !== K.BindingElement) continue;
        let ev = v;
        if (element.initializer) ev = s.mergeValues(ev, this.eval(element.initializer, s));
        this.bindName(element.name, element, ev, s);
      }
    }
  }

  labeledStatement(node: Node, s: State): void {
    const labels: string[] = [];
    while (node.kind === K.LabeledStatement) {
      labels.push(node.label.text);
      node = node.statement;
    }
    switch (node.kind) {
      case K.WhileStatement: case K.DoStatement: case K.ForStatement: case K.ForInStatement: case K.ForOfStatement:
        this.loop(node, labels, s);
        return;
    }
    const t: Target = { labels, isLoop: false, isSwitch: false, breaks: [], continues: [] };
    this.targets.push(t);
    this.statement(node, s);
    this.targets.pop();
    s.assign(joinAllStates(s, t.breaks));
  }

  jump(node: Node, s: State): void {
    const isBreak = node.kind === K.BreakStatement;
    const label: string = node.label ? node.label.text : "";
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i]!;
      if (label !== "") {
        if (!t.labels.includes(label)) continue;
      } else if (isBreak) {
        if (!t.isLoop && !t.isSwitch) continue;
      } else if (!t.isLoop) {
        continue;
      }
      if (isBreak) t.breaks.push(s.copy());
      else t.continues.push(s.copy());
      break;
    }
    s.unreachable = true;
  }

  // Loops are iterated until the state at the head stops changing, so that a send in one iteration is
  // seen by the uses in the next.
  loop(node: Node, labels: string[], s: State): void {
    const a = this.a;
    let iterated = sharedValue;
    let receives = false; // a for-of over a channel of counted values: each iteration receives a fresh one
    switch (node.kind) {
      case K.ForStatement:
        if (node.initializer) {
          if (node.initializer.kind === K.VariableDeclarationList) this.variableDeclarationList(node.initializer, s);
          else this.eval(node.initializer, s);
        }
        break;
      case K.ForOfStatement:
        iterated = a.elementValue(node.expression, this.eval(node.expression, s));
        receives = a.isCountedType(getChannelElementType(a.c, a.typeOf(node.expression)));
        break;
      case K.ForInStatement:
        this.eval(node.expression, s);
        iterated = sharedValue; // property names
        break;
    }
    // Each iteration has fresh bindings of the variables the loop's body declares with `let` or
    // `const`: what an earlier iteration did with them must not flow into the next one.
    const fresh = a.loopBindings(node);
    let head = s.copy();
    for (const symbol of fresh) head.vars.delete(symbol);
    let headSignature = head.signature(a.idOf);
    let exit: State = State.unreachable();
    let breaks: State[] = [];
    for (let iteration = 0; iteration < maxLoopIterations; iteration++) {
      let st = head.copy();
      const t: Target = { labels, isLoop: true, isSwitch: false, breaks: [], continues: [] };
      this.targets.push(t);
      switch (node.kind) {
        case K.WhileStatement:
          this.eval(node.expression, st);
          exit = st.copy();
          this.statement(node.statement, st);
          st = joinAllStates(st, t.continues);
          break;
        case K.DoStatement:
          this.statement(node.statement, st);
          st = joinAllStates(st, t.continues);
          this.eval(node.expression, st);
          exit = st.copy();
          break;
        case K.ForStatement:
          if (node.condition) {
            this.eval(node.condition, st);
            exit = st.copy();
          } else {
            exit = State.unreachable();
          }
          this.statement(node.statement, st);
          st = joinAllStates(st, t.continues);
          if (node.incrementor && !st.unreachable) this.eval(node.incrementor, st);
          break;
        case K.ForInStatement: case K.ForOfStatement: {
          exit = st.copy();
          const value = receives ? regionValue(a.newRegionOf(true, st)) : iterated;
          if (node.initializer.kind === K.VariableDeclarationList) {
            for (const decl of node.initializer.declarations as Node[]) this.bindName(decl.name, decl, value, st);
          } else {
            this.assign(node.initializer, value, st);
          }
          this.statement(node.statement, st);
          st = joinAllStates(st, t.continues);
          break;
        }
      }
      this.targets.pop();
      breaks = t.breaks;
      for (const symbol of fresh) st.vars.delete(symbol);
      const next = joinStates(head, st);
      const nextSignature = next.signature(a.idOf);
      head = next;
      if (nextSignature === headSignature) break;
      headSignature = nextSignature;
    }
    s.assign(joinAllStates(exit, breaks));
  }

  switchStatement(node: Node, s: State): void {
    this.eval(node.expression, s);
    const t: Target = { labels: [], isLoop: false, isSwitch: true, breaks: [], continues: [] };
    this.targets.push(t);
    const afterExpression = s.copy();
    let current = State.unreachable();
    let hasDefault = false;
    for (const clause of node.caseBlock.clauses as Node[]) {
      const entry = joinStates(afterExpression, current); // falls through from the previous clause
      if (clause.kind === K.CaseClause) this.eval(clause.expression, entry);
      else hasDefault = true;
      this.statements(clause.statements, entry);
      current = entry;
    }
    this.targets.pop();
    let result = joinAllStates(current, t.breaks);
    if (!hasDefault) result = joinStates(result, afterExpression);
    s.assign(result);
  }

  // try/catch/finally is analyzed conservatively: the catch and finally blocks start from the join of
  // the try block's entry and exit states.
  tryStatement(node: Node, s: State): void {
    const entry = s.copy();
    this.statement(node.tryBlock, s);
    let after = s;
    if (node.catchClause) {
      const catchClause = node.catchClause as Node;
      const cs = joinStates(entry, s);
      const decl = catchClause.variableDeclaration as Node | undefined;
      if (decl) {
        // Whatever was thrown may be referenced from anywhere.
        const r = this.a.newRegion();
        cs.addFlags(r, RegionFlags.Outer);
        this.bindName(decl.name, decl, regionValue(r), cs);
      }
      this.statement(catchClause.block, cs);
      after = joinStates(s, cs);
    }
    if (node.finallyBlock) {
      const fs = joinStates(entry, after);
      this.statement(node.finallyBlock, fs);
      if (after.unreachable) fs.unreachable = true;
      after = fs;
    }
    if (after !== s) s.assign(after);
  }

  checkReturn(expr: Node, v: Value, s: State): void {
    if (v.kind !== ValueKind.InRegion) return;
    const [, inf] = s.root(v);
    const borrowed = (inf.flags & (RegionFlags.Caller | RegionFlags.Outer)) !== 0;
    if (borrowed || inf.sent) this.result.returnsFresh = false;
    if (this.returnsSending && borrowed) {
      this.a.report(expr, ReportKind.Return, expr, Messages.ReturnSendingCallerReferenced, expressionName(expr));
    }
  }

  // Expressions

  eval(node: Node | undefined, s: State): Value {
    if (!node) return sharedValue;
    const a = this.a;
    switch (node.kind) {
      case K.Identifier:
        return this.readIdentifier(node, s);
      case K.ThisKeyword: case K.SuperKeyword:
        return this.thisValue(s);
      case K.NumericLiteral: case K.BigIntLiteral: case K.StringLiteral: case K.NoSubstitutionTemplateLiteral:
      case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword: case K.MetaProperty: case K.OmittedExpression:
      case K.PrivateIdentifier:
        return sharedValue;
      case K.RegularExpressionLiteral:
        return regionValue(a.newRegion());
      case K.ParenthesizedExpression: case K.NonNullExpression: case K.AsExpression: case K.SatisfiesExpression:
      case K.TypeAssertionExpression: case K.PartiallyEmittedExpression:
        return this.eval(node.expression, s);
      case K.AwaitExpression: {
        // What a promise resolves to is in the promise's region, unless it is a primitive.
        const v = this.eval(node.expression, s);
        return a.isPrimitiveOrSharedStructType(a.typeOf(node)) ? sharedValue : v;
      }
      case K.TemplateExpression:
        for (const span of node.templateSpans as Node[]) this.eval(span.expression, s);
        return sharedValue;
      case K.TypeOfExpression: case K.VoidExpression:
        this.eval(node.expression, s);
        return sharedValue;
      case K.DeleteExpression:
        this.evalWriteTarget(node.expression, s);
        return sharedValue;
      case K.PrefixUnaryExpression:
        if (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken) this.evalWriteTarget(node.operand, s);
        else this.eval(node.operand, s);
        return sharedValue;
      case K.PostfixUnaryExpression:
        this.evalWriteTarget(node.operand, s);
        return sharedValue;
      case K.YieldExpression: {
        this.eval(node.expression, s);
        // The value sent into the generator comes from its caller.
        const r = a.newRegion();
        s.addFlags(r, RegionFlags.Caller);
        return regionValue(r);
      }
      case K.BinaryExpression:
        return this.evalBinary(node, s);
      case K.ConditionalExpression: {
        this.eval(node.condition, s);
        const whenFalse = s.copy();
        const vt = this.eval(node.whenTrue, s);
        const vf = this.eval(node.whenFalse, whenFalse);
        s.assign(joinStates(s, whenFalse));
        return s.mergeValues(vt, vf);
      }
      case K.ObjectLiteralExpression:
        return this.evalObjectLiteral(node, s);
      case K.ArrayLiteralExpression: {
        const r = a.newRegion();
        for (const element of node.elements as Node[]) {
          const v = this.eval(element, s);
          if (v.kind === ValueKind.InRegion) s.union(r, v.region);
        }
        return regionValue(s.find(r));
      }
      case K.SpreadElement:
        return this.eval(node.expression, s);
      case K.FunctionExpression: case K.ArrowFunction: case K.ClassExpression:
        return this.closureValue(node, s);
      case K.CallExpression:
        if (isConsumeCall(a.c, node)) return this.evalConsume(node, node.arguments[0], s); // `consume(x)`
        return this.evalCall(node, s);
      case K.NewExpression:
        return this.evalNew(node, s);
      case K.TaggedTemplateExpression: {
        let v = this.eval(node.tag, s);
        if (node.template.kind === K.TemplateExpression) {
          for (const span of node.template.templateSpans as Node[]) v = s.mergeValues(v, this.eval(span.expression, s));
        }
        if (a.isPrimitiveOrSharedStructType(a.typeOf(node))) return sharedValue;
        return v;
      }
      case K.PropertyAccessExpression: {
        const obj = this.eval(node.expression, s);
        return this.readMember(node, node.expression, obj, s);
      }
      case K.ElementAccessExpression: {
        const obj = this.eval(node.expression, s);
        this.eval(node.argumentExpression, s);
        return this.readMember(node, node.expression, obj, s);
      }
    }
    return this.evalChildren(node, s);
  }

  // Fallback for expressions without a specific rule (JSX and the like): a fresh region holding the
  // regions of all subexpressions.
  evalChildren(node: Node, s: State): Value {
    const r = this.a.newRegion();
    forEachChild(node, (child) => {
      if (isTypeNode(child) || child.kind === K.Identifier && !isOwnValueReference(child)) return false;
      if (isExpression(child) || isJsxChildOrAttribute(child)) {
        const v = this.eval(child, s);
        if (v.kind === ValueKind.InRegion) s.union(r, v.region);
      } else {
        forEachChild(child, (grandchild) => {
          if (isExpression(grandchild) && grandchild.kind !== K.Identifier) {
            const v = this.eval(grandchild, s);
            if (v.kind === ValueKind.InRegion) s.union(r, v.region);
          }
          return false;
        });
      }
      return false;
    });
    return regionValue(s.find(r));
  }

  readIdentifier(id: Node, s: State): Value {
    const symbol = this.a.symbolOfIdentifier(id);
    if (!symbol) return sharedValue;
    const v = this.lookup(symbol, s);
    if (this.checkUse(id, id.text, v, s) && v.kind === ValueKind.Consumed) return sharedValue;
    return v;
  }

  // The value of a variable in this function: its binding, a closure for a local function
  // declaration, or (for variables of enclosing scopes) shared or an OUTER region.
  lookup(symbol: TsSymbol, s: State): Value {
    const bound = s.vars.get(symbol);
    if (bound) return bound;
    const a = this.a;
    if (a.isLocalTo(symbol, this.node)) {
      const handle = symbol.valueDeclaration;
      if (handle && this.node.kind !== K.SourceFile && (handle.kind === K.FunctionDeclaration || handle.kind === K.ClassDeclaration)) {
        // A nested function or class: a closure over the variables it captures.
        return this.closureValue(a.c.host.declarationOf(handle)!, s);
      }
      // Shared, or declared in this function but not initialized yet (or hoisted).
      return sharedValue;
    }
    if (a.isSharedSymbol(symbol)) return sharedValue;
    const r = a.newRegionOf(a.isCountedType(a.c.host.typeOfSymbol(symbol)), s);
    s.addFlags(r, RegionFlags.Outer);
    const v = regionValue(r);
    s.vars.set(symbol, v);
    return v;
  }

  // Reports a use of a variable whose region was sent (or whose value was consumed). Returns true if
  // it reported an error.
  checkUse(node: Node, name: string, v: Value, s: State): boolean {
    if (v.kind === ValueKind.Consumed) {
      this.a.reportUseAfterSend(node, name, v.consumed!, v.maybe);
      return true;
    }
    if (v.kind === ValueKind.InRegion) {
      const [, inf] = s.root(v);
      if (inf.sent) {
        this.a.reportUseAfterSend(node, name, inf.sent, inf.maybe);
        return true;
      }
    }
    return false;
  }

  // `consume(x)` hands x's value over to the enclosing expression and ends x's lifetime: later uses of
  // x are errors. The value itself is only sent if it is then passed to a `Sending` parameter.
  evalConsume(node: Node, operand: Node, s: State): Value {
    operand = skipParentheses(operand);
    const v = this.eval(operand, s);
    if (operand.kind === K.Identifier) {
      const symbol = this.a.symbolOfIdentifier(operand);
      if (symbol && this.a.isLocalTo(symbol, this.node)) {
        let callee = "consume";
        const call = walkUpParenthesizedExpressions(node.parent as Node);
        if (call && (call.kind === K.CallExpression || call.kind === K.NewExpression) && call.expression !== node) {
          callee = calleeName(call.expression);
        }
        s.vars.set(symbol, { kind: ValueKind.Consumed, region: 0, consumed: { site: node, callee, via: operand.text, consume: true }, maybe: false });
      }
    }
    return v;
  }

  evalBinary(node: Node, s: State): Value {
    const op = node.operatorToken.kind as K;
    if (op === K.EqualsToken) {
      const v = this.eval(node.right, s);
      this.assign(node.left, v, s);
      return v;
    }
    if (op === K.AmpersandAmpersandEqualsToken || op === K.BarBarEqualsToken || op === K.QuestionQuestionEqualsToken) {
      const old = this.eval(node.left, s);
      const assigned = s.copy();
      const v = assigned.mergeValues(old, this.eval(node.right, assigned));
      this.assign(node.left, v, assigned);
      s.assign(joinStates(s, assigned));
      return v;
    }
    if (isAssignmentOperator(op)) {
      // Compound assignment: reads and writes the target.
      this.evalWriteTarget(node.left, s);
      this.eval(node.right, s);
      return sharedValue;
    }
    if (op === K.AmpersandAmpersandToken || op === K.BarBarToken || op === K.QuestionQuestionToken) {
      const left = this.eval(node.left, s);
      const right = s.copy();
      const vr = this.eval(node.right, right);
      s.assign(joinStates(s, right));
      return s.mergeValues(left, vr);
    }
    if (op === K.CommaToken) {
      const left = this.eval(node.left, s);
      return s.mergeValues(left, this.eval(node.right, s));
    }
    this.eval(node.left, s);
    this.eval(node.right, s);
    if (op === K.PlusToken && !this.a.isPrimitiveOrSharedStructType(this.a.typeOf(node))) return regionValue(this.a.newRegion());
    return sharedValue;
  }

  // Evaluates the target of `x++`, `delete a.b`, `a.b += 1` and the like, reporting writes through
  // shared values.
  evalWriteTarget(target: Node, s: State): void {
    target = skipParentheses(target);
    if (target.kind === K.PropertyAccessExpression || target.kind === K.ElementAccessExpression) {
      const obj = this.eval(target.expression, s);
      if (target.kind === K.ElementAccessExpression) this.eval(target.argumentExpression, s);
      this.checkWrite(target, target.expression, obj);
    } else {
      this.eval(target, s);
    }
  }

  // Assigns a value to an assignment target: rebinds a local variable, merges into the OUTER region of
  // a captured one, or links the value to the object whose property is written.
  assign(target: Node, v: Value, s: State): void {
    target = skipOuterExpressions(target, OEK.Assertions | OEK.Parentheses);
    const a = this.a;
    switch (target.kind) {
      case K.Identifier: {
        const symbol = a.symbolOfIdentifier(target);
        if (!symbol) return;
        if (a.isLocalTo(symbol, this.node)) {
          s.vars.set(symbol, a.normalize(symbol, v));
          return;
        }
        s.mergeValues(this.lookup(symbol, s), v);
        return;
      }
      case K.PropertyAccessExpression: case K.ElementAccessExpression: {
        const obj = this.eval(target.expression, s);
        if (target.kind === K.ElementAccessExpression) this.eval(target.argumentExpression, s);
        this.checkWrite(target, target.expression, obj);
        if (obj.kind === ValueKind.InRegion && !s.isCounted(obj)) s.mergeValues(obj, v);
        return;
      }
      case K.ArrayLiteralExpression:
        for (const element of target.elements as Node[]) {
          if (element.kind === K.OmittedExpression) continue;
          if (element.kind === K.SpreadElement) {
            this.assign(element.expression, v, s);
          } else if (element.kind === K.BinaryExpression && element.operatorToken.kind === K.EqualsToken) {
            this.assign(element.left, s.mergeValues(v, this.eval(element.right, s)), s);
          } else {
            this.assign(element, v, s);
          }
        }
        return;
      case K.ObjectLiteralExpression:
        for (const property of target.properties as Node[]) {
          switch (property.kind) {
            case K.PropertyAssignment: {
              if (property.name.kind === K.ComputedPropertyName) this.eval(property.name.expression, s);
              const init = property.initializer as Node;
              if (init.kind === K.BinaryExpression && init.operatorToken.kind === K.EqualsToken) {
                this.assign(init.left, s.mergeValues(v, this.eval(init.right, s)), s);
              } else {
                this.assign(init, v, s);
              }
              break;
            }
            case K.ShorthandPropertyAssignment: {
              let pv = v;
              if (property.objectAssignmentInitializer) pv = s.mergeValues(pv, this.eval(property.objectAssignmentInitializer, s));
              this.assign(property.name, pv, s);
              break;
            }
            case K.SpreadAssignment:
              this.assign(property.expression, v, s);
              break;
          }
        }
        return;
    }
    this.eval(target, s);
  }

  // Reports a write to a property or element of a shared value. Fields of shared struct instances are
  // mutable cells, so writing them is allowed.
  checkWrite(target: Node, object: Node, obj: Value): void {
    if (obj.kind !== ValueKind.Shared || !this.a.isImmutableShared(object)) return;
    this.a.report(target, ReportKind.Write, target, Messages.ChangeShared, expressionName(object));
  }

  // The value of `o.p` or `o[i]` given the value of `o`: shared if `o` is shared (sharedness is deep),
  // if the member is declared shared, or if it is a primitive; otherwise in `o`'s region.
  readMember(node: Node, object: Node, obj: Value, s: State): Value {
    const a = this.a;
    if (obj.kind !== ValueKind.InRegion) return sharedValue;
    if (s.isCounted(obj)) {
      // A struct element of a SharedArray is stored inline in the array's block: an alias of the
      // array. Fields are numbers or untracked references.
      if (node.kind === K.ElementAccessExpression && a.isCountedType(a.typeOf(node))) return obj;
      return sharedValue;
    }
    if (node.kind === K.PropertyAccessExpression) {
      const prop = a.c.host.symbolAt(node.name);
      if (prop && (prop.flags & SymbolFlags.Method || a.isDeclaredShared(prop))) return sharedValue;
    } else if (a.isElementDeclaredShared(object)) {
      return sharedValue;
    }
    if (a.isPrimitiveOrSharedStructType(a.typeOf(node))) return sharedValue;
    return obj;
  }

  evalObjectLiteral(node: Node, s: State): Value {
    const r = this.a.newRegion();
    const add = (v: Value): void => {
      if (v.kind === ValueKind.InRegion) s.union(r, v.region);
    };
    for (const property of node.properties as Node[]) {
      if (property.name?.kind === K.ComputedPropertyName) this.eval(property.name.expression, s);
      switch (property.kind) {
        case K.PropertyAssignment:
          add(this.eval(property.initializer, s));
          break;
        case K.ShorthandPropertyAssignment:
          add(this.readIdentifier(property.name, s));
          break;
        case K.SpreadAssignment:
          add(this.eval(property.expression, s));
          break;
        case K.MethodDeclaration: case K.GetAccessor: case K.SetAccessor:
          add(this.closureValue(property, s));
          break;
      }
    }
    return regionValue(s.find(r));
  }

  // The value of a closure (function, arrow function, class or object literal method): a fresh region
  // merged with the regions of the variables it captures.
  closureValue(node: Node, s: State): Value {
    const r = this.a.newRegion();
    if (this.building.has(node)) return regionValue(r);
    this.building.add(node);
    try {
      const captures = this.a.capturesOf(node);
      captures.symbols.forEach((symbol, i) => {
        const v = this.lookup(symbol, s);
        // A captured variable that was already sent is reported once, here; it is not linked to the
        // closure, so that uses of the closure do not report it again.
        if (!this.checkUse(captures.nodes[i]!, symbol.name, v, s) && v.kind === ValueKind.InRegion && !s.isCounted(v)) {
          s.union(r, v.region);
        }
      });
      if (captures.usesThis) {
        const v = this.thisValue(s);
        if (v.kind === ValueKind.InRegion) s.union(r, v.region);
      }
    } finally {
      this.building.delete(node);
    }
    return regionValue(s.find(r));
  }

  evalCall(node: Node, s: State): Value {
    const a = this.a;
    const host = a.c.host;
    const callee = skipOuterExpressions(node.expression, OEK.Parentheses | OEK.NonNullAssertions);
    const regions: Region[] = [];
    const add = (v: Value): void => {
      // A counted value is not linked to the other arguments.
      if (v.kind === ValueKind.InRegion && !s.isCounted(v)) regions.push(v.region);
    };
    const args = node.arguments as Node[];
    if (callee.kind === K.ImportKeyword) {
      // `import(...)`: the module namespace is a fresh object.
      for (const arg of args) this.eval(arg, s);
      return regionValue(a.newRegion());
    }
    const name = calleeName(callee);
    let receiverExpr: Node | undefined;
    let receiver = sharedValue;
    if (callee.kind === K.PropertyAccessExpression || callee.kind === K.ElementAccessExpression) {
      receiverExpr = callee.expression as Node;
      receiver = this.eval(receiverExpr, s);
      if (callee.kind === K.ElementAccessExpression) this.eval(callee.argumentExpression, s);
      add(receiver);
    } else {
      add(this.eval(callee, s));
    }
    const handle = host.signatureOf(node).declaration;
    const decl = a.declarationOutsideLibrary(handle);
    if (receiverExpr && arrayMutators.has(name) && receiver.kind === ValueKind.Shared && a.isArrayExpression(receiverExpr) && a.isImmutableShared(receiverExpr)) {
      a.report(node, ReportKind.Write, callee, Messages.ChangeShared, expressionName(receiverExpr));
    }
    const params = signatureParameters(decl);
    const consuming = a.isConsumingSignature(decl);
    let callback: Node | undefined;
    if (receiverExpr && (name === "map" || name === "flatMap") && args.length > 0 && a.isLibArrayMethod(handle)) {
      const cb = skipParentheses(args[0]!);
      if (isFunctionExpressionOrArrowFunction(cb)) callback = cb;
    }
    const otherArgs: Region[] = []; // arguments other than the receiver and a map callback
    args.forEach((arg, i) => {
      const expr = arg.kind === K.SpreadElement ? arg.expression as Node : arg;
      const v = this.eval(expr, s);
      const param = parameterAt(params, i);
      if (param && a.isSendingTypeNode(param.type)) {
        this.sendArgument(v, expr, param, name, consuming, s);
        return;
      }
      add(v);
      if (v.kind === ValueKind.InRegion && !s.isCounted(v) && !(callback && i === 0)) otherArgs.push(v.region);
    });
    const counted = a.isCountedType(a.typeOf(node));
    switch (a.returnKind(decl)) {
      case ReturnKind.Sending:
        this.unionAll(regions, s);
        return regionValue(a.newRegionOf(counted, s));
      case ReturnKind.Shared:
        this.unionAll(regions, s);
        return sharedValue;
    }
    if (callback && a.analyzeFunction(callback).returnsFresh) {
      // map/flatMap with a callback that builds fresh values: the result is a fresh array.
      this.unionAll(otherArgs, s);
      return regionValue(a.newRegion());
    }
    let r = this.unionAll(regions, s);
    if (counted) return regionValue(a.newRegionOf(true, s)); // not tracked through the call: a fresh counted value
    if (a.isPrimitiveOrSharedStructType(a.typeOf(node))) return sharedValue;
    if (r === 0) r = a.newRegion();
    return regionValue(r);
  }

  evalNew(node: Node, s: State): Value {
    const a = this.a;
    const args = (node.arguments ?? []) as Node[];
    const counted = a.isCountedType(a.typeOf(node));
    if (counted) {
      // `new` of a SharedArray (or another counted value): a fresh counted value.
      for (const arg of args) this.eval(arg, s);
      return regionValue(a.newRegionOf(true, s));
    }
    const regions: Region[] = [];
    const v = this.eval(node.expression, s);
    if (v.kind === ValueKind.InRegion) regions.push(v.region);
    const decl = a.signatureDeclarationOf(node);
    const params = signatureParameters(decl);
    const name = calleeName(node.expression);
    const consuming = a.isConsumingSignature(decl);
    args.forEach((arg, i) => {
      const expr = arg.kind === K.SpreadElement ? arg.expression as Node : arg;
      const value = this.eval(expr, s);
      const param = parameterAt(params, i);
      if (param && a.isSendingTypeNode(param.type)) {
        this.sendArgument(value, expr, param, name, consuming, s);
        return;
      }
      if (value.kind === ValueKind.InRegion && !s.isCounted(value)) regions.push(value.region);
    });
    switch (a.returnKind(decl)) {
      case ReturnKind.Sending:
        this.unionAll(regions, s);
        return regionValue(a.newRegion());
      case ReturnKind.Shared:
        this.unionAll(regions, s);
        return sharedValue;
    }
    if (a.isPrimitiveOrSharedStructType(a.typeOf(node))) {
      this.unionAll(regions, s);
      return sharedValue;
    }
    // A new object: a fresh region holding the (non-shared) constructor arguments.
    const r = a.newRegion();
    for (const region of regions) s.union(r, region);
    return regionValue(s.find(r));
  }

  // Merges regions and returns the root, or 0 if there are none.
  unionAll(regions: Region[], s: State): Region {
    let r = 0;
    for (const region of regions) r = r === 0 ? s.find(region) : s.union(r, region);
    return r;
  }

  // Passes an argument to a `Sending` parameter. A counted value is sent (moved) only by a parameter
  // that is not a rest parameter: a thread's arguments share it, and a share-like function leaves it
  // as it is.
  sendArgument(v: Value, expr: Node, param: Node, callee: string, consuming: boolean, s: State): void {
    if (s.isCounted(v) && (consuming || param.dotDotDotToken)) return;
    this.send(v, expr, callee, consuming, s);
  }

  // Sends a value: passes it to a `Sending` parameter (or a share-like function, which consumes it).
  send(v: Value, expr: Node, callee: string, consuming: boolean, s: State): void {
    if (v.kind !== ValueKind.InRegion) return;
    const [root, inf] = s.root(v);
    const name = expressionName(expr);
    if (inf.flags & RegionFlags.Caller) {
      this.a.report(expr, ReportKind.Send, expr, Messages.SendCallerReferenced, name);
    } else if (inf.flags & RegionFlags.Outer) {
      this.a.report(expr, ReportKind.Send, expr, Messages.SendCaptured, name);
    } else if (inf.sent && !inf.maybe) {
      // Already sent: the use of the sent variable has been reported.
    } else {
      s.addSend(root, { site: expr, callee, via: name, consume: consuming }, false);
    }
  }
}

function isJsxChildOrAttribute(node: Node): boolean {
  switch (node.kind) {
    case K.JsxElement: case K.JsxExpression: case K.JsxSelfClosingElement: case K.JsxText: case K.JsxFragment:
    case K.JsxAttribute: case K.JsxSpreadAttribute: case K.JsxAttributes:
      return true;
  }
  return false;
}

function lineOf(node: Node): number {
  const file = node.getSourceFile();
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

// A short name for an expression in a message: the variable for `x` and `consume(x)`, otherwise the
// (abbreviated) source text.
function expressionName(expr: Node): string {
  expr = skipParentheses(expr);
  if (expr.kind === K.CallExpression && expr.arguments.length === 1 && expr.expression.kind === K.Identifier && expr.expression.text === "consume") {
    expr = skipParentheses(expr.arguments[0]); // `consume(x)`
  }
  if (expr.kind === K.Identifier) return expr.text;
  let text = expr.getText(expr.getSourceFile()).split(/\s+/).filter((part: string) => part !== "").join(" ");
  if (text.length > 40) text = text.slice(0, 37) + "...";
  return text;
}

function calleeName(callee: Node): string {
  callee = skipParentheses(callee);
  if (callee.kind === K.Identifier) return callee.text;
  if (callee.kind === K.PropertyAccessExpression) return callee.name.text;
  return expressionName(callee);
}

// The function body or file in which a declaration lives.
function ownerOf(decl: Node): Node | undefined {
  for (let n = decl.parent as Node | undefined; n; n = n.parent as Node | undefined) {
    if (isFunctionBody(n) || n.kind === K.SourceFile) return n;
  }
  return undefined;
}

// The parameters of a signature declaration, without a `this` parameter.
function signatureParameters(decl: Node | undefined): Node[] {
  if (!decl || !isFunctionLike(decl)) return [];
  const params = (decl.parameters ?? []) as Node[];
  return params.length > 0 && isThisParameter(params[0]!) ? params.slice(1) : [...params];
}

// The parameter an argument at the given index is passed to.
function parameterAt(params: Node[], index: number): Node | undefined {
  if (index < 0 || params.length === 0) return undefined;
  if (index < params.length) return params[index];
  const last = params[params.length - 1]!;
  return last.dotDotDotToken ? last : undefined;
}

// The name of a type parameter of decl that t refers to, if it is one.
function typeParameterName(decl: Node, t: Node | undefined): string {
  while (t && t.kind === K.ParenthesizedType) t = t.type as Node;
  if (!t || t.kind !== K.TypeReference || (t.typeArguments?.length ?? 0) !== 0 || t.typeName.kind !== K.Identifier) return "";
  const name = t.typeName.text as string;
  for (const tp of (decl.typeParameters ?? []) as Node[]) {
    if (tp.name.text === name) return name;
  }
  return "";
}
