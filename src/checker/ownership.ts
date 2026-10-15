// Ownership (region) analysis (ownership.go).
//
// The analysis is intraprocedural and flow-sensitive, in the style of Swift's
// region-based isolation (SE-0414). Every value an expression evaluates to is
// either SHARED (it has no region: primitives, values declared `Shared<T>` ,
// cells, code) or lives in a REGION, a set of objects that may reference each
// other. Regions are the classes of a union-find. A region can be SENT (handed
// to another owner through a `Sending<T>` parameter, `share(...)` and the
// like); using a variable whose region was sent is an error. CALLER regions
// (ordinary parameters and `this` ) and OUTER regions (variables captured from
// an enclosing scope) can never be sent.
//
// Counted values (shared structs and SharedArrays) live in COUNTED regions of
// their own, which never merge with ordinary ones: `new` , a call and a
// received value give a fresh one; only a `Sending` parameter that is not a
// rest parameter moves one (a channel's `send` ).
//
// The approximations are those of the fork, which this follows rule for rule;
// see ownership.go.

import type {SourceFile} from 'typescript/ast';
import type {Own} from './context.ts';
import {IndexKind, SymbolFlags, TypeFlags} from './host.ts';
import type {NodeHandle, Signature, TsSymbol, Type} from './host.ts';
import {getSharedArrayElementType, isCellType, spreadShape} from './layout.ts';
import {getTypeMarker, isCellBranded, isConsumeCall} from './markers.ts';
import {Messages} from './messages.ts';
import type {Message} from './messages.ts';
import {getChannelElementType} from './refcount.ts';
import {
  forEachChild,
  getCombinedNodeFlags,
  isAssignmentOperator,
  isBindingPattern,
  isClassLike,
  isExpression,
  isFunctionExpressionOrArrowFunction,
  isFunctionLike,
  isObjectLiteralMethod,
  isOwnValueReference,
  isThisParameter,
  isTypeNode,
  isWithin,
  K,
  NodeFlags,
  OEK,
  skipOuterExpressions,
  skipParentheses,
  walkUpParenthesizedExpressions,
} from './syntax.ts';
import type {Node} from './syntax.ts';

const maxLoopIterations = 4;

type Region = number;

const ValueKind = {Shared: 0, InRegion: 1, Consumed: 2} as const;
type ValueKind = (typeof ValueKind)[keyof typeof ValueKind];

interface Value {
  readonly kind: ValueKind;
  readonly region: Region;
  readonly consumed?: Send; // for Consumed
  readonly maybe: boolean; // for Consumed: consumed on some paths only
  // for Consumed: the regions of the values it may have held when consumed,
  // each with whether it was consumed holding that one on some paths only
  readonly origins?: readonly Origin[];
  // for InRegion: the classes defined in the function it may be, and whether
  // it may be another constructor too (a value with no classes may be any)
  readonly ctors?: readonly Node[];
  readonly otherCtor?: boolean;
}

interface Origin {
  readonly region: Region;
  readonly maybe: boolean;
}

const sharedValue: Value = {kind: ValueKind.Shared, region: 0, maybe: false};

function regionValue(r: Region): Value {
  return {kind: ValueKind.InRegion, region: r, maybe: false};
}

const RegionFlags = {Caller: 1, Outer: 2, Counted: 4} as const;

// A send (or consume) of a region.
interface Send {
  readonly site: Node; // the sent expression
  readonly callee: string; // what it was sent to
  // the variable (or expression) through which it was sent
  readonly via: string;
  readonly consume: boolean; // consumed rather than sent
}

interface RegionInfo {
  readonly flags: number;
  readonly sent: Send | undefined;
  readonly maybe: boolean; // sent on some paths only
}

const noInfo: RegionInfo = {flags: 0, sent: undefined, maybe: false};

// The abstract state at a program point. Region infos are immutable, so copies
// share them.
// What a destructuring pattern takes apart: the type of its value, where it
// is known, and whether that may be null or undefined.
interface Part {
  readonly type?: Type;
  readonly nullable: boolean;
}

// A class's number, for a signature: its place in its file.
const ctorKey = (node: Node) => `${node.pos}:${node.end}`;

// A consume() of a local variable: which, holding what.
interface ConsumeEvent {
  readonly id: number;
  readonly region: Region;
  readonly send: Send;
}

class State {
  unreachable = false;
  vars = new Map<TsSymbol, Value>();
  parent = new Map<Region, Region>(); // union-find links (absent for roots)
  info = new Map<Region, RegionInfo>(); // by root
  // the consume()s on the paths here, in order (see checkStillThere)
  consumes: readonly ConsumeEvent[] = [];

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
    r.consumes = this.consumes;
    return r;
  }

  assign(other: State): void {
    this.unreachable = other.unreachable;
    this.vars = other.vars;
    this.parent = other.parent;
    this.info = other.info;
    this.consumes = other.consumes;
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
    this.info.set(r, {...inf, flags: inf.flags | flags});
  }

  addSend(r: Region, send: Send, maybe: boolean): void {
    r = this.find(r);
    const inf = this.infoOf(r);
    if (!inf.sent || (inf.maybe && !maybe)) {
      this.info.set(r, {...inf, sent: send, maybe});
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
      // A counted value and an ordinary one never alias: keep them apart (the
      // ordinary one stands for the pair, so that sending it still sends the
      // ordinary objects).
      return ia.flags & RegionFlags.Counted ? rb : ra;
    }
    this.parent.set(rb, ra);
    this.info.delete(rb);
    let merged: RegionInfo = {...ia, flags: ia.flags | ib.flags};
    if (ib.sent && (!merged.sent || (merged.maybe && !ib.maybe))) {
      merged = {...merged, sent: ib.sent, maybe: ib.maybe};
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
    if (a.kind === ValueKind.InRegion && b.kind === ValueKind.InRegion) {
      const merged = regionValue(this.union(a.region, b.region));
      if (!a.ctors && !b.ctors) return merged;
      // a class from either side, and any other constructor either may be
      const other = (v: Value) => !v.ctors || !!v.otherCtor;
      return {
        ...merged,
        ctors: [...new Set([...(a.ctors ?? []), ...(b.ctors ?? [])])],
        otherCtor: other(a) || other(b),
      };
    }
    if (a.kind === ValueKind.InRegion) return a;
    if (b.kind === ValueKind.InRegion) return b;
    return sharedValue;
  }

  joinValues(a: Value, b: Value): Value {
    if (a.kind === ValueKind.Consumed && b.kind === ValueKind.Consumed) {
      return {
        kind: ValueKind.Consumed,
        region: 0,
        consumed: a.consumed,
        maybe: a.maybe || b.maybe,
        origins: this.joinOrigins(a, b),
      };
    }
    if (a.kind === ValueKind.Consumed)
      return {
        kind: ValueKind.Consumed,
        region: 0,
        consumed: a.consumed,
        maybe: true,
        origins: this.joinOrigins(a, b),
      };
    if (b.kind === ValueKind.Consumed)
      return {
        kind: ValueKind.Consumed,
        region: 0,
        consumed: b.consumed,
        maybe: true,
        origins: this.joinOrigins(a, b),
      };
    return this.mergeValues(a, b);
  }

  // The origins of two paths' values of a variable, one of them consumed:
  // every region either may have held, consumed holding it on every path only
  // where both were.
  joinOrigins(a: Value, b: Value): readonly Origin[] | undefined {
    const as = a.kind === ValueKind.Consumed ? (a.origins ?? []) : [];
    const bs = b.kind === ValueKind.Consumed ? (b.origins ?? []) : [];
    if (as.length === 0 && bs.length === 0) return undefined;
    const same = (o: Origin, p: Origin) =>
      this.find(o.region) === this.find(p.region);
    const out: Origin[] = [];
    for (const o of as) {
      const p = bs.find(p => same(o, p));
      out.push({region: o.region, maybe: o.maybe || !p || p.maybe});
    }
    for (const p of bs)
      if (!as.some(o => same(o, p))) out.push({region: p.region, maybe: true});
    return out;
  }

  // Forgets the regions no binding holds (nor any of kept, a value held
  // outside the state): their links and infos, which nothing can reach. The
  // regions that are held keep their numbers.
  collect(kept: readonly Region[]): void {
    // the regions held, each of which keeps its number
    const held = new Set<Region>(kept);
    for (const v of this.vars.values()) {
      if (v.kind === ValueKind.InRegion) held.add(v.region);
      for (const o of v.origins ?? []) held.add(o.region);
    }
    // their components, the regions no one holds left out (an alias that
    // went out of scope with its binding), each rooted at its least region:
    // the same components are written the same, whatever unions made them
    const components = new Map<Region, Region[]>();
    for (const r of held) {
      const root = this.find(r);
      const members = components.get(root);
      if (members) members.push(r);
      else components.set(root, [r]);
    }
    const parent = new Map<Region, Region>();
    const info = new Map<Region, RegionInfo>();
    for (const [root, members] of components) {
      const least = Math.min(...members);
      const inf = this.info.get(root);
      if (inf) info.set(least, inf);
      for (const r of members) if (r !== least) parent.set(r, least);
    }
    this.parent = parent;
    this.info = info;
    // what consume()s happened matters to the expression they are in only,
    // and none is being evaluated where a state is collected
    this.consumes = [];
  }

  // Reports whether two states are the same: the same bindings, region links
  // and region infos, region by region (not alike only up to renaming regions,
  // as their signatures may be).
  sameAs(o: State): boolean {
    if (this.unreachable || o.unreachable)
      return this.unreachable === o.unreachable;
    const sameMap = <K, V>(
      a: Map<K, V>,
      b: Map<K, V>,
      same: (x: V, y: V) => boolean,
    ) => {
      if (a.size !== b.size) return false;
      for (const [k, x] of a) {
        const y = b.get(k);
        if (y === undefined || !same(x, y)) return false;
      }
      return true;
    };
    const sameOrigins = (x?: readonly Origin[], y?: readonly Origin[]) =>
      (x?.length ?? 0) === (y?.length ?? 0) &&
      (x ?? []).every(
        (o, i) => o.region === y![i]!.region && o.maybe === y![i]!.maybe,
      );
    return (
      this.consumes.length === o.consumes.length &&
      this.consumes.every((e, i) => e === o.consumes[i]) &&
      sameMap(this.parent, o.parent, (x, y) => x === y) &&
      sameMap(
        this.info,
        o.info,
        (x, y) =>
          x.flags === y.flags && x.sent === y.sent && x.maybe === y.maybe,
      ) &&
      sameMap(
        this.vars,
        o.vars,
        (x, y) =>
          x.kind === y.kind &&
          x.region === y.region &&
          x.consumed === y.consumed &&
          x.maybe === y.maybe &&
          sameOrigins(x.origins, y.origins) &&
          !!x.otherCtor === !!y.otherCtor &&
          (x.ctors?.length ?? 0) === (y.ctors?.length ?? 0) &&
          (x.ctors ?? []).every(n => y.ctors!.includes(n)),
      )
    );
  }

  // A canonical description of the state, used to detect that a loop has
  // reached a fixpoint.
  signature(idOf: (symbol: TsSymbol) => number): string {
    if (this.unreachable) return 'unreachable';
    const symbols = [...this.vars.keys()].sort((a, b) => idOf(a) - idOf(b));
    const roots = new Map<Region, number>();
    let out = '';
    for (const symbol of symbols) {
      const v = this.vars.get(symbol)!;
      out += idOf(symbol);
      switch (v.kind) {
        case ValueKind.Shared:
          out += '=s;';
          break;
        case ValueKind.Consumed:
          out += v.maybe ? '=c?;' : '=c;';
          break;
        case ValueKind.InRegion: {
          const [r, inf] = this.root(v);
          let index = roots.get(r);
          if (index === undefined) {
            index = roots.size;
            roots.set(r, index);
          }
          out += `=r${index}f${inf.flags}${inf.sent ? (inf.maybe ? 's?' : 's') : ''}`;
          // the classes a constructor may be, which a `new` of it takes
          if (v.ctors)
            out += `c${v.ctors.map(ctorKey).sort().join(',')}${v.otherCtor ? '+' : ''}`;
          out += ';';
        }
      }
    }
    // what each consumed variable may have held: a region a variable holds by
    // its number, any other alike
    for (const symbol of symbols) {
      const origins = this.vars.get(symbol)!.origins;
      if (!origins) continue;
      const held = origins
        .map(
          o => `${roots.get(this.find(o.region)) ?? 'x'}${o.maybe ? '?' : ''}`,
        )
        .sort();
      out += `${idOf(symbol)}o${held.join(',')};`;
    }
    return out;
  }
}

// Joins the states of two paths. Equivalences, flags and sends of both are
// kept; a region sent on only one of the paths is "maybe sent".
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
  r.consumes = [
    ...a.consumes,
    ...b.consumes.filter(e => !a.consumes.includes(e)),
  ];
  return r;
}

function joinAllStates(first: State, rest: State[]): State {
  let result = first;
  for (const s of rest) result = joinStates(result, s);
  return result;
}

// Entry point

// Runs the ownership analysis on the top-level statements and every function
// body of a file.
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
    case K.FunctionDeclaration:
    case K.FunctionExpression:
    case K.ArrowFunction:
    case K.MethodDeclaration:
    case K.Constructor:
    case K.GetAccessor:
    case K.SetAccessor:
      return !!node.body;
    case K.ClassStaticBlockDeclaration:
      return true;
  }
  return false;
}

const ReportKind = {Use: 0, Send: 1, Return: 2, Write: 3} as const;

interface FunctionResult {
  // every returned value is shared or in a region not linked to the caller or
  // outer scopes
  returnsFresh: boolean;
}

interface Captures {
  symbols: TsSymbol[];
  nodes: Node[]; // first reference of each symbol
  // an arrow function (or a closure nested in one) uses the enclosing `this`
  usesThis: boolean;
}

export const ReturnKind = {Ordinary: 0, Sending: 1, Shared: 2} as const;
export type ReturnKind = (typeof ReturnKind)[keyof typeof ReturnKind];

interface Target {
  labels: string[];
  isLoop: boolean;
  isSwitch: boolean;
  breaks: State[];
  continues: State[];
  tries: number; // the try statements open when the target was entered
}

// A scope that cleans up as control leaves it early, which may throw: a for-of
// loop closes its iterator, a block with a `using` declaration disposes of its
// value. That comes after the finallies inside the scope, and throws to the
// try around it.
interface Cleanup {
  // the targets open as it was entered: a for-of loop's own is the next one,
  // which a break leaves and a continue does not
  targets: number;
  loop: boolean;
  tries: number; // the try statements open as it was entered
  // a block's: whether a `using` declaration in it has run, before the point
  // being analyzed (its statements are analyzed in order), so that it holds
  // something to dispose of; a for-of loop holds its iterator from its start
  held: boolean;
  node: Node;
}

// A try statement being analyzed: the states with which control leaves its
// block, or its catch, early. A throw (an explicit one, or one an expression
// may make as it is evaluated: a call, a construction, an await, a property
// read or write, an operator that converts its operands, an iteration, a
// destructuring) goes to `caught` while the block of a try with a catch is
// analyzed, else to `thrown`; a return, or a break or continue out of the
// try, to `exits`, with where it goes. An early exit is recorded in the
// innermost try only; once that try's finally has run for it, what is
// still reachable goes on as what it was: to the next try out if it leaves
// that one too, else to its target. So a finally that changes or overrides it
// is taken into account, a throw still reaches a catch further out while a
// return does not, and a break or continue reaches its target only after
// every finally it crosses.
interface TryContext {
  catches: boolean;
  caught: State[];
  thrown: State[];
  exits: Exit[];
}

// A return (to no target), or a break or continue to its target
interface Exit {
  st: State;
  to: Target | undefined;
  isBreak: boolean;
}

const arrayMutators = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);

// The key a pattern's element is read by, a name or a literal, or undefined
// for a computed one.
function keyOf(name: Node): string | undefined {
  return name.kind === K.Identifier ||
    name.kind === K.StringLiteral ||
    name.kind === K.NumericLiteral
    ? name.text
    : undefined;
}

// Reports whether a statement is a `using` or `await using` declaration.
function isUsingDeclaration(node: Node): boolean {
  return node.kind === K.VariableStatement && isUsingList(node.declarationList);
}

// Reports whether a declaration list declares with `using` or `await using`.
function isUsingList(list: Node): boolean {
  const scoped = list.flags & NodeFlags.BlockScoped;
  return scoped === NodeFlags.Using || scoped === NodeFlags.AwaitUsing;
}

// Reports whether an expression reads or writes a property or an element.
function isMemberAccess(node: Node): boolean {
  const n = skipOuterExpressions(node, OEK.Assertions | OEK.Parentheses);
  return (
    n.kind === K.PropertyAccessExpression ||
    n.kind === K.ElementAccessExpression
  );
}

export class Analyzer {
  readonly c: Own;
  nextRegion = 0;
  readonly results = new Map<Node, FunctionResult>();
  readonly reported = new Map<Node, Set<number>>();
  readonly shared = new Map<TsSymbol, boolean>();
  readonly captures = new Map<Node, Captures>();
  readonly loopFresh = new Map<Node, Set<TsSymbol>>();
  readonly primitiveOrShared = new Map<Type, boolean>();
  readonly blockScoped = new Map<Node, Set<number>>();
  readonly namesTheirClass = new Map<Node, boolean>();
  readonly idOf: (symbol: TsSymbol) => number;

  constructor(c: Own) {
    this.c = c;
    this.idOf = symbol => c.host.symbolId(symbol);
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

  // Reports whether an operator converts a value of type t with no code of
  // its own and no error: a number, a string, a boolean, null or undefined
  // (an i32's brand aside), not a bigint, which mixes with nothing else, a
  // symbol, an object or what may be any of them.
  isPlainPrimitive(t: Type): boolean {
    const plain =
      TypeFlags.NumberLike |
      TypeFlags.StringLike |
      TypeFlags.BooleanLike |
      TypeFlags.Null |
      TypeFlags.Undefined |
      TypeFlags.Void;
    if (t.flags & TypeFlags.Union)
      return this.c.host.memberTypes(t).every(m => this.isPlainPrimitive(m));
    if (t.flags & TypeFlags.Intersection)
      return this.c.host
        .memberTypes(t)
        .some(m => !!(m.flags & (TypeFlags.NumberLike | TypeFlags.StringLike)));
    return !!(t.flags & plain);
  }

  // The variables a try statement's block and catch declare with `let` ,
  // `const` , `class` or as the catch's, by symbol id: none is in scope in its
  // finally (not inside the functions they hold, analyzed on their own).
  blockScopedIn(node: Node): Set<number> {
    let ids = this.blockScoped.get(node);
    if (ids) return ids;
    const found = new Set<number>();
    ids = found;
    const add = (decl: Node) => {
      const symbol = this.c.host.symbolOfDeclaration(decl);
      if (symbol) found.add(this.idOf(symbol));
    };
    const names = (name: Node | undefined): void => {
      if (!name) return;
      if (name.kind === K.Identifier) return;
      if (isBindingPattern(name))
        for (const element of name.elements as Node[])
          if (element.kind === K.BindingElement) {
            add(element);
            names(element.name);
          }
    };
    const visit = (n: Node): boolean => {
      if (isFunctionLike(n)) return false;
      if (
        n.kind === K.VariableDeclaration &&
        (n.parent as Node).flags & NodeFlags.BlockScoped
      ) {
        add(n);
        names(n.name);
      } else if (n.kind === K.ClassDeclaration) add(n);
      forEachChild(n, visit);
      return false;
    };
    visit(node.tryBlock);
    const clause = node.catchClause as Node | undefined;
    if (clause) {
      const decl = clause.variableDeclaration as Node | undefined;
      if (decl) {
        add(decl);
        names(decl.name);
      }
      visit(clause.block);
    }
    this.blockScoped.set(node, ids);
    return ids;
  }

  analyzeFunction(node: Node): FunctionResult {
    const existing = this.results.get(node);
    if (existing) return existing;
    const r: FunctionResult = {returnsFresh: true};
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

  report(
    node: Node,
    kind: number,
    at: Node,
    message: Message,
    ...args: (string | number)[]
  ): boolean {
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

  reportUseAfterSend(
    node: Node,
    name: string,
    send: Send,
    maybe: boolean,
  ): void {
    const line = lineOf(send.site);
    if (send.consume && send.via === name) {
      this.report(
        node,
        ReportKind.Use,
        node,
        maybe ? Messages.MaybeConsumed : Messages.Consumed,
        name,
        send.callee,
        line,
      );
    } else if (send.via === name) {
      this.report(
        node,
        ReportKind.Use,
        node,
        maybe ? Messages.MaybeUsedAfterSend : Messages.UsedAfterSend,
        name,
        send.callee,
        line,
      );
    } else {
      this.report(
        node,
        ReportKind.Use,
        node,
        maybe ? Messages.SharesWithMaybeSent : Messages.SharesWithSent,
        name,
        send.via,
        send.callee,
        line,
      );
    }
  }

  // Symbols, declarations and type nodes

  // Resolves an identifier in an expression.
  symbolOfIdentifier(id: Node): TsSymbol | undefined {
    return this.c.host.resolvedSymbol(id);
  }

  // A declaration node, unless it is in a default library file: those never use
  // the markers, so every question about their type nodes has the answer of a
  // missing one.
  declarationOutsideLibrary(handle: NodeHandle | undefined): Node | undefined {
    if (!handle || this.c.host.isDefaultLibraryPath(handle.path))
      return undefined;
    return this.c.host.declarationOf(handle);
  }

  // Reports whether a symbol is declared in the function (or file, for
  // top-level code) `owner` .
  isLocalTo(symbol: TsSymbol, owner: Node): boolean {
    if (symbol.flags & SymbolFlags.Alias) return false;
    const handle = symbol.valueDeclaration ?? symbol.declarations[0];
    if (!handle || handle.path !== owner.getSourceFile().path) return false;
    const decl = this.c.host.declarationOf(handle);
    return !!decl && ownerOf(decl) === owner;
  }

  // Binds a value to a variable, making it shared if the variable is declared
  // shared (or is a primitive).
  normalize(symbol: TsSymbol, v: Value): Value {
    return v.kind === ValueKind.InRegion && this.isSharedSymbol(symbol)
      ? sharedValue
      : v;
  }

  // Reports whether a symbol's value is shared regardless of the program point:
  // code, library values, cells, variables declared `Shared<T>` and variables
  // of primitive types.
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
    // A module's own exported declarations resolve, inside the module, to a
    // local symbol that only stands for the export: what it is (a function, a
    // class) is on the exported symbol.
    let target: TsSymbol | undefined = host.exportSymbolIfExported(symbol);
    if (target.flags & SymbolFlags.Alias) {
      target = host.resolveAlias(target);
      if (!target) return true;
    }
    if (
      target.flags &
        (SymbolFlags.Function |
          SymbolFlags.Class |
          SymbolFlags.Enum |
          SymbolFlags.ValueModule |
          SymbolFlags.Method) &&
      !(target.flags & SymbolFlags.Variable)
    ) {
      return true;
    }
    if (target.declarations.length === 0) return false;
    if (target.declarations.every(d => host.isDefaultLibraryPath(d.path)))
      return true;
    if (this.isDeclaredShared(target)) return true;
    const t = host.typeOfSymbol(target);
    if (this.isCountedType(t)) return false; // tracked in a counted region
    return this.isPrimitiveOrSharedStructType(t);
  }

  // Reports whether a variable, parameter or property is declared with a
  // `Shared<T>` type, or is a `const` initialized with a shared value.
  isDeclaredShared(symbol: TsSymbol): boolean {
    const handle = symbol.valueDeclaration;
    if (!handle) return false;
    switch (handle.kind) {
      case K.Parameter:
      case K.PropertySignature:
      case K.PropertyDeclaration:
      case K.VariableDeclaration:
        break;
      default:
        return false;
    }
    const decl = this.declarationOutsideLibrary(handle);
    if (!decl) return false;
    switch (decl.kind) {
      case K.Parameter:
        return this.isSharedTypeNode(this.parameterTypeNode(decl));
      case K.PropertySignature:
      case K.PropertyDeclaration:
        return this.isSharedTypeNode(decl.type);
      case K.VariableDeclaration:
        if (decl.type) return this.isSharedTypeNode(decl.type);
        if (decl.initializer && getCombinedNodeFlags(decl) & NodeFlags.Const)
          return this.isStaticallyShared(decl.initializer);
    }
    return false;
  }

  // Reports whether an expression's value is shared on every path, using
  // declarations only.
  isStaticallyShared(expr: Node): boolean {
    expr = skipOuterExpressions(expr, OEK.All);
    switch (expr.kind) {
      case K.NumericLiteral:
      case K.BigIntLiteral:
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
      case K.TemplateExpression:
      case K.TrueKeyword:
      case K.FalseKeyword:
      case K.NullKeyword:
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
      case K.CallExpression:
      case K.NewExpression:
        return (
          this.returnKind(this.signatureDeclarationOf(expr)) ===
          ReturnKind.Shared
        );
    }
    return false;
  }

  // The declaration of the signature a call or `new` resolves to (outside the
  // default library).
  signatureDeclarationOf(call: Node): Node | undefined {
    return this.declarationOutsideLibrary(
      this.c.host.signatureOf(call).declaration,
    );
  }

  // Reports whether the elements of an array-typed expression are declared
  // shared, as in `xs: Shared<T>[]` .
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
          if (
            name.kind === K.Identifier &&
            (name.text === 'Array' || name.text === 'ReadonlyArray')
          )
            return this.isSharedTypeNode(args[0]);
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
        const decl =
          symbol && this.declarationOutsideLibrary(symbol.valueDeclaration);
        if (!decl) return undefined;
        switch (decl.kind) {
          case K.Parameter:
            return this.parameterTypeNode(decl);
          case K.VariableDeclaration:
          case K.PropertyDeclaration:
          case K.PropertySignature:
            return decl.type;
        }
        return undefined;
      }
      case K.PropertyAccessExpression: {
        const prop = host.symbolAt(expr.name);
        const handle = prop?.valueDeclaration;
        if (
          handle &&
          (handle.kind === K.PropertyDeclaration ||
            handle.kind === K.PropertySignature)
        ) {
          return this.declarationOutsideLibrary(handle)?.type;
        }
        return undefined;
      }
      case K.CallExpression:
      case K.NewExpression: {
        const decl = this.signatureDeclarationOf(expr);
        return decl && isFunctionLike(decl) ? decl.type : undefined;
      }
      case K.ElementAccessExpression: {
        const t = this.resolveTypeNode(
          this.declaredTypeNodeOf(expr.expression),
        );
        return t?.kind === K.ArrayType ? t.elementType : undefined;
      }
    }
    return undefined;
  }

  // The element value of iterating over a value.
  elementValue(iterable: Node, v: Value): Value {
    return v.kind !== ValueKind.InRegion ||
      this.isElementDeclaredShared(iterable)
      ? sharedValue
      : v;
  }

  // Skips parentheses and `readonly` , and follows type aliases (a few levels
  // deep).
  resolveTypeNode(t: Node | undefined): Node | undefined {
    for (let i = 0; i < 5; i++) {
      if (!t) return undefined;
      while (
        t.kind === K.ParenthesizedType ||
        (t.kind === K.TypeOperator && t.operator === K.ReadonlyKeyword)
      )
        t = t.type as Node;
      if (t.kind !== K.TypeReference || getTypeMarker(this.c, t) !== '') {
        // `Sending<T>` and `Shared<T>` are aliases of T: keep the marker
        return t;
      }
      const symbol = this.c.host.symbolAt(t.typeName);
      if (!symbol || !(symbol.flags & SymbolFlags.TypeAlias)) return t;
      const handle = symbol.declarations.find(
        d => d.kind === K.TypeAliasDeclaration,
      );
      // The default library's aliases (Record, Readonly...) never lead to a
      // marker: stop there.
      if (!handle || this.c.host.isDefaultLibraryPath(handle.path)) return t;
      const decl = this.c.host.declarationOf(handle);
      if (!decl) return t;
      t = decl.type as Node;
    }
    return t;
  }

  // `Shared<T>` , possibly behind parentheses, `readonly` or an alias, or a
  // union of such types with null and undefined.
  isSharedTypeNode(t: Node | undefined): boolean {
    t = this.resolveTypeNode(t);
    if (!t) return false;
    switch (t.kind) {
      case K.TypeReference:
        return getTypeMarker(this.c, t) === 'Shared';
      case K.UnionType: {
        let sawShared = false;
        for (const member of t.types as Node[]) {
          const m = this.resolveTypeNode(member)!;
          if (
            m.kind === K.UndefinedKeyword ||
            m.kind === K.NullKeyword ||
            (m.kind === K.LiteralType && m.literal.kind === K.NullKeyword)
          ) {
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
    return !!t && getTypeMarker(this.c, t) === 'Sending';
  }

  // The T of `Sending<T>` or `Shared<T>`.
  markedTypeOperand(t: Node | undefined): Node | undefined {
    t = this.resolveTypeNode(t);
    if (t?.kind === K.TypeReference && t.typeArguments?.length === 1)
      return t.typeArguments[0];
    return undefined;
  }

  // The declared type of a parameter, or the type of the corresponding
  // parameter of the contextual signature for an unannotated parameter of a
  // function expression.
  parameterTypeNode(p: Node): Node | undefined {
    if (p.type) return p.type;
    const fn = p.parent as Node | undefined;
    if (
      !fn ||
      !(isFunctionExpressionOrArrowFunction(fn) || isObjectLiteralMethod(fn))
    )
      return undefined;
    const signature = this.c.host.contextualSignature(fn);
    if (!signature) return undefined;
    const index = signatureParameters(fn).lastIndexOf(p);
    return parameterAt(
      signatureParameters(
        this.declarationOutsideLibrary(signature.declaration),
      ),
      index,
    )?.type;
  }

  returnKind(decl: Node | undefined): ReturnKind {
    if (!decl || !isFunctionLike(decl)) return ReturnKind.Ordinary;
    const t = this.unwrapPromiseTypeNode(decl.type as Node | undefined);
    if (!t) return ReturnKind.Ordinary;
    if (this.isSendingTypeNode(t)) return ReturnKind.Sending;
    const resolved = this.resolveTypeNode(t);
    if (
      resolved?.kind === K.UnionType &&
      (resolved.types as Node[]).some(m => this.isSendingTypeNode(m))
    ) {
      // `Sending<T> | undefined`, as a channel's `recv()` returns.
      return ReturnKind.Sending;
    }
    if (this.isSharedTypeNode(t)) return ReturnKind.Shared;
    return ReturnKind.Ordinary;
  }

  // The X of a result type `Promise<X>` , which an async function's returns
  // resolve; any other type itself. A result `Promise<Sending<T>>` hands over
  // ownership as `Sending<T>` does (`recvAsync()`, `joinAsync()` ).
  unwrapPromiseTypeNode(t: Node | undefined): Node | undefined {
    const r = this.resolveTypeNode(t);
    if (
      r?.kind === K.TypeReference &&
      r.typeArguments?.length === 1 &&
      r.typeName.kind === K.Identifier &&
      r.typeName.text === 'Promise'
    ) {
      return r.typeArguments[0];
    }
    return t;
  }

  returnsSending(fn: Node): boolean {
    if (fn.type)
      return this.isSendingTypeNode(this.unwrapPromiseTypeNode(fn.type));
    if (isFunctionExpressionOrArrowFunction(fn) || isObjectLiteralMethod(fn)) {
      const signature: Signature | undefined =
        this.c.host.contextualSignature(fn);
      if (signature)
        return (
          this.returnKind(
            this.declarationOutsideLibrary(signature.declaration),
          ) === ReturnKind.Sending
        );
    }
    return false;
  }

  // A share-like signature `<T>(x: Sending<T>) => Shared<T>` turns its argument
  // into a shared value; the argument is then reported as consumed rather than
  // sent.
  isConsumingSignature(decl: Node | undefined): boolean {
    if (!decl || this.returnKind(decl) !== ReturnKind.Shared) return false;
    const result = typeParameterName(decl, this.markedTypeOperand(decl.type));
    if (result === '') return false;
    for (const p of signatureParameters(decl)) {
      if (
        p.type &&
        this.isSendingTypeNode(p.type) &&
        typeParameterName(decl, this.markedTypeOperand(p.type)) === result
      )
        return true;
    }
    return false;
  }

  // Reports whether a signature is Array.prototype.map or flatMap (or the
  // ReadonlyArray versions) from the default library.
  isLibArrayMethod(handle: NodeHandle | undefined): boolean {
    if (!handle || !this.c.host.isDefaultLibraryPath(handle.path)) return false;
    const decl = this.c.host.declarationOf(handle);
    const parent = decl?.parent as Node | undefined;
    if (!parent || parent.kind !== K.InterfaceDeclaration) return false;
    return parent.name.text === 'Array' || parent.name.text === 'ReadonlyArray';
  }

  isArrayExpression(expr: Node): boolean {
    const t = this.typeOf(expr);
    return (
      this.c.host.checker.isArrayType(t) || this.c.host.checker.isTupleType(t)
    );
  }

  // Reports whether an expression is a shared value in the sense of the
  // extension, which is immutable: it must be declared shared (a variable,
  // parameter or member declared `Shared<T>` , a call returning `Shared<T>` ,
  // or something read out of such a value).
  isImmutableShared(expr: Node): boolean {
    return (
      !this.isPrimitiveOrSharedStructType(this.typeOf(expr)) &&
      this.isDeclaredSharedExpression(expr)
    );
  }

  isDeclaredSharedExpression(expr: Node): boolean {
    expr = skipOuterExpressions(expr, OEK.All);
    switch (expr.kind) {
      case K.Identifier: {
        let symbol = this.symbolOfIdentifier(expr);
        if (!symbol) return false;
        if (symbol.flags & SymbolFlags.Alias)
          symbol = this.c.host.resolveAlias(symbol);
        if (!symbol) return false;
        if (this.isDeclaredShared(symbol)) return true;
        // `for (const x of xs)` where xs is shared or has shared elements.
        const handle = symbol.valueDeclaration;
        if (handle?.kind === K.VariableDeclaration) {
          const decl = this.declarationOutsideLibrary(handle);
          const list = decl?.parent as Node | undefined;
          if (
            list?.kind === K.VariableDeclarationList &&
            list.parent?.kind === K.ForOfStatement
          ) {
            const iterable = (list.parent as Node).expression as Node;
            return (
              this.isDeclaredSharedExpression(iterable) ||
              this.isElementDeclaredShared(iterable)
            );
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
        return (
          this.isDeclaredSharedExpression(expr.expression) ||
          this.isElementDeclaredShared(expr.expression)
        );
      case K.CallExpression:
      case K.NewExpression:
        return (
          this.returnKind(this.signatureDeclarationOf(expr)) ===
          ReturnKind.Shared
        );
    }
    return false;
  }

  isPrimitiveOrSharedStructType(t: Type | undefined): boolean {
    if (!t) return false;
    let result = this.primitiveOrShared.get(t);
    if (result !== undefined) return result;
    if (t.flags & TypeFlags.Union) {
      result = this.c.host
        .memberTypes(t)
        .every(m => this.isPrimitiveOrSharedStructType(m));
    } else {
      // SharedArrays are cells in the shared heap, like shared structs, and so
      // is every Cell of the plain API.
      result =
        !!(t.flags & (TypeFlags.Primitive | TypeFlags.Never)) ||
        getSharedArrayElementType(this.c, t) !== undefined ||
        isCellBranded(this.c, t);
    }
    this.primitiveOrShared.set(t, result);
    return result;
  }

  // Closure captures

  capturesOf(fn: Node): Captures {
    const existing = this.captures.get(fn);
    if (existing) return existing;
    const captures: Captures = {symbols: [], nodes: [], usesThis: false};
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
        if (
          handle &&
          (handle.path !== path ||
            !isWithin(this.c.host.declarationOf(handle), fn))
        ) {
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
      if (node !== fn && isFunctionBody(node))
        childInArrow = inArrow && node.kind === K.ArrowFunction;
      forEachChild(node, child => {
        visit(child, childInArrow);
      });
    };
    if (fn.kind === K.ClassDeclaration || fn.kind === K.ClassExpression) {
      // what runs as the class is defined (its heritage, decorators, computed
      // keys, static fields and blocks) is evaluated there, not captured:
      // only its methods, accessors, constructor and instance fields are
      for (const m of fn.members as Node[]) {
        const isStatic = ((m.modifiers ?? []) as Node[]).some(
          x => x.kind === K.StaticKeyword,
        );
        if (m.kind === K.ClassStaticBlockDeclaration) continue;
        if (m.kind === K.PropertyDeclaration && isStatic) continue;
        for (const p of (m.parameters ?? []) as Node[])
          forEachChild(p, child => {
            if (child.kind !== K.Decorator) visit(child, false);
          });
        if (m.body) visit(m.body, false);
        if (m.initializer) visit(m.initializer, false);
      }
      return captures;
    }
    forEachChild(fn, child => {
      visit(child, fn.kind === K.ArrowFunction);
    });
    return captures;
  }

  // Reports whether a class's instance code (its methods, accessors,
  // constructor and instance fields) reaches the class itself: by its name,
  // `this.constructor` or `new.target` .
  instancesReachTheirClass(cls: Node): boolean {
    let result = this.namesTheirClass.get(cls);
    if (result !== undefined) return result;
    const self = this.c.host.symbolOfDeclaration(cls);
    const id = self && this.idOf(self);
    let found = false;
    const visit = (node: Node): boolean => {
      if (found || isTypeNode(node)) return found;
      if (
        (node.kind === K.MetaProperty && node.keywordToken === K.NewKeyword) ||
        ((node.kind === K.PropertyAccessExpression
          ? node.name.text === 'constructor'
          : node.kind === K.ElementAccessExpression &&
            (node.argumentExpression.kind === K.StringLiteral ||
              node.argumentExpression.kind ===
                K.NoSubstitutionTemplateLiteral) &&
            node.argumentExpression.text === 'constructor') &&
          skipOuterExpressions(node.expression as Node, OEK.All).kind ===
            K.ThisKeyword)
      ) {
        found = true;
        return found;
      }
      if (node.kind === K.Identifier && isOwnValueReference(node)) {
        const symbol = this.symbolOfIdentifier(node);
        if (symbol && id !== undefined && this.idOf(symbol) === id)
          found = true;
        return found;
      }
      forEachChild(node, visit);
      return found;
    };
    for (const m of cls.members as Node[]) {
      const isStatic = ((m.modifiers ?? []) as Node[]).some(
        x => x.kind === K.StaticKeyword,
      );
      if (m.kind === K.ClassStaticBlockDeclaration || isStatic) continue;
      for (const part of [
        ...((m.parameters ?? []) as Node[]),
        m.body,
        m.initializer,
      ] as (Node | undefined)[])
        if (part) visit(part);
    }
    result = found;
    this.namesTheirClass.set(cls, result);
    return result;
  }

  // The variables with a fresh binding in each iteration of a loop: those its
  // body declares with `let` or `const` (catch clause variables included),
  // outside the functions and classes in it.
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
          if (element.kind === K.BindingElement)
            bindName(element.name, element);
        }
      }
    };
    const visit = (node: Node): boolean => {
      if (isTypeNode(node) || isFunctionLike(node) || isClassLike(node))
        return false;
      if (node.kind === K.VariableDeclaration) {
        const parent = node.parent as Node;
        if (
          parent.kind === K.CatchClause ||
          parent.flags & NodeFlags.BlockScoped
        )
          bindName(node.name, node);
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
  readonly tries: TryContext[] = [];
  readonly cleanups: Cleanup[] = [];
  // the classes defined in the function, by the region of their values, and
  // the values they extend
  readonly classes: {region: Region; node: Node}[] = [];
  readonly bases = new Map<Node, Value>();
  // what each class's code captured as it was created: the variables, where,
  // and the regions they held then (a binding may go before the class does)
  readonly captured = new Map<
    Node,
    {symbol: TsSymbol; at: Node; region: Region}[]
  >();
  // the region of what each class's prototype holds, which its instances
  // all reach
  readonly prototypes = new Map<Node, Region>();
  // the regions of what the for-of loops being analyzed iterate, which they
  // hold outside any binding
  readonly iterating: Region[] = [];
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
      case K.Block: {
        // a `using` declaration's value is disposed of as the block is left,
        // which may throw: as it ends, or as a jump leaves it (see exit)
        const disposes = (node.statements as Node[]).some(isUsingDeclaration);
        if (disposes)
          this.cleanups.push({
            targets: this.targets.length,
            loop: false,
            tries: this.tries.length,
            held: false,
            node,
          });
        this.statements(node.statements, s);
        if (disposes) {
          this.cleanups.pop();
          if (!s.unreachable) this.mayThrow(s);
        }
        break;
      }
      case K.ClassDeclaration: {
        // analyzed on its own, but defined here: its heritage, computed keys,
        // decorators and static members are evaluated as it is; its name
        // holds the class from here, with what its static fields hold
        const closure = this.closureValue(node, s);
        this.recordCaptures(node, s);
        const cls: Value =
          closure.kind === ValueKind.InRegion
            ? {...closure, ctors: [node]}
            : closure;
        if (cls.kind === ValueKind.InRegion)
          this.classes.push({region: cls.region, node});
        const symbol = this.a.c.host.symbolOfDeclaration(node);
        if (symbol) s.vars.set(symbol, cls);
        this.evalClassDefinition(node, s, cls);
        break;
      }
      case K.EnumDeclaration:
        // its members' values are evaluated, in order, as it is defined
        for (const member of node.members as Node[])
          if (member.initializer) this.eval(member.initializer, s);
        break;
      case K.VariableStatement: {
        this.variableDeclarationList(node.declarationList, s);
        // from here on, its block has something to dispose of
        const scope = this.cleanups.at(-1);
        if (scope?.node === node.parent && isUsingDeclaration(node))
          scope.held = true;
        break;
      }
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
        // out through the innermost try's finally first (see TryContext)
        this.exit({st: s.copy(), to: undefined, isBreak: false});
        s.unreachable = true;
        break;
      case K.ThrowStatement:
        this.eval(node.expression, s);
        this.mayThrow(s);
        s.unreachable = true;
        break;
      case K.WhileStatement:
      case K.DoStatement:
      case K.ForStatement:
      case K.ForInStatement:
      case K.ForOfStatement:
        this.loop(node, [], s);
        break;
      case K.LabeledStatement:
        this.labeledStatement(node, s);
        break;
      case K.BreakStatement:
      case K.ContinueStatement:
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
    // Function and class declarations are analyzed on their own; the closures
    // they create are accounted for where they are referenced. Type
    // declarations, imports and the like have no effect.
  }

  variableDeclarationList(list: Node, s: State): void {
    const using = isUsingList(list);
    for (const decl of list.declarations as Node[]) {
      let v = sharedValue;
      if (decl.initializer) v = this.eval(decl.initializer, s);
      // a `using` declaration gets its value's dispose method, which may throw
      if (using) this.mayThrow(s);
      this.bindName(
        decl.name,
        decl,
        v,
        s,
        decl.initializer && this.wholePart(this.a.typeOf(decl.initializer)),
      );
    }
  }

  // Binds the names declared by a variable, parameter or binding element. Every
  // name in a binding pattern is bound to the region of the destructured value.
  // source: the type of what is bound, where it is known (an object pattern
  // rejects null and undefined before its first computed key)
  bindName(
    name: Node | undefined,
    decl: Node,
    v: Value,
    s: State,
    part?: Part,
  ): void {
    if (!name) return;
    if (name.kind === K.Identifier) {
      const symbol = this.a.c.host.symbolOfDeclaration(decl);
      if (symbol) s.vars.set(symbol, this.a.normalize(symbol, v));
      return;
    }
    if (isBindingPattern(name)) {
      // each property read, or step of the iterator, may throw, after the
      // defaults before it ran; an array pattern then closes its iterator
      const elements = name.elements as Node[];
      if (
        elements.length === 0 ||
        (name.kind === K.ObjectBindingPattern && part?.nullable)
      )
        this.mayThrow(s);
      elements.forEach((element, index) => {
        if (element.propertyName?.kind === K.ComputedPropertyName)
          this.eval(element.propertyName.expression, s);
        this.mayThrow(s);
        if (element.kind !== K.BindingElement) return;
        let ev = v;
        if (element.initializer)
          ev = s.mergeValues(ev, this.eval(element.initializer, s));
        const key =
          name.kind === K.ArrayBindingPattern
            ? index
            : keyOf((element.propertyName ?? element.name) as Node);
        this.bindName(
          element.name,
          element,
          ev,
          s,
          element.dotDotDotToken
            ? {nullable: false}
            : this.partOf(part, key, element.initializer),
        );
      });
      if (name.kind === K.ArrayBindingPattern) this.mayThrow(s);
    }
  }

  labeledStatement(node: Node, s: State): void {
    const labels: string[] = [];
    while (node.kind === K.LabeledStatement) {
      labels.push(node.label.text);
      node = node.statement;
    }
    switch (node.kind) {
      case K.WhileStatement:
      case K.DoStatement:
      case K.ForStatement:
      case K.ForInStatement:
      case K.ForOfStatement:
        this.loop(node, labels, s);
        return;
    }
    const t: Target = {
      labels,
      isLoop: false,
      isSwitch: false,
      breaks: [],
      continues: [],
      tries: this.tries.length,
    };
    this.targets.push(t);
    this.statement(node, s);
    this.targets.pop();
    s.assign(joinAllStates(s, t.breaks));
  }

  jump(node: Node, s: State): void {
    const isBreak = node.kind === K.BreakStatement;
    const label: string = node.label ? node.label.text : '';
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i]!;
      if (label !== '') {
        if (!t.labels.includes(label)) continue;
      } else if (isBreak) {
        if (!t.isLoop && !t.isSwitch) continue;
      } else if (!t.isLoop) {
        continue;
      }
      this.exit({st: s.copy(), to: t, isBreak});
      break;
    }
    s.unreachable = true;
  }

  // Loops are iterated until the state at the head stops changing, so that a
  // send in one iteration is seen by the uses in the next.
  loop(node: Node, labels: string[], s: State): void {
    const a = this.a;
    let iterated = sharedValue;
    // a for-of over a channel of counted values: each iteration receives a
    // fresh one
    let receives = false;
    switch (node.kind) {
      case K.ForStatement:
        if (node.initializer) {
          if (node.initializer.kind === K.VariableDeclarationList)
            this.variableDeclarationList(node.initializer, s);
          else this.eval(node.initializer, s);
        }
        break;
      case K.ForOfStatement:
        iterated = a.elementValue(
          node.expression,
          this.eval(node.expression, s),
        );
        receives = a.isCountedType(
          getChannelElementType(a.c, a.typeOf(node.expression)),
        );
        break;
      case K.ForInStatement:
        this.eval(node.expression, s);
        iterated = sharedValue; // property names
        break;
    }
    // Each iteration has fresh bindings of the variables the loop's body
    // declares with `let` or `const` : what an earlier iteration did with them
    // must not flow into the next one.
    const fresh = a.loopBindings(node);
    let head = s.copy();
    for (const symbol of fresh) head.vars.delete(symbol);
    let headSignature = head.signature(a.idOf);
    let exit: State = State.unreachable();
    let breaks: State[] = [];
    // a for-of loop left early closes its iterator (see exit); what it
    // iterates it holds till it ends
    const closes = node.kind === K.ForOfStatement;
    const holds = iterated.kind === ValueKind.InRegion;
    if (holds) this.iterating.push(iterated.region);
    if (closes)
      this.cleanups.push({
        targets: this.targets.length,
        loop: true,
        tries: this.tries.length,
        held: true,
        node,
      });
    for (let iteration = 0; iteration < maxLoopIterations; iteration++) {
      let st = head.copy();
      const t: Target = {
        labels,
        isLoop: true,
        isSwitch: false,
        breaks: [],
        continues: [],
        tries: this.tries.length,
      };
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
          if (node.incrementor && !st.unreachable)
            this.eval(node.incrementor, st);
          break;
        case K.ForInStatement:
        case K.ForOfStatement: {
          exit = st.copy();
          this.mayThrow(st); // the next value is taken
          const value = receives
            ? regionValue(a.newRegionOf(true, st))
            : iterated;
          if (node.initializer.kind === K.VariableDeclarationList) {
            for (const decl of node.initializer.declarations as Node[])
              this.bindName(decl.name, decl, value, st);
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
    if (closes) this.cleanups.pop();
    if (holds) this.iterating.pop();
    s.assign(joinAllStates(exit, breaks));
  }

  switchStatement(node: Node, s: State): void {
    this.eval(node.expression, s);
    const t: Target = {
      labels: [],
      isLoop: false,
      isSwitch: true,
      breaks: [],
      continues: [],
      tries: this.tries.length,
    };
    this.targets.push(t);
    const afterExpression = s.copy();
    let current = State.unreachable();
    let hasDefault = false;
    for (const clause of node.caseBlock.clauses as Node[]) {
      // falls through from the previous clause
      const entry = joinStates(afterExpression, current);
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

  // a throw may leave from here: to the innermost try's catch, or out through
  // its finally (see TryContext)
  mayThrow(s: State): void {
    const t = this.tries.at(-1);
    if (t) (t.catches ? t.caught : t.thrown).push(s.copy());
  }

  // an early exit goes out through the finally of the innermost try it
  // leaves, if any, else on to its target (see TryContext)
  exit(e: Exit): void {
    const to = e.to;
    // the scopes it leaves that clean up, innermost first, once it has gone
    // through the tries inside them (their finallies have run): each may
    // throw, to the try around it
    const at = to === undefined ? -1 : this.targets.indexOf(to);
    for (let k = this.cleanups.length - 1; k >= 0; k--) {
      const c = this.cleanups[k]!;
      const leaves =
        to === undefined ||
        at < c.targets ||
        (c.loop && at === c.targets && e.isBreak);
      if (!leaves || c.tries < this.tries.length) break;
      if (c.held) this.mayThrow(e.st);
    }
    if (to === undefined || this.tries.length > to.tries)
      this.tries.at(-1)?.exits.push(e);
    else (e.isBreak ? to.breaks : to.continues).push(e.st);
  }

  tryStatement(node: Node, s: State): void {
    const entry = s.copy();
    const t: TryContext = {
      catches: !!node.catchClause,
      caught: [],
      thrown: [],
      exits: [],
    };
    this.tries.push(t);
    this.statement(node.tryBlock, s);
    // the block's early exits: its catch starts from the throws it takes,
    // each where it may come (after a send that the block's end, unreachable
    // perhaps, does not show)
    const blockCaught = t.caught,
      blockThrown = t.thrown,
      blockExits = t.exits;
    t.caught = [];
    t.thrown = [];
    t.exits = [];
    t.catches = false; // a throw in the catch goes to the finally
    let after = s;
    if (node.catchClause) {
      const catchClause = node.catchClause as Node;
      const cs = joinAllStates(joinStates(entry, s), blockCaught);
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
    this.tries.pop();
    const outer = this.tries.at(-1);
    // what leaves the try early (the throws its catch took went through it)
    const thrown = [...blockThrown, ...t.thrown],
      exits = [...blockExits, ...t.exits];
    const throwOn = (st: State) => {
      if (outer) (outer.catches ? outer.caught : outer.thrown).push(st);
    };
    if (node.finallyBlock) {
      // the finally once as the try completes normally, from the end of its
      // block or its catch, which goes on after it; and once more for the
      // throws and for each place the early exits go to, which do not: those
      // runs report what they reach, and what of them is still reachable (a
      // finally may return or throw instead) goes on to the next try out, or
      // to its target. A run that starts from the very state another did (the
      // same bindings, regions and infos, not alike only up to renaming them)
      // ends, reports and jumps as that one did, which went on already: the
      // finally is analyzed once for both, so finallies nested in finallies
      // are not analyzed exponentially often
      const runs: {start: State; end: State}[] = [];
      // what the try's blocks declare is out of scope in the finally, and
      // after: no run keeps it, and none differs from another by it
      const local = this.a.blockScopedIn(node);
      const run = (early: State[]) => {
        const start = joinAllStates(early[0]!, early.slice(1));
        for (const symbol of start.vars.keys())
          if (local.has(this.a.idOf(symbol))) start.vars.delete(symbol);
        // and the regions only they held go with them (not `this` , nor
        // what a loop iterates), unless an expression being evaluated may
        // hold one
        if (this.evaluating === 0)
          start.collect([
            ...(this.thisRegion === 0 ? [] : [this.thisRegion]),
            ...this.iterating,
            // what classes captured as they were created, and their
            // prototypes, which their instances reach
            ...[...this.captured.values()].flatMap(c => c.map(e => e.region)),
            ...this.prototypes.values(),
          ]);
        const done = runs.find(r => r.start.sameAs(start));
        if (done) return done.end.copy();
        const input = start.copy();
        this.statement(node.finallyBlock, start);
        runs.push({start: input, end: start.copy()});
        return start;
      };
      if (!after.unreachable) after = run([after]);
      if (thrown.length > 0) {
        const fe = run(thrown);
        if (!fe.unreachable) throwOn(fe);
      }
      const groups: Exit[][] = [];
      for (const e of exits) {
        const g = groups.find(
          g => g[0]!.to === e.to && g[0]!.isBreak === e.isBreak,
        );
        if (g) g.push(e);
        else groups.push([e]);
      }
      for (const g of groups) {
        const fe = run(g.map(e => e.st));
        if (!fe.unreachable)
          this.exit({st: fe, to: g[0]!.to, isBreak: g[0]!.isBreak});
      }
    } else {
      // no finally: the early exits go on out as they are
      for (const st of thrown) throwOn(st);
      for (const e of exits) this.exit(e);
    }
    if (after !== s) s.assign(after);
  }

  checkReturn(expr: Node, v: Value, s: State): void {
    if (v.kind !== ValueKind.InRegion) return;
    const [, inf] = s.root(v);
    const borrowed =
      (inf.flags & (RegionFlags.Caller | RegionFlags.Outer)) !== 0;
    if (borrowed || inf.sent) this.result.returnsFresh = false;
    if (this.returnsSending && borrowed) {
      this.a.report(
        expr,
        ReportKind.Return,
        expr,
        Messages.ReturnSendingCallerReferenced,
        expressionName(expr),
      );
    }
  }

  // Expressions

  // How many expressions are being evaluated: one may hold regions outside
  // any binding (an assignment's object while its value is made, a call's
  // receiver and arguments), so no state is collected while one is (a class
  // expression's static block may run a finally).
  evaluating = 0;

  eval(node: Node | undefined, s: State): Value {
    this.evaluating++;
    try {
      return this.evalExpression(node, s);
    } finally {
      this.evaluating--;
    }
  }

  evalExpression(node: Node | undefined, s: State): Value {
    if (!node) return sharedValue;
    const a = this.a;
    switch (node.kind) {
      case K.Identifier:
        return this.readIdentifier(node, s);
      case K.ThisKeyword:
      case K.SuperKeyword:
        return this.thisValue(s);
      case K.NumericLiteral:
      case K.BigIntLiteral:
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
      case K.TrueKeyword:
      case K.FalseKeyword:
      case K.NullKeyword:
      case K.MetaProperty:
      case K.OmittedExpression:
      case K.PrivateIdentifier:
        return sharedValue;
      case K.RegularExpressionLiteral:
        return regionValue(a.newRegion());
      case K.ParenthesizedExpression:
      case K.NonNullExpression:
      case K.AsExpression:
      case K.SatisfiesExpression:
      case K.TypeAssertionExpression:
      case K.PartiallyEmittedExpression:
        return this.eval(node.expression, s);
      case K.AwaitExpression: {
        // What a promise resolves to is in the promise's region, unless it is a
        // primitive.
        const v = this.eval(node.expression, s);
        this.mayThrow(s); // a rejection
        return a.isPrimitiveOrSharedStructType(a.typeOf(node))
          ? sharedValue
          : v;
      }
      case K.TemplateExpression:
        for (const span of node.templateSpans as Node[]) {
          this.eval(span.expression, s);
          // converted to a string before the next is made: an object's, or a
          // symbol's, may throw
          const t = a.typeOf(span.expression);
          if (!a.isPlainPrimitive(t) && !(t.flags & TypeFlags.BigIntLike))
            this.mayThrow(s);
        }
        return sharedValue;
      case K.TypeOfExpression:
      case K.VoidExpression:
        this.eval(node.expression, s);
        return sharedValue;
      case K.DeleteExpression:
        this.evalWriteTarget(node.expression, s);
        this.mayThrow(s);
        return sharedValue;
      case K.PrefixUnaryExpression:
        if (
          node.operator === K.PlusPlusToken ||
          node.operator === K.MinusMinusToken
        )
          this.evalWriteTarget(node.operand, s);
        else this.eval(node.operand, s);
        // all but `!` convert their operand to a number, which a plain
        // primitive's name does with no error (a property's may, as it is
        // read and written)
        if (
          node.operator !== K.ExclamationToken &&
          !this.convertsSafely(node.operand)
        )
          this.mayThrow(s);
        return sharedValue;
      case K.PostfixUnaryExpression:
        this.evalWriteTarget(node.operand, s);
        if (!this.convertsSafely(node.operand)) this.mayThrow(s);
        return sharedValue;
      case K.YieldExpression: {
        this.eval(node.expression, s);
        this.mayThrow(s); // the caller may throw into the generator
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
      case K.SpreadElement: {
        const v = this.eval(node.expression, s);
        this.mayThrow(s); // it is iterated
        return v;
      }
      case K.FunctionExpression:
      case K.ArrowFunction:
        return this.closureValue(node, s);
      case K.ClassExpression: {
        const closure = this.closureValue(node, s);
        this.recordCaptures(node, s);
        const v: Value =
          closure.kind === ValueKind.InRegion
            ? {...closure, ctors: [node]}
            : closure;
        if (v.kind === ValueKind.InRegion)
          this.classes.push({region: v.region, node});
        // its own name, if it has one, is the class inside it
        const symbol = node.name && this.a.c.host.symbolOfDeclaration(node);
        const outside = symbol && s.vars.get(symbol);
        if (symbol) s.vars.set(symbol, v);
        this.evalClassDefinition(node, s, v);
        if (symbol) {
          if (outside) s.vars.set(symbol, outside);
          else s.vars.delete(symbol);
        }
        return v;
      }
      case K.CallExpression: {
        // after its effects (a send), as a callee may throw; but not consume(),
        // which gives back its argument, nor import(), which rejects
        if (isConsumeCall(a.c, node))
          return this.evalConsume(node, node.arguments[0], s); // `consume(x)`
        const v = this.evalCall(node, s);
        if (node.expression.kind !== K.ImportKeyword) this.mayThrow(s);
        return v;
      }
      case K.NewExpression: {
        const v = this.evalNew(node, s);
        this.mayThrow(s);
        return v;
      }
      case K.TaggedTemplateExpression: {
        let v = this.eval(node.tag, s);
        if (node.template.kind === K.TemplateExpression) {
          for (const span of node.template.templateSpans as Node[])
            v = s.mergeValues(v, this.eval(span.expression, s));
        }
        this.mayThrow(s); // the tag is called, as a callee it may throw
        if (a.isPrimitiveOrSharedStructType(a.typeOf(node))) return sharedValue;
        return v;
      }
      case K.PropertyAccessExpression: {
        const obj = this.eval(node.expression, s);
        this.mayThrow(s); // a getter's, or of null
        return this.readMember(node, node.expression, obj, s);
      }
      case K.ElementAccessExpression: {
        const obj = this.eval(node.expression, s);
        this.eval(node.argumentExpression, s);
        this.mayThrow(s);
        return this.readMember(node, node.expression, obj, s);
      }
    }
    return this.evalChildren(node, s);
  }

  // Evaluates what defining a class evaluates, in its order: its decorators,
  // what it extends (which may be no constructor), its computed keys (which
  // are converted), then its static fields' initializers and static blocks.
  // Its methods and its instance fields' initializers run later, as closures.
  // A decorator is applied, which may throw: a member's (a parameter's
  // included) once the members are defined, a field's initializer as the field
  // is, and the class's after them, before its static fields or after them
  // as the proposal or TypeScript's older decorators have it.
  evalClassDefinition(node: Node, s: State, cls: Value): void {
    const decorators = (n: Node) =>
      ((n.modifiers ?? []) as Node[]).filter(m => m.kind === K.Decorator);
    const memberDecorators = (m: Node) => [
      ...decorators(m),
      ...((m.parameters ?? []) as Node[]).flatMap(decorators),
    ];
    const classDecorated = decorators(node).length > 0;
    for (const d of decorators(node)) this.eval(d.expression, s);
    for (const h of (node.heritageClauses ?? []) as Node[]) {
      if (h.token !== K.ExtendsKeyword) continue;
      for (const t of h.types as Node[]) {
        // what it extends it is: its static state, and what its instances
        // capture
        const base = this.eval(t.expression, s);
        this.bases.set(node, base);
        if (
          base.kind === ValueKind.InRegion &&
          !s.isCounted(base) &&
          cls.kind === ValueKind.InRegion
        )
          s.union(cls.region, base.region);
      }
      this.mayThrow(s);
    }
    const members = node.members as Node[];
    for (const m of members) {
      for (const d of memberDecorators(m)) this.eval(d.expression, s);
      if (m.name?.kind === K.ComputedPropertyName) {
        this.eval(m.name.expression, s);
        this.mayThrow(s);
      }
    }
    if (members.some(m => memberDecorators(m).length > 0)) this.mayThrow(s);
    if (classDecorated) this.mayThrow(s);
    const isStatic = (m: Node) =>
      ((m.modifiers ?? []) as Node[]).some(x => x.kind === K.StaticKeyword);
    // its static members run with the class as `this` , and what its static
    // fields are given the class holds
    const thisRegion = this.thisRegion,
      thisFlags = this.thisFlags;
    this.thisRegion =
      cls.kind === ValueKind.InRegion ? cls.region : this.a.newRegion();
    this.thisFlags = 0;
    try {
      for (const m of members) {
        if (m.kind === K.ClassStaticBlockDeclaration) this.statement(m.body, s);
        else if (m.kind === K.PropertyDeclaration && isStatic(m)) {
          if (decorators(m).length > 0) this.mayThrow(s); // its initializers
          if (m.initializer) {
            const v = this.eval(m.initializer, s);
            if (cls.kind === ValueKind.InRegion) s.mergeValues(cls, v);
          }
        }
      }
    } finally {
      this.thisRegion = thisRegion;
      this.thisFlags = thisFlags;
    }
    if (classDecorated) this.mayThrow(s);
  }

  // Fallback for expressions without a specific rule (JSX and the like): a
  // fresh region holding the regions of all subexpressions.
  evalChildren(node: Node, s: State): Value {
    const r = this.a.newRegion();
    forEachChild(node, child => {
      if (
        isTypeNode(child) ||
        (child.kind === K.Identifier && !isOwnValueReference(child))
      )
        return false;
      if (isExpression(child) || isJsxChildOrAttribute(child)) {
        const v = this.eval(child, s);
        if (v.kind === ValueKind.InRegion) s.union(r, v.region);
      } else {
        forEachChild(child, grandchild => {
          if (isExpression(grandchild) && grandchild.kind !== K.Identifier) {
            const v = this.eval(grandchild, s);
            if (v.kind === ValueKind.InRegion) s.union(r, v.region);
          }
          return false;
        });
      }
      return false;
    });
    this.mayThrow(s); // what it does is not known
    return regionValue(s.find(r));
  }

  readIdentifier(id: Node, s: State): Value {
    const symbol = this.a.symbolOfIdentifier(id);
    if (!symbol) return sharedValue;
    const v = this.lookup(symbol, s);
    if (this.checkUse(id, id.text, v, s) && v.kind === ValueKind.Consumed)
      return sharedValue;
    return v;
  }

  // The value of a variable in this function: its binding, a closure for a
  // local function declaration, or (for variables of enclosing scopes) shared
  // or an OUTER region.
  lookup(symbol: TsSymbol, s: State): Value {
    const bound = s.vars.get(symbol);
    if (bound) return bound;
    const a = this.a;
    if (a.isLocalTo(symbol, this.node)) {
      const handle = symbol.valueDeclaration;
      if (
        handle &&
        this.node.kind !== K.SourceFile &&
        (handle.kind === K.FunctionDeclaration ||
          handle.kind === K.ClassDeclaration)
      ) {
        // A nested function or class: a closure over the variables it captures.
        return this.closureValue(a.c.host.declarationOf(handle)!, s);
      }
      // Shared, or declared in this function but not initialized yet (or
      // hoisted).
      return sharedValue;
    }
    if (a.isSharedSymbol(symbol)) return sharedValue;
    const r = a.newRegionOf(a.isCountedType(a.c.host.typeOfSymbol(symbol)), s);
    s.addFlags(r, RegionFlags.Outer);
    const v = regionValue(r);
    s.vars.set(symbol, v);
    return v;
  }

  // Reports a use of a variable whose region was sent (or whose value was
  // consumed). Returns true if it reported an error.
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

  // `consume(x)` hands x's value over to the enclosing expression and ends x's
  // lifetime: later uses of x are errors. The value itself is only sent if it
  // is then passed to a `Sending` parameter.
  evalConsume(node: Node, operand: Node, s: State): Value {
    operand = skipOuterExpressions(operand, OEK.Assertions | OEK.Parentheses);
    const v = this.eval(operand, s);
    if (operand.kind === K.Identifier) {
      const symbol = this.a.symbolOfIdentifier(operand);
      if (symbol && this.a.isLocalTo(symbol, this.node)) {
        let callee = 'consume';
        const call = walkUpParenthesizedExpressions(node.parent as Node);
        if (
          call &&
          (call.kind === K.CallExpression || call.kind === K.NewExpression) &&
          call.expression !== node
        ) {
          callee = calleeName(call.expression);
        }
        const send: Send = {
          site: node,
          callee,
          via: operand.text,
          consume: true,
        };
        if (v.kind === ValueKind.InRegion)
          s.consumes = [
            ...s.consumes,
            {id: this.a.idOf(symbol), region: v.region, send},
          ];
        s.vars.set(symbol, {
          kind: ValueKind.Consumed,
          region: 0,
          consumed: send,
          maybe: false,
          origins:
            v.kind === ValueKind.InRegion
              ? [{region: s.find(v.region), maybe: false}]
              : undefined,
        });
      }
    }
    return v;
  }

  evalBinary(node: Node, s: State): Value {
    const op = node.operatorToken.kind as K;
    // a property or element is the place of an assignment: its object and
    // key are evaluated once, before the value, and it is written after
    const place = skipOuterExpressions(
      node.left,
      OEK.Assertions | OEK.Parentheses,
    );
    const member = isAssignmentOperator(op) && isMemberAccess(place);
    if (op === K.EqualsToken) {
      if (member) {
        const since = s.consumes;
        const obj = this.evalPlace(place, s);
        const v = this.eval(node.right, s);
        // a value that never comes writes nothing
        if (!s.unreachable) this.writeMember(place, obj, v, s, since);
        return v;
      }
      const v = this.eval(node.right, s);
      this.assign(node.left, v, s, this.wholePart(this.a.typeOf(node.right)));
      return v;
    }
    if (
      op === K.AmpersandAmpersandEqualsToken ||
      op === K.BarBarEqualsToken ||
      op === K.QuestionQuestionEqualsToken
    ) {
      if (member) {
        const since = s.consumes;
        const obj = this.evalPlace(place, s);
        this.mayThrow(s); // its read, a getter's
        const old = this.readMember(place, place.expression, obj, s);
        const assigned = s.copy();
        const v = assigned.mergeValues(old, this.eval(node.right, assigned));
        if (!assigned.unreachable)
          this.writeMember(place, obj, v, assigned, since);
        s.assign(joinStates(s, assigned));
        return v;
      }
      const old = this.eval(node.left, s);
      const assigned = s.copy();
      const v = assigned.mergeValues(old, this.eval(node.right, assigned));
      this.assign(node.left, v, assigned);
      s.assign(joinStates(s, assigned));
      return v;
    }
    if (isAssignmentOperator(op)) {
      // Compound assignment: reads and writes the target. a property's read
      // (a getter's) may throw before the right side is made, its conversion
      // and its write (a setter's) after
      if (member) {
        const since = s.consumes;
        const obj = this.evalPlace(place, s);
        this.checkWrite(place, place.expression, obj);
        this.mayThrow(s);
        this.eval(node.right, s);
        if (s.unreachable) return sharedValue;
        this.checkStillThere(place.expression, obj, s, since);
        this.mayThrow(s);
        return sharedValue;
      }
      this.evalWriteTarget(node.left, s);
      this.eval(node.right, s);
      if (!this.convertsSafely(node.left) || !this.convertsSafely(node.right))
        this.mayThrow(s);
      return sharedValue;
    }
    if (
      op === K.AmpersandAmpersandToken ||
      op === K.BarBarToken ||
      op === K.QuestionQuestionToken
    ) {
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
    // an operator that converts its operands (arithmetic, a comparison) may
    // throw, but for plain primitives; `in` and `instanceof` may; `===` and
    // `!==` do not
    const nullishOnly = (t: Type) =>
      !!(t.flags & (TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void)) &&
      !(t.flags & TypeFlags.Union);
    // an object or null or undefined: two of them compare with no conversion
    const host = this.a.c.host;
    const objectLike = (t: Type): boolean =>
      t.flags & TypeFlags.Union
        ? host.memberTypes(t).every(objectLike)
        : !!(
            t.flags &
            (TypeFlags.Object |
              TypeFlags.NonPrimitive |
              TypeFlags.Null |
              TypeFlags.Undefined |
              TypeFlags.Void)
          ) ||
          (!!(t.flags & TypeFlags.Intersection) &&
            host.memberTypes(t).every(objectLike));
    if (
      op !== K.EqualsEqualsEqualsToken &&
      op !== K.ExclamationEqualsEqualsToken &&
      // `==` and `!=` with null or undefined convert nothing
      !(
        (op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken) &&
        (nullishOnly(this.a.typeOf(node.left)) ||
          nullishOnly(this.a.typeOf(node.right)) ||
          (objectLike(this.a.typeOf(node.left)) &&
            objectLike(this.a.typeOf(node.right))))
      ) &&
      (op === K.InKeyword ||
        op === K.InstanceOfKeyword ||
        !this.convertsSafely(node.left) ||
        !this.convertsSafely(node.right))
    )
      this.mayThrow(s);
    if (
      op === K.PlusToken &&
      !this.a.isPrimitiveOrSharedStructType(this.a.typeOf(node))
    )
      return regionValue(this.a.newRegion());
    return sharedValue;
  }

  // Reports whether a value of type t may be null or undefined: of a type
  // that says so, or that does not tell (any, unknown).
  mayBeNullish(t: Type): boolean {
    const nullish =
      TypeFlags.Null |
      TypeFlags.Undefined |
      TypeFlags.Void |
      TypeFlags.Any |
      TypeFlags.Unknown;
    if (t.flags & nullish) return true;
    return (
      !!(t.flags & TypeFlags.Union) &&
      this.a.c.host.memberTypes(t).some(m => !!(m.flags & nullish))
    );
  }

  // Reports whether an operand converts with no error and no code of its own:
  // a plain primitive (see isPlainPrimitive) that is no property or element,
  // which a getter or setter reads or writes.
  convertsSafely(operand: Node): boolean {
    const n = skipOuterExpressions(operand, OEK.Assertions | OEK.Parentheses);
    return !isMemberAccess(n) && this.a.isPlainPrimitive(this.a.typeOf(n));
  }

  // Evaluates the target of `x++` , `delete a.b` , `a.b += 1` and the like,
  // reporting writes through shared values.
  evalWriteTarget(target: Node, s: State): void {
    target = skipOuterExpressions(target, OEK.Assertions | OEK.Parentheses);
    if (
      target.kind === K.PropertyAccessExpression ||
      target.kind === K.ElementAccessExpression
    ) {
      const obj = this.eval(target.expression, s);
      if (target.kind === K.ElementAccessExpression)
        this.eval(target.argumentExpression, s);
      this.checkWrite(target, target.expression, obj);
    } else {
      this.eval(target, s);
    }
  }

  // Assigns a value to an assignment target: rebinds a local variable, merges
  // into the OUTER region of a captured one, or links the value to the object
  // whose property is written.
  // source: the type of what is assigned, where it is known (an object
  // pattern rejects null and undefined before its first target)
  assign(target: Node, v: Value, s: State, part?: Part): void {
    target = skipOuterExpressions(target, OEK.Assertions | OEK.Parentheses);
    const a = this.a;
    switch (target.kind) {
      case K.Identifier: {
        const symbol = a.symbolOfIdentifier(target);
        if (!symbol) return;
        if (a.isLocalTo(symbol, this.node)) {
          // a class is kept as one, though its name is code (a class's)
          s.vars.set(symbol, v.ctors ? v : a.normalize(symbol, v));
          return;
        }
        s.mergeValues(this.lookup(symbol, s), v);
        return;
      }
      case K.PropertyAccessExpression:
      case K.ElementAccessExpression: {
        const since = s.consumes;
        this.writeMember(target, this.evalPlace(target, s), v, s, since);
        return;
      }
      case K.ArrayLiteralExpression:
        // getting the iterator may throw, before any target is evaluated;
        // each step may, after the defaults and the assignments before it;
        // then the iterator is closed
        this.mayThrow(s);
        (target.elements as Node[]).forEach((element, index) => {
          if (element.kind === K.OmittedExpression) this.mayThrow(s);
          else if (element.kind === K.SpreadElement)
            this.assignRead(element.expression, undefined, v, s, {
              nullable: false,
            });
          else if (
            element.kind === K.BinaryExpression &&
            element.operatorToken.kind === K.EqualsToken
          )
            this.assignRead(
              element.left,
              element.right,
              v,
              s,
              this.partOf(part, index, element.right),
            );
          else
            this.assignRead(element, undefined, v, s, this.partOf(part, index));
        });
        this.mayThrow(s);
        return;
      case K.ObjectLiteralExpression:
        // a source that may be null or undefined throws before any target is
        // evaluated; each property read (a getter's) may, after the defaults
        // and the assignments before it
        if ((target.properties as Node[]).length === 0 || part?.nullable)
          this.mayThrow(s);
        for (const property of target.properties as Node[]) {
          if (property.name?.kind === K.ComputedPropertyName) {
            // converted to a key, which may throw, before the target is
            // evaluated
            this.eval(property.name.expression, s);
            this.mayThrow(s);
          }
          switch (property.kind) {
            case K.PropertyAssignment: {
              const init = property.initializer as Node;
              const key = keyOf(property.name as Node);
              if (
                init.kind === K.BinaryExpression &&
                init.operatorToken.kind === K.EqualsToken
              )
                this.assignRead(
                  init.left,
                  init.right,
                  v,
                  s,
                  this.partOf(part, key, init.right),
                );
              else
                this.assignRead(init, undefined, v, s, this.partOf(part, key));
              break;
            }
            case K.ShorthandPropertyAssignment:
              this.assignRead(
                property.name,
                property.objectAssignmentInitializer,
                v,
                s,
              );
              break;
            case K.SpreadAssignment:
              this.assignRead(property.expression, undefined, v, s, {
                nullable: false,
              });
              break;
          }
        }
        return;
    }
    this.eval(target, s);
  }

  // Assigns to a destructuring's target what it reads, in JavaScript's order:
  // a property or element target is evaluated first, then the value is read
  // (a property, an iterator step), which may throw, then its default made
  // if it has one, and then it is written.
  assignRead(
    target: Node,
    initializer: Node | undefined,
    v: Value,
    s: State,
    part?: Part,
  ): void {
    const place = skipOuterExpressions(
      target,
      OEK.Assertions | OEK.Parentheses,
    );
    const since = s.consumes;
    const obj = isMemberAccess(place) ? this.evalPlace(place, s) : undefined;
    this.mayThrow(s);
    const read = initializer ? s.mergeValues(v, this.eval(initializer, s)) : v;
    if (obj) this.writeMember(place, obj, read, s, since);
    else this.assign(target, read, s, part);
  }

  // A pattern's whole value, of type t.
  wholePart(t: Type): Part {
    return {type: t, nullable: this.mayBeNullish(t)};
  }

  // What a pattern's element takes apart: the part at a key (a property's
  // name, an element's index) of its pattern's part, with its default. Where
  // the pattern's type is not known, neither is the part's, which is then
  // taken not to be null (as a for-of variable's pattern is); where only the
  // part's is not known (a computed key), it may be.
  partOf(
    part: Part | undefined,
    key: string | number | undefined,
    initializer?: Node,
  ): Part {
    if (!part?.type) return {nullable: false};
    const host = this.a.c.host;
    let type: Type | undefined;
    if (typeof key === 'number')
      type = host.checker.isTupleType(part.type)
        ? host.typeArguments(part.type)[key]
        : (host.checker.getIndexTypeOfType(part.type, IndexKind.Number) ??
          undefined);
    else if (key !== undefined) {
      const property = host.checker.getPropertyOfType(part.type as any, key);
      type = property && host.typeOfSymbol(property as any);
    }
    if (!type) return {nullable: true};
    if (!initializer) return {type, nullable: this.mayBeNullish(type)};
    // a default replaces undefined (not null): the part is what else it may
    // be, or the default
    const others = (
      type.flags & TypeFlags.Union ? host.memberTypes(type) : [type]
    ).filter(m => !(m.flags & (TypeFlags.Undefined | TypeFlags.Void)));
    return {
      type: others.length === 1 ? others[0] : type,
      nullable:
        others.some(m => this.mayBeNullish(m)) ||
        this.mayBeNullish(this.a.typeOf(initializer)),
    };
  }

  // Evaluates the object of a property or element, and its key: what it is
  // read from or written to.
  evalPlace(place: Node, s: State): Value {
    const obj = this.eval(place.expression, s);
    if (place.kind === K.ElementAccessExpression) {
      this.eval(place.argumentExpression, s);
      // the key is converted then, which an object's may throw in
      const key = this.a.typeOf(place.argumentExpression);
      if (
        !this.a.isPlainPrimitive(key) &&
        !(key.flags & TypeFlags.ESSymbolLike)
      )
        this.mayThrow(s);
    }
    return obj;
  }

  // Writes a value into a property or element whose object (obj) was
  // evaluated before the value was: a setter may throw, and the object may
  // have been sent or consumed since.
  writeMember(
    place: Node,
    obj: Value,
    v: Value,
    s: State,
    since: readonly ConsumeEvent[],
  ): void {
    this.checkStillThere(place.expression, obj, s, since);
    this.checkWrite(place, place.expression, obj);
    this.mayThrow(s); // a setter's, or of null
    if (obj.kind === ValueKind.InRegion && !s.isCounted(obj))
      s.mergeValues(obj, v);
  }

  // Reports an object written to after what was evaluated since it was read
  // (obj, its value then) sent it, or consumed the variable it was read from
  // while that still held it, on some paths or all (a consume() ends the
  // binding, and leaves the region as it was).
  checkStillThere(
    expr: Node,
    obj: Value,
    s: State,
    since: readonly ConsumeEvent[],
  ): void {
    let root = skipOuterExpressions(expr, OEK.Assertions | OEK.Parentheses);
    while (
      root.kind === K.PropertyAccessExpression ||
      root.kind === K.ElementAccessExpression
    )
      root = skipOuterExpressions(
        root.expression,
        OEK.Assertions | OEK.Parentheses,
      );
    if (root.kind !== K.Identifier) {
      this.checkUse(expr, expressionName(expr), obj, s);
      return;
    }
    const symbol = this.a.symbolOfIdentifier(root);
    const bound = symbol && s.vars.get(symbol);
    const origin =
      bound?.kind === ValueKind.Consumed && obj.kind === ValueKind.InRegion
        ? bound.origins?.find(o => s.find(o.region) === s.find(obj.region))
        : undefined;
    if (origin) {
      this.checkUse(
        root,
        root.text,
        {...bound!, maybe: bound!.maybe || origin.maybe},
        s,
      );
      return;
    }
    // consumed while it held the object, and given another value since, on
    // some path at least
    const id = symbol && this.a.idOf(symbol);
    const consumed =
      obj.kind === ValueKind.InRegion
        ? s.consumes.find(
            e =>
              !since.includes(e) &&
              e.id === id &&
              s.find(e.region) === s.find(obj.region),
          )
        : undefined;
    if (consumed)
      this.a.reportUseAfterSend(root, root.text, consumed.send, true);
    else this.checkUse(root, root.text, obj, s);
  }

  // Reports a write to a property or element of a shared value. Fields of
  // shared struct instances are mutable cells, so writing them is allowed.
  checkWrite(target: Node, object: Node, obj: Value): void {
    if (obj.kind !== ValueKind.Shared || !this.a.isImmutableShared(object))
      return;
    this.a.report(
      target,
      ReportKind.Write,
      target,
      Messages.ChangeShared,
      expressionName(object),
    );
  }

  // The value of `o.p` or `o[i]` given the value of `o` : shared if `o` is
  // shared (sharedness is deep), if the member is declared shared, or if it is
  // a primitive; otherwise in `o` 's region.
  readMember(node: Node, object: Node, obj: Value, s: State): Value {
    const a = this.a;
    if (obj.kind !== ValueKind.InRegion) return sharedValue;
    // a class's prototype, which its instances reach
    if (
      obj.ctors &&
      !obj.otherCtor &&
      node.kind === K.PropertyAccessExpression &&
      node.name.text === 'prototype'
    )
      return this.prototypeOf(obj, s);
    if (s.isCounted(obj)) {
      // A struct element of a SharedArray is stored inline in the array's
      // block: an alias of the array. Fields are numbers or untracked
      // references.
      if (
        node.kind === K.ElementAccessExpression &&
        a.isCountedType(a.typeOf(node))
      )
        return obj;
      return sharedValue;
    }
    if (node.kind === K.PropertyAccessExpression) {
      const prop = a.c.host.symbolAt(node.name);
      if (prop && (prop.flags & SymbolFlags.Method || a.isDeclaredShared(prop)))
        return sharedValue;
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
      if (property.name?.kind === K.ComputedPropertyName) {
        this.eval(property.name.expression, s);
        this.mayThrow(s); // the key is converted
      }
      switch (property.kind) {
        case K.PropertyAssignment:
          add(this.eval(property.initializer, s));
          break;
        case K.ShorthandPropertyAssignment:
          add(this.readIdentifier(property.name, s));
          break;
        case K.SpreadAssignment:
          add(this.eval(property.expression, s));
          this.mayThrow(s); // its properties are read
          break;
        case K.MethodDeclaration:
        case K.GetAccessor:
        case K.SetAccessor:
          add(this.closureValue(property, s));
          break;
      }
    }
    return regionValue(s.find(r));
  }

  // The value of a closure (function, arrow function, class or object literal
  // method): a fresh region merged with the regions of the variables it
  // captures.
  closureValue(node: Node, s: State): Value {
    const r = this.a.newRegion();
    if (this.building.has(node)) return regionValue(r);
    this.building.add(node);
    try {
      const captures = this.a.capturesOf(node);
      captures.symbols.forEach((symbol, i) => {
        const v = this.lookup(symbol, s);
        // A captured variable that was already sent is reported once, here; it
        // is not linked to the closure, so that uses of the closure do not
        // report it again.
        if (
          !this.checkUse(captures.nodes[i]!, symbol.name, v, s) &&
          v.kind === ValueKind.InRegion &&
          !s.isCounted(v)
        ) {
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
    const callee = skipOuterExpressions(
      node.expression,
      OEK.Parentheses | OEK.NonNullAssertions,
    );
    const regions: Region[] = [];
    const add = (v: Value): void => {
      // A counted value is not linked to the other arguments.
      if (v.kind === ValueKind.InRegion && !s.isCounted(v))
        regions.push(v.region);
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
    if (
      callee.kind === K.PropertyAccessExpression ||
      callee.kind === K.ElementAccessExpression
    ) {
      receiverExpr = callee.expression as Node;
      receiver = this.eval(receiverExpr, s);
      if (callee.kind === K.ElementAccessExpression)
        this.eval(callee.argumentExpression, s);
      this.mayThrow(s); // the method is looked up
      add(receiver);
    } else {
      add(this.eval(callee, s));
    }
    const handle = host.signatureOf(node).declaration;
    const decl = a.declarationOutsideLibrary(handle);
    if (
      receiverExpr &&
      arrayMutators.has(name) &&
      receiver.kind === ValueKind.Shared &&
      a.isArrayExpression(receiverExpr) &&
      a.isImmutableShared(receiverExpr)
    ) {
      a.report(
        node,
        ReportKind.Write,
        callee,
        Messages.ChangeShared,
        expressionName(receiverExpr),
      );
    }
    const params = signatureParameters(decl);
    const consuming = a.isConsumingSignature(decl);
    let callback: Node | undefined;
    if (
      receiverExpr &&
      (name === 'map' || name === 'flatMap') &&
      args.length > 0 &&
      a.isLibArrayMethod(handle)
    ) {
      const cb = skipParentheses(args[0]!);
      if (isFunctionExpressionOrArrowFunction(cb)) callback = cb;
    }
    // arguments other than the receiver and a map callback
    const otherArgs: Region[] = [];
    const places = this.argumentPlaces(args);
    args.forEach((arg, i) => {
      const expr =
        arg.kind === K.SpreadElement ? (arg.expression as Node) : arg;
      const v = this.eval(arg, s); // a spread is iterated, which may throw
      const param = this.sendingParameterOf(arg, params, places[i]!);
      if (param && a.isSendingTypeNode(param.type)) {
        this.sendArgument(v, expr, param, name, consuming, s);
        return;
      }
      add(v);
      if (
        v.kind === ValueKind.InRegion &&
        !s.isCounted(v) &&
        !(callback && i === 0)
      )
        otherArgs.push(v.region);
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
      // map/flatMap with a callback that builds fresh values: the result is a
      // fresh array.
      this.unionAll(otherArgs, s);
      return regionValue(a.newRegion());
    }
    let r = this.unionAll(regions, s);
    // not tracked through the call: a fresh counted value
    if (counted) return regionValue(a.newRegionOf(true, s));
    if (a.isPrimitiveOrSharedStructType(a.typeOf(node))) return sharedValue;
    if (r === 0) r = a.newRegion();
    return regionValue(r);
  }

  // The places each argument's values go to, from..to: a spread before it
  // fills a tuple's length of them, or an unknown number (see spreadShape),
  // and a spread fills as many as it holds, none for an empty one.
  argumentPlaces(
    args: readonly Node[],
  ): {from: number; to: number; lastStart: number}[] {
    let from = 0,
      to = 0;
    return args.map(arg => {
      if (arg.kind !== K.SpreadElement)
        return {from: from++, to, lastStart: to++};
      const shape = spreadShape(this.a.c, this.a.typeOf(arg.expression));
      // an empty one fills no place, wherever it comes; a spread starts
      // where it does, its length aside
      const place =
        shape.max === 0
          ? {from: 1, to: 0, lastStart: 0}
          : {from, to: to + shape.max - 1, lastStart: to};
      from += shape.min;
      to += shape.max;
      return place;
    });
  }

  // The `Sending` parameter an argument's value is sent to, if any: a
  // spread's container is taken to be when a value of it that may reach one
  // is no primitive or shared value (its elements are in its region).
  sendingParameterOf(
    arg: Node,
    params: Node[],
    place: {from: number; to: number; lastStart: number},
  ): Node | undefined {
    if (arg.kind !== K.SpreadElement)
      return this.sendingParameter(params, place);
    const shape = spreadShape(this.a.c, this.a.typeOf(arg.expression));
    for (const value of shape.values) {
      if (this.a.isPrimitiveOrSharedStructType(value.type)) continue;
      const param = this.sendingParameter(params, {
        from: place.from + value.from,
        to: place.lastStart + value.to,
      });
      if (param) return param;
    }
    return undefined;
  }

  // A `Sending` parameter an argument may go to, at one of its places.
  sendingParameter(
    params: Node[],
    place: {from: number; to: number},
  ): Node | undefined {
    const last = Math.min(place.to, Math.max(place.from, params.length - 1));
    for (let p = place.from; p <= last; p++) {
      const param = parameterAt(params, p);
      if (param && this.a.isSendingTypeNode(param.type)) return param;
    }
    return undefined;
  }

  evalNew(node: Node, s: State): Value {
    const a = this.a;
    const args = (node.arguments ?? []) as Node[];
    const counted = a.isCountedType(a.typeOf(node));
    if (counted) {
      // `new` of a SharedArray (or another counted value): a fresh counted
      // value.
      for (const arg of args) this.eval(arg, s);
      return regionValue(a.newRegionOf(true, s));
    }
    const regions: Region[] = [];
    const v = this.eval(node.expression, s);
    // an instance of a class defined here holds what the class's code
    // captures (its bases' too), not the class itself: its static state, and
    // the other instances, are no part of it
    regions.push(...this.instanceRegions(v, s));
    const decl = a.signatureDeclarationOf(node);
    const params = signatureParameters(decl);
    const name = calleeName(node.expression);
    const consuming = a.isConsumingSignature(decl);
    const places = this.argumentPlaces(args);
    args.forEach((arg, i) => {
      const expr =
        arg.kind === K.SpreadElement ? (arg.expression as Node) : arg;
      const value = this.eval(arg, s); // a spread is iterated, which may throw
      const param = this.sendingParameterOf(arg, params, places[i]!);
      if (param && a.isSendingTypeNode(param.type)) {
        this.sendArgument(value, expr, param, name, consuming, s);
        return;
      }
      if (value.kind === ValueKind.InRegion && !s.isCounted(value))
        regions.push(value.region);
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
    // A new object: a fresh region holding the (non-shared) constructor
    // arguments.
    const r = a.newRegion();
    for (const region of regions) s.union(r, region);
    return regionValue(s.find(r));
  }

  // Records what a class's code captures as the class is created (see
  // captured).
  recordCaptures(node: Node, s: State): void {
    const captures = this.a.capturesOf(node);
    const entries: {symbol: TsSymbol; at: Node; region: Region}[] = [];
    captures.symbols.forEach((symbol, i) => {
      const v = this.lookup(symbol, s);
      if (v.kind === ValueKind.InRegion)
        entries.push({symbol, at: captures.nodes[i]!, region: v.region});
    });
    if (captures.usesThis) {
      const v = this.thisValue(s);
      if (v.kind === ValueKind.InRegion)
        entries.push({
          symbol: {name: 'this'} as TsSymbol,
          at: node,
          region: v.region,
        });
    }
    this.captured.set(node, entries);
  }

  // The region of what the prototype of a constructor value holds: each of
  // its classes'.
  prototypeOf(v: Value, s: State): Value {
    let r = 0;
    for (const n of v.ctors ?? []) {
      let p = this.prototypes.get(n);
      if (p === undefined) {
        p = this.a.newRegion();
        this.prototypes.set(n, p);
      }
      r = r === 0 ? s.find(p) : s.union(r, p);
    }
    return regionValue(r);
  }

  // The regions a new instance shares, of a constructor value: for each class
  // defined here it may be, a fresh region of what the class's code captures
  // (with the class, where its instance code reaches the class's static
  // state), and its bases'; for any other constructor it may be, the value
  // itself.
  instanceRegions(v: Value, s: State, seen = new Set<Node>()): Region[] {
    if (v.kind !== ValueKind.InRegion) return [];
    const regions: Region[] = [];
    if (!v.ctors || v.otherCtor) regions.push(v.region);
    for (const n of v.ctors ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      // what its code captured as it was created, each checked where it was
      // captured
      const captured = this.captured.get(n);
      if (captured) {
        for (const c of captured) {
          if (
            !this.checkUse(c.at, c.symbol.name, regionValue(c.region), s) &&
            !s.isCounted(regionValue(c.region))
          )
            regions.push(c.region);
        }
      } else {
        const own = this.closureValue(n, s);
        if (own.kind === ValueKind.InRegion) regions.push(own.region);
      }
      const prototype = this.prototypes.get(n);
      if (prototype !== undefined) regions.push(prototype);
      if (this.a.instancesReachTheirClass(n)) {
        const cls = [...this.classes].reverse().find(c => c.node === n);
        if (cls) regions.push(cls.region);
      }
      const base = this.bases.get(n);
      if (base && !(base.kind === ValueKind.InRegion && s.isCounted(base)))
        regions.push(...this.instanceRegions(base, s, seen));
    }
    return regions;
  }

  // Merges regions and returns the root, or 0 if there are none.
  unionAll(regions: Region[], s: State): Region {
    let r = 0;
    for (const region of regions)
      r = r === 0 ? s.find(region) : s.union(r, region);
    return r;
  }

  // Passes an argument to a `Sending` parameter. A counted value is sent
  // (moved) only by a parameter that is not a rest parameter: a thread's
  // arguments share it, and a share-like function leaves it as it is.
  sendArgument(
    v: Value,
    expr: Node,
    param: Node,
    callee: string,
    consuming: boolean,
    s: State,
  ): void {
    if (s.isCounted(v) && (consuming || param.dotDotDotToken)) return;
    this.send(v, expr, callee, consuming, s);
  }

  // Sends a value: passes it to a `Sending` parameter (or a share-like
  // function, which consumes it).
  send(
    v: Value,
    expr: Node,
    callee: string,
    consuming: boolean,
    s: State,
  ): void {
    if (v.kind !== ValueKind.InRegion) return;
    const [root, inf] = s.root(v);
    const name = expressionName(expr);
    if (inf.flags & RegionFlags.Caller) {
      this.a.report(
        expr,
        ReportKind.Send,
        expr,
        Messages.SendCallerReferenced,
        name,
      );
    } else if (inf.flags & RegionFlags.Outer) {
      this.a.report(expr, ReportKind.Send, expr, Messages.SendCaptured, name);
    } else if (inf.sent && !inf.maybe) {
      // Already sent: the use of the sent variable has been reported.
    } else {
      s.addSend(
        root,
        {site: expr, callee, via: name, consume: consuming},
        false,
      );
    }
  }
}

function isJsxChildOrAttribute(node: Node): boolean {
  switch (node.kind) {
    case K.JsxElement:
    case K.JsxExpression:
    case K.JsxSelfClosingElement:
    case K.JsxText:
    case K.JsxFragment:
    case K.JsxAttribute:
    case K.JsxSpreadAttribute:
    case K.JsxAttributes:
      return true;
  }
  return false;
}

function lineOf(node: Node): number {
  const file = node.getSourceFile();
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

// A short name for an expression in a message: the variable for `x` and
// `consume(x)` , otherwise the (abbreviated) source text.
function expressionName(expr: Node): string {
  expr = skipParentheses(expr);
  if (
    expr.kind === K.CallExpression &&
    expr.arguments.length === 1 &&
    expr.expression.kind === K.Identifier &&
    expr.expression.text === 'consume'
  ) {
    expr = skipParentheses(expr.arguments[0]); // `consume(x)`
  }
  if (expr.kind === K.Identifier) return expr.text;
  let text = expr
    .getText(expr.getSourceFile())
    .split(/\s+/)
    .filter((part: string) => part !== '')
    .join(' ');
  if (text.length > 40) text = text.slice(0, 37) + '...';
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
  for (
    let n = decl.parent as Node | undefined;
    n;
    n = n.parent as Node | undefined
  ) {
    if (isFunctionBody(n) || n.kind === K.SourceFile) return n;
  }
  return undefined;
}

// The parameters of a signature declaration, without a `this` parameter.
function signatureParameters(decl: Node | undefined): Node[] {
  if (!decl || !isFunctionLike(decl)) return [];
  const params = (decl.parameters ?? []) as Node[];
  return params.length > 0 && isThisParameter(params[0]!)
    ? params.slice(1)
    : [...params];
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
  if (
    !t ||
    t.kind !== K.TypeReference ||
    (t.typeArguments?.length ?? 0) !== 0 ||
    t.typeName.kind !== K.Identifier
  )
    return '';
  const name = t.typeName.text as string;
  for (const tp of (decl.typeParameters ?? []) as Node[]) {
    if (tp.name.text === name) return name;
  }
  return '';
}
