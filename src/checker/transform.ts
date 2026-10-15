// The emit of threads for JavaScript (the fork's tstransforms/ownlayout.go and
// transformers/ownruntime.go), on TypeScript 7.1's API: a program's
// TypeScript with its typed layouts lowered and its references counted, its
// types left in for a type stripper (OXC) to erase.
//
// A value whose type is a shared struct or a SharedArray is the byte address
// of its block in the runtime's shared heap, which `__F64` (a Float64Array),
// `__I32` (an Int32Array) and `__U8` (a Uint8Array) view:
//
//   shared struct S { f0; ...; f(n-1) }  [0: i32 kind][4: i32 count][8: f0]...
//   SharedArray<E>                       [0: kind][4: length][8: element size]
//                                        [12: count] then the elements from 16
//
//   new S()                     __newStruct(S)
//   new SharedArray(S, n)       __newSharedArray(S, n) (8, 1, 4, -4, -1 for
//                               numbers, booleans, strings, i32s, u8s)
//   e.fk (number)               __F64[(E >> 3) + 1 + k]
//   e.fk (boolean)              __U8[E + 8 + 8 * k] !== 0 (the byte, written)
//   e.fk (i32, reference)       __I32[(E >> 2) + 2 + 2 * k]
//   e.fk (u8)                   __U8[E + 8 + 8 * k]
//   e.fk (string)               __strAt(__I32[...]); e.fk = V: __storeStr(I, V)
//   e.fk (channel)              __box(__I32[...]); = V: __I32[I] = __cellAddress(V)
//   e.fk = V (reference)        __store((E >> 2) + 2 + 2 * k, V)
//   a.length                    __I32[(A + 4) >> 2]
//   a[i] (struct elements)      CHECK ? A + 16 + I * size : __outOfBounds[I]
//   a[i] (number, read)         CHECK ? __F64[((A + 16) >> 3) + I] : __outOfBounds[I]
//   a[i] (number, write)        __F64[((A + 16) >> 3) + (CHECK ? I : __outOfBounds[I])]
//   atomic.add(s, "fk", V)      Atomics.add(__I32, (S >> 2) + 2 + 2 * k, V)
//   CHECK                       (I >>> 0) === I && I < __I32[(A + 4) >> 2]
//
// and reference counting (REFCOUNT.md): every raw address is visited in a
// context (used at once, passed to a function, taken, returned, discarded),
// and its count (resolver.ts: owned, a stable or an unstable borrow) decides
// the code:
//
//                   at once      argument                 taken        discarded
//   owned           (_a = E) *   (_a = E) *               E            __release(E)
//   stable borrow   E            E                        __retain(E)  E
//   unstable borrow E            (_a = __retain(E)) *     __retain(E)  E
//
// * `__release(_a)` follows the full expression. An owned local is released
// when its block ends (`try { ... } finally { __release(x) }`), a return moves
// its count out (`(_t = x, x = 0, _t)`), a closure that captures counted
// variables is `__capture(fn, x, ...)`, an argument the callee takes a count of
// is `__countedRef(E)`, and a loop that reads or stores a reference field ends
// each iteration with `__quiescent()`.
//
// The functions below follow the fork's, one for one, so that the two emit the
// same code: they visit the same nodes in the same order (which is the order
// their temporaries are declared and named in), and build the same shapes,
// as code to write into the original text (ir.ts) rather than nodes.

import MagicString from 'magic-string';
import type {SourceFile} from 'typescript/ast';
import {CellKind, Conversion} from './context.ts';
import type {CellType} from './context.ts';
import {
  binary,
  block,
  call,
  comma,
  cond,
  copyOf,
  elem,
  exprStatement,
  gen,
  helperRef,
  isGen,
  num,
  paren,
  Prec,
  precOf,
  prefix,
  raw,
  statements,
  str,
  tempRef,
  write,
} from './ir.ts';
import type {Edit, Ir, Names, Part, Scope, Src, Temp} from './ir.ts';
import {Count, Local} from './resolver.ts';
import type {AtomicCall, Resolver, StructCall} from './resolver.ts';
import {
  forEachChild,
  isAssignmentOperator,
  isAssignmentTarget,
  isClassExtends,
  isClassLike,
  isDeclarationName,
  isExpression,
  isFunctionLike,
  isFunctionLikeDeclaration,
  isOptionalChain,
  isOwnReferencePosition,
  isTypeNode,
  K,
  NodeFlags,
  OEK,
  skipOuterExpressions,
  skipParentheses,
} from './syntax.ts';
import type {Node} from './syntax.ts';

// The context of a raw address.
const Ctx = {AtOnce: 0, Argument: 1, Take: 2, Return: 3, Discard: 4} as const;
type Ctx = (typeof Ctx)[keyof typeof Ctx];

// A full expression: the temporaries holding owned values, released after it.
interface Frame {
  released: Temp[];
  zeroed: Temp[]; // those assigned only conditionally: 0 before it
  conditional: number; // the enclosing frame's depth
}

// The runtime's helpers by their names in the emit, in the order the fork's
// list has them (ownRuntimeHelpers).
const HELPERS = [
  '__F64',
  '__I32',
  '__outOfBounds',
  '__U8',
  '__box',
  '__cellAddress',
  '__capture',
  '__moved',
  '__newSharedArray',
  '__newStruct',
  '__quiescent',
  '__countedRef',
  '__register',
  '__release',
  '__retain',
  '__sharedStruct',
  '__store',
  '__storeStr',
  '__strAt',
  '__unbox',
];

export interface TransformResult {
  // the TypeScript with the edits, and its source map (from the original)
  code: string;
  map: ReturnType<MagicString['generateMap']>;
  // whether anything changed
  changed: boolean;
  // the functions it registers (`__register(import.meta.url, {...})`)
  registered: string[];
}

export interface TransformOptions {
  // the module specifier the runtime's helpers are imported from
  runtime: string;
  // whether the file is emitted as an ES module (else nothing is done)
  esModule: boolean;
  // the module detection is `force` : every file is a module
  forceModule?: boolean;
}

// Lowers a source file.
export function transformFile(
  r: Resolver,
  file: SourceFile,
  options: TransformOptions,
): TransformResult {
  const text = file.text;
  const ms = new MagicString(text);
  const lowering = new Lowering(r, file as unknown as Node, options);
  const registered = lowering.run(ms);
  return {
    registered,
    code: ms.toString(),
    map: ms.generateMap({
      hires: true,
      source: file.fileName,
      includeContent: true,
    }),
    changed: ms.hasChanged(),
  };
}

// A statement of a function's prologue: whether it may throw (a default
// runs), and the owned parameter it retains.
interface PrologueEntry {
  ir: Ir;
  mayThrow: boolean;
  owned?: Node;
}

class Lowering {
  private readonly r: Resolver;
  private readonly file: Node;
  private readonly text: string;
  private readonly options: TransformOptions;
  private frames: (Frame | null)[] = [];
  private conditional = 0;
  // default values of owned parameters, moved into the body
  private readonly paramInits = new Map<Node, Node>();
  // default values of other parameters that move into the body with them
  // (visited already, or to visit there): those after one that moves, so
  // that the defaults still run left to right, and one whose temporaries
  // (declared in the body) it could not see from the parameter list
  private readonly movedDefaults = new Map<Node, Ir | undefined>();
  // the functions some of whose parameters' defaults move into the body
  private readonly movingDefaults = new Set<Node>();
  // the parameters visited with the first of their list, until they are
  // visited
  private readonly paramIrs = new Map<Node, Ir>();
  // binding-pattern parameters from the first default that moves on: a
  // temporary parameter, destructured in the body in order (with the
  // default, visited already or to visit there)
  private readonly movedPatterns = new Map<
    Node,
    {temp: Temp; pattern: Ir; init: Ir | undefined}
  >();
  // variables renamed where a moved default would see them instead of what
  // it reads (by symbol id), and the file's identifiers, which a new name
  // avoids
  private readonly renamed = new Map<number, string>();
  private fileIdentifiers = new Set<string>();
  // the var scopes of the functions being visited, innermost last
  private readonly scopes: Scope[] = [];
  private readonly starts = new Map<Node, number>();

  constructor(r: Resolver, file: Node, options: TransformOptions) {
    this.r = r;
    this.file = file;
    this.text = file.text as string;
    this.options = options;
  }

  run(ms: MagicString): string[] {
    const file = this.file;
    if (!this.usesRuntime()) return [];
    this.fileIdentifiers = this.identifiers();
    const fileScope: Scope = {temps: []};
    this.scopes.push(fileScope);
    // the source file's statements, each visited (as VisitEachChild does: no
    // block of its own)
    const edits: Edit[] = [];
    for (const statement of file.statements as Node[]) {
      const ir = this.visit(statement);
      if (!isIdentity(ir, statement)) edits.push(this.editOf(statement, ir));
    }
    this.scopes.pop();

    // helpers and registration
    const identifiers = this.fileIdentifiers;
    const used = new Set<string>();
    const helperNames = new Map<string, string>();
    const unique = (name: string): string => {
      let n = name;
      for (let i = 1; identifiers.has(n); i++) n = `${name}_${i}`;
      return n;
    };
    const names: Names = {
      helper: name => {
        used.add(name);
        let n = helperNames.get(name);
        if (n === undefined) {
          n = unique(name);
          helperNames.set(name, n);
          identifiers.add(n);
        }
        return n;
      },
      temp: temp => temp.name ?? '_?',
      vars: scope =>
        scope.temps.length > 0
          ? `\nvar ${scope.temps.map(t => t.name).join(', ')};`
          : '',
    };
    // temporaries are named per scope in the order they were declared
    this.nameTemps(identifiers);

    for (const e of edits) write(ms, e.ir, e.start, e.end, this.text, names);

    // the file's own temporaries
    const vars =
      fileScope.temps.length > 0
        ? `var ${fileScope.temps.map(t => t.name).join(', ')};\n`
        : '';

    const functions = this.importsRuntime() ? this.registeredFunctions() : [];
    let helpers = HELPERS.filter(h => used.has(h));
    if (functions.length > 0 && !helpers.includes('__register')) {
      helpers.push('__register');
      helpers = helpers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    if (helpers.length === 0) {
      const at = this.prologueEnd();
      if (vars) ms.prependLeft(at, this.prologueBreak(at) + vars);
      return [];
    }
    const specifiers = helpers.map(h => {
      const local = names.helper(h);
      return `${h.slice(2)} as ${local}`;
    });
    const importText = `import { ${specifiers.join(', ')} } from ${JSON.stringify(this.options.runtime)};\n`;
    const at = this.prologueEnd();
    ms.prependLeft(at, this.prologueBreak(at) + vars + importText);
    if (functions.length > 0) {
      const register = names.helper('__register');
      const end = this.text.length;
      const newline = end > 0 && this.text[end - 1] !== '\n' ? '\n' : '';
      ms.append(
        `${newline}${register}(import.meta.url, { ${functions.join(', ')} });\n`,
      );
    }
    return functions;
  }

  // UsesOwnRuntime: an ES module (by its emit), not a declaration file.
  private usesRuntime(): boolean {
    const file = this.file;
    if (!this.options.esModule || file.isDeclarationFile) return false;
    return (
      !!this.options.forceModule ||
      !!file.externalModuleIndicator ||
      (file.statements as Node[]).some(
        s =>
          s.kind === K.ImportDeclaration ||
          s.kind === K.ImportEqualsDeclaration ||
          s.kind === K.ExportDeclaration ||
          s.kind === K.ExportAssignment ||
          !!s.modifiers?.some((m: Node) => m.kind === K.ExportKeyword),
      )
    );
  }

  // importsOwnRuntime: an import or export from the runtime's module.
  private importsRuntime(): boolean {
    return (this.file.statements as Node[]).some(
      s =>
        (s.kind === K.ImportDeclaration || s.kind === K.ExportDeclaration) &&
        s.moduleSpecifier?.kind === K.StringLiteral &&
        s.moduleSpecifier.text === this.options.runtime,
    );
  }

  // OwnRuntimeRegisteredFunctions: the top-level function declarations with a
  // name and a body, in source order.
  private registeredFunctions(): string[] {
    const names: string[] = [];
    for (const s of this.file.statements as Node[]) {
      if (
        s.kind === K.FunctionDeclaration &&
        s.body &&
        s.name &&
        !(s.flags & NodeFlags.Ambient) &&
        !s.modifiers?.some((m: Node) => m.kind === K.DeclareKeyword)
      )
        names.push(s.name.text);
    }
    return names;
  }

  // Where the import goes: after the file's directives ("use strict") and a
  // `#!` line.
  private prologueEnd(): number {
    let at = 0;
    if (this.text.startsWith('#!')) {
      const nl = this.text.indexOf('\n');
      at = nl < 0 ? this.text.length : nl + 1;
    }
    for (const s of this.file.statements as Node[]) {
      if (
        s.kind === K.ExpressionStatement &&
        s.expression.kind === K.StringLiteral
      )
        at = s.end;
      else break;
    }
    if (this.text.startsWith('\r\n', at)) at += 2;
    else if (this.text[at] === '\n') at++;
    return at;
  }

  // What goes before the text inserted at prologueEnd(): a line break where
  // that is not the start of a line (a directive without a semicolon or a
  // line break after it, say), so the import is on a line of its own.
  private prologueBreak(at: number): string {
    return at > 0 && this.text[at - 1] !== '\n' ? '\n' : '';
  }

  // The identifiers of the file (a generated name avoids them all).
  private identifiers(): Set<string> {
    const names = new Set<string>();
    const visit = (node: Node): boolean => {
      if (node.kind === K.Identifier) names.add(node.text);
      return forEachChild(node, visit);
    };
    forEachChild(this.file, visit);
    return names;
  }

  // Names the temporaries: `_a`, `_b`, ... per function (but `_i` and `_n`),
  // none that the file uses.
  private allScopes: Scope[] = [];
  private nameTemps(identifiers: Set<string>): void {
    for (const scope of this.allScopes) {
      let count = 0;
      for (const temp of scope.temps) {
        for (;;) {
          const c = count++;
          if (c === 8 || c === 13) continue;
          const name =
            c < 26 ? '_' + String.fromCharCode(97 + c) : '_' + (c - 26);
          if (!identifiers.has(name)) {
            temp.name = name;
            break;
          }
        }
      }
    }
  }

  // ---- positions and original code

  private startOf(node: Node): number {
    let s = this.starts.get(node);
    if (s === undefined) {
      s = isStatementLike(node) ? node.pos : node.getStart(this.file as any);
      this.starts.set(node, s);
    }
    return s!;
  }

  private src(node: Node, edits: Edit[] = []): Src {
    // a renamed variable's identifier, wherever the lowering puts it
    if (
      node.kind === K.Identifier &&
      edits.length === 0 &&
      this.renamed.size > 0
    ) {
      const renamed = this.renamedName(node);
      if (renamed !== undefined) edits = [this.renameEdit(node, renamed)];
    }
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    return {
      k: 'src',
      node,
      start: this.startOf(node),
      end: node.end,
      edits,
      prec: precOf(node),
    };
  }

  // An edit that puts ir in node's place, parenthesized if node's place
  // needs it.
  private editOf(node: Node, ir: Ir): Edit {
    let out = ir;
    if (isGen(ir) && isExpression(node) && !isStatementLike(node)) {
      let min = positionPrec(node);
      if (min === undefined) {
        min = precOf(node);
        if (min >= Prec.LeftHandSide) min = Prec.LeftHandSide;
        const parent = node.parent as Node | undefined;
        if (parent?.kind === K.NewExpression && parent.expression === node)
          min = Prec.Member;
      }
      if (ir.prec < min) out = paren(ir);
    }
    return {start: this.startOf(node), end: node.end, ir: out};
  }

  // The node with the parts that changed replaced.
  private update(node: Node, parts: [Node | undefined, Ir | undefined][]): Ir {
    const edits: Edit[] = [];
    for (const [child, ir] of parts) {
      if (!child || !ir || isIdentity(ir, child)) continue;
      edits.push(this.editOf(child, ir));
    }
    return this.src(node, edits);
  }

  // VisitEachChild: the node with its children visited (in the AtOnce
  // context); types and declarations that are only types are left as they
  // are.
  private visitEachChild(node: Node): Ir {
    const edits: Edit[] = [];
    forEachChild(node, child => {
      if (isErased(child)) return;
      const ir = this.visit(child);
      if (!isIdentity(ir, child)) edits.push(this.editOf(child, ir));
    });
    return this.src(node, edits);
  }

  // ---- the visitor

  private visit(node: Node, ctx: Ctx = Ctx.AtOnce): Ir {
    if (isErased(node)) return this.src(node);
    // an arrow's concise body, even one that is itself a function: the arrow's
    // parameters' prologue goes around it (the fork visits a function there
    // as a closure only, and drops an owned parameter's default)
    if (isExpression(node)) {
      const fn = conciseBodyOf(node);
      if (fn) return this.visitConciseBody(node, fn);
    }
    switch (node.kind) {
      case K.Block:
        return this.visitBlock(node);
      case K.CaseClause:
      case K.DefaultClause: {
        const expression = this.fullExpression(node.expression, Ctx.AtOnce);
        const list = this.visitStatements(node.statements as Node[]);
        return this.withStatements(
          node,
          node.statements,
          list,
          expression ? [[node.expression, expression]] : [],
        );
      }
      case K.ExpressionStatement:
        return this.visitExpressionStatement(node);
      case K.ReturnStatement: {
        let expression = this.fullExpression(node.expression, Ctx.Return);
        if (expression) expression = this.moved(expression, node.expression);
        return this.update(node, [[node.expression, expression]]);
      }
      case K.IfStatement: {
        const expression = this.fullExpression(node.expression, Ctx.AtOnce);
        const thenStatement = this.visitEmbedded(node.thenStatement);
        const elseStatement = this.visitEmbedded(node.elseStatement);
        return this.update(node, [
          [node.expression, expression],
          [node.thenStatement, thenStatement],
          [node.elseStatement, elseStatement],
        ]);
      }
      case K.SwitchStatement: {
        const expression = this.fullExpression(node.expression, Ctx.AtOnce);
        const caseBlock = this.visitEachChild(node.caseBlock);
        return this.update(node, [
          [node.expression, expression],
          [node.caseBlock, caseBlock],
        ]);
      }
      case K.ThrowStatement:
        return this.update(node, [
          [node.expression, this.fullExpression(node.expression, Ctx.AtOnce)],
        ]);
      case K.WithStatement: {
        const expression = this.fullExpression(node.expression, Ctx.AtOnce);
        return this.update(node, [
          [node.expression, expression],
          [node.statement, this.visitEmbedded(node.statement)],
        ]);
      }
      case K.WhileStatement: {
        const expression = this.fullExpression(node.expression, Ctx.AtOnce);
        return this.update(node, [
          [node.expression, expression],
          [node.statement, this.visitLoopBody(node.statement, node)],
        ]);
      }
      case K.DoStatement: {
        const statement = this.visitLoopBody(node.statement, node);
        return this.update(node, [
          [node.statement, statement],
          [node.expression, this.fullExpression(node.expression, Ctx.AtOnce)],
        ]);
      }
      case K.ForStatement:
        return this.visitForStatement(node, undefined);
      case K.ForInStatement:
      case K.ForOfStatement: {
        const initializer = this.visit(node.initializer);
        const expression = this.fullExpression(node.expression, Ctx.AtOnce);
        return this.update(node, [
          [node.initializer, initializer],
          [node.expression, expression],
          [node.statement, this.visitLoopBody(node.statement, node)],
        ]);
      }
      case K.LabeledStatement: {
        // the loop under all its labels (`outer: inner: for`), which stay
        // on it
        let loop = node.statement as Node;
        while (loop.kind === K.LabeledStatement) loop = loop.statement;
        if (
          loop.kind === K.ForStatement &&
          this.ownedLocalsOfFor(loop).length > 0
        )
          return this.visitForStatement(loop, node);
        break;
      }
      case K.ContinueStatement: {
        const loop = continueTarget(node);
        if (loop && this.r.isQuiescentLoop(loop))
          return statements([this.quiescent(), this.visitEachChild(node)]);
        break;
      }
      case K.VariableDeclarationList:
        return this.visitVariableDeclarationList(node);
      case K.VariableDeclaration:
        return this.visitVariableDeclaration(node);
      case K.Parameter:
        return this.visitParameter(node);
      case K.ExpressionWithTypeArguments:
        // `extends E`: a full expression of its own, run as the class is
        if (isClassExtends(node))
          return this.update(node, [
            [node.expression, this.fullExpression(node.expression, Ctx.AtOnce)],
          ]);
        break;
      case K.BindingElement: {
        // a default is a full expression of its own (its value is never an
        // address: destructuring one is an error)
        const edits: Edit[] = [];
        forEachChild(node, child => {
          if (child === node.initializer || isErased(child)) return;
          const ir = this.visit(child);
          if (!isIdentity(ir, child)) edits.push(this.editOf(child, ir));
        });
        const initializer = this.fullExpression(node.initializer, Ctx.AtOnce);
        if (initializer && !isIdentity(initializer, node.initializer))
          edits.push(this.editOf(node.initializer, initializer));
        return this.src(node, edits);
      }
      case K.PropertyDeclaration: {
        const edits: Edit[] = [];
        forEachChild(node, child => {
          if (child === node.initializer || isErased(child)) return;
          const ir = this.visit(child);
          if (!isIdentity(ir, child)) edits.push(this.editOf(child, ir));
        });
        // its temporaries its own: each construction runs it, and one may
        // construct another (`(() => { var _a; return E; })()`)
        const scope = this.pushScope();
        let initializer = this.fullExpression(node.initializer, Ctx.AtOnce);
        this.popScope();
        if (initializer && scope.temps.length > 0)
          initializer = call(
            paren(
              gen(Prec.Assignment, [
                '() => {',
                varsStatement(scope),
                returnStatement(initializer),
                '\n}',
              ]),
            ),
            [],
          );
        if (initializer && !isIdentity(initializer, node.initializer))
          edits.push(this.editOf(node.initializer, initializer));
        return this.src(node, edits);
      }
      case K.ExportAssignment:
        return this.update(node, [
          [node.expression, this.fullExpression(node.expression, Ctx.AtOnce)],
        ]);
      case K.ArrowFunction:
      case K.FunctionExpression:
        return this.visitClosure(node);
      case K.ShorthandPropertyAssignment:
        return this.lower(node, ctx);
      case K.FunctionDeclaration:
      case K.MethodDeclaration:
      case K.Constructor:
      case K.GetAccessor:
      case K.SetAccessor:
      case K.ClassStaticBlockDeclaration:
      case K.ClassDeclaration:
      case K.ClassExpression: {
        this.pushFrame(null);
        const scoped =
          isFunctionLikeDeclaration(node) ||
          node.kind === K.ClassStaticBlockDeclaration;
        if (scoped) this.pushScope();
        const result = this.visitEachChild(node);
        if (scoped) this.popScope();
        this.popFrame();
        return result;
      }
    }
    if (isExpression(node)) {
      const fn = conciseBodyOf(node);
      if (fn) return this.visitConciseBody(node, fn);
      return this.visitExpression(node, ctx);
    }
    return this.visitEachChild(node);
  }

  private pushScope(): Scope {
    const scope: Scope = {temps: []};
    this.scopes.push(scope);
    this.allScopes.push(scope);
    return scope;
  }

  private popScope(): void {
    this.scopes.pop();
  }

  // AddVariableDeclaration: a temporary of the innermost function.
  private newTemp(): Temp {
    let scope = this.scopes[this.scopes.length - 1]!;
    if (!this.allScopes.includes(scope)) this.allScopes.push(scope);
    const temp: Temp = {scope};
    scope.temps.push(temp);
    return temp;
  }

  // Visits an expression in a context.
  private visitIn(node: Node | undefined, ctx: Ctx): Ir | undefined {
    if (!node) return undefined;
    return this.visit(node, ctx);
  }

  private visitStatement(node: Node): Ir {
    return this.visit(node);
  }

  // VisitEmbeddedStatement: statements in a statement's place make a block.
  private visitEmbedded(node: Node | undefined): Ir | undefined {
    if (!node) return undefined;
    const ir = this.visit(node);
    return embedded(ir);
  }

  // Visits an expression, applying its box, unbox or null conversion.
  private visitExpression(node: Node, ctx: Ctx): Ir {
    switch (this.r.conversion(node)) {
      case Conversion.Box:
        // the raw value is used at once by `__box`; the handle holds a count
        // of its own
        return this.call('__box', this.visitValue(node, Ctx.AtOnce));
      case Conversion.Unbox: {
        // `__unbox(E)` is a stable borrow
        const unboxed = this.call('__unbox', this.visitValue(node, Ctx.AtOnce));
        return this.count(unboxed, Count.Stable, ctx);
      }
      case Conversion.Zero:
        return this.zero(node);
    }
    return this.visitValue(node, ctx);
  }

  // Visits an expression without its conversion: lowers it, and counts it in
  // its context.
  private visitValue(node: Node, ctx: Ctx): Ir {
    switch (node.kind) {
      case K.ParenthesizedExpression:
      case K.AsExpression:
      case K.SatisfiesExpression:
      case K.NonNullExpression:
      case K.TypeAssertionExpression:
        // (PartiallyEmittedExpression, for the type assertions)
        return this.update(node, [
          [node.expression, this.visitIn(node.expression, ctx)],
        ]);
      case K.CallExpression:
        if (this.r.isConsumeCall(node)) {
          // `consume(x)` is x at run time
          return this.visit(node.arguments[0], ctx);
        }
    }
    const count = this.r.rawCount(node);
    switch (node.kind) {
      case K.ConditionalExpression:
        return this.visitConditional(node, count, ctx);
      case K.BinaryExpression:
        switch (node.operatorToken.kind) {
          case K.BarBarToken:
          case K.AmpersandAmpersandToken:
          case K.QuestionQuestionToken:
            return this.visitLogical(node, count, ctx);
          case K.CommaToken: {
            const left = this.visitIn(node.left, Ctx.Discard);
            const right = this.visitIn(node.right, ctx);
            return this.update(node, [
              [node.left, left],
              [node.right, right],
            ]);
          }
        }
    }
    return this.count(this.lower(node, ctx), count, ctx);
  }

  // An expression that runs only sometimes: the temporaries its cleanup
  // releases are 0 until it does.
  private visitConditionally(node: Node): Ir {
    this.conditional++;
    const ir = this.visit(node);
    this.conditional--;
    return ir;
  }

  private visitConditional(node: Node, count: Count, ctx: Ctx): Ir {
    const [operands, whole] = operandContext(count, ctx);
    const condition = this.visitIn(node.condition, Ctx.AtOnce);
    this.conditional++;
    const whenTrue = this.visitIn(node.whenTrue, operands);
    const whenFalse = this.visitIn(node.whenFalse, operands);
    this.conditional--;
    const result = this.update(node, [
      [node.condition, condition],
      [node.whenTrue, whenTrue],
      [node.whenFalse, whenFalse],
    ]);
    return whole ? this.count(result, count, ctx) : result;
  }

  // `a || b`, `a ?? b` (`||` on an address, where null is 0) and `a && b`.
  private visitLogical(node: Node, count: Count, ctx: Ctx): Ir {
    const op = node.operatorToken.kind;
    const [operands, whole] = operandContext(count, ctx);
    const leftContext =
      op === K.AmpersandAmpersandToken ? Ctx.AtOnce : operands;
    let operator: Ir | undefined;
    if (
      op === K.QuestionQuestionToken &&
      this.r.count(node.left) !== Count.None &&
      this.r.conversion(node.left) === Conversion.None
    )
      operator = raw('||');
    const left = this.visitIn(node.left, leftContext);
    this.conditional++;
    const right = this.visitIn(node.right, operands);
    this.conditional--;
    const result = this.update(node, [
      [node.left, left],
      [node.operatorToken, operator],
      [node.right, right],
    ]);
    return whole ? this.count(result, count, ctx) : result;
  }

  // Counts a lowered raw address in its context (see the table above).
  private count(expr: Ir, count: Count, ctx: Ctx): Ir {
    switch (count) {
      case Count.Owned:
        switch (ctx) {
          case Ctx.Take:
          case Ctx.Return:
            return expr;
          case Ctx.Discard:
            return this.call('__release', expr);
        }
        return this.temporary(expr);
      case Count.Stable:
      case Count.OwnedLocal:
        switch (ctx) {
          case Ctx.Take:
            return this.call('__retain', expr);
          case Ctx.Return:
            if (count === Count.OwnedLocal && isIdentifierIr(expr))
              return this.move(expr);
            return this.call('__retain', expr);
        }
        break;
      case Count.Unstable:
        switch (ctx) {
          case Ctx.Take:
          case Ctx.Return:
            return this.call('__retain', expr);
          case Ctx.Argument:
            return this.temporary(this.call('__retain', expr));
        }
    }
    return expr;
  }

  // `(_a = E)`, released after the full expression. Without a full expression
  // around (a decorator, a computed property name), E is left uncounted.
  private temporary(expr: Ir): Ir {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return expr;
    const temp = this.newTemp();
    frame.released.push(temp);
    if (this.conditional > 0) frame.zeroed.push(temp);
    return paren(this.assign(tempRef(temp), expr));
  }

  // Drops the parentheses around a temporary's assignment where it is an
  // argument.
  private unparen(expr: Ir): Ir {
    if (
      isGen(expr) &&
      expr.tag?.t === 'paren' &&
      isGen(expr.tag.inner) &&
      expr.tag.inner.tag?.t === 'binary' &&
      expr.tag.inner.tag.op === '='
    )
      return expr.tag.inner;
    return expr;
  }

  // `(_t = x, x = 0, _t)`: an owned local's count moves out.
  private move(x: Ir): Ir {
    const temp = this.newTemp();
    return paren(
      comma([
        this.assign(tempRef(temp), x),
        this.assign(x, num(0)),
        tempRef(temp),
      ]),
    );
  }

  // null or undefined where an address is expected: 0 (after any side
  // effects).
  private zero(node: Node): Ir {
    const inner = skipOuterExpressions(node, OEK.All);
    if (
      inner.kind === K.NullKeyword ||
      (inner.kind === K.Identifier && inner.text === 'undefined') ||
      (inner.kind === K.VoidExpression &&
        isLiteralExpression(skipParentheses(inner.expression)))
    )
      return num(0);
    return paren(comma([this.visitValue(node, Ctx.Discard), num(0)]));
  }

  // A full expression of a statement or a declaration: the temporaries in it
  // are released after it, as `(_r = E, __release(_a), _r)`.
  private fullExpression(node: Node | undefined, ctx: Ctx): Ir | undefined {
    if (!node) return undefined;
    const frame = this.pushFrame({released: [], zeroed: [], conditional: 0});
    const result = this.visitIn(node, ctx)!;
    this.popFrame();
    return this.releaseAfter(result, frame, ctx !== Ctx.Discard);
  }

  private releaseAfter(expr: Ir, frame: Frame, keepValue: boolean): Ir {
    if (frame.released.length === 0) return expr;
    const expressions: Ir[] = [];
    for (const temp of frame.zeroed)
      expressions.push(this.assign(tempRef(temp), num(0)));
    let result: Temp | undefined;
    if (keepValue) {
      result = this.newTemp();
      expressions.push(this.assign(tempRef(result), expr));
    } else {
      expressions.push(expr);
    }
    for (const temp of frame.released)
      expressions.push(this.call('__release', tempRef(temp)));
    if (result) expressions.push(tempRef(result));
    return paren(comma(expressions));
  }

  private pushFrame<F extends Frame | null>(frame: F): F {
    if (frame) frame.conditional = this.conditional;
    this.frames.push(frame);
    this.conditional = 0;
    return frame;
  }

  private popFrame(): void {
    const frame = this.frames.pop();
    this.conditional = frame ? frame.conditional : 0;
  }

  // `E;`: an owned result is released; the temporaries are released by
  // statements that follow.
  private visitExpressionStatement(node: Node): Ir {
    const frame = this.pushFrame({released: [], zeroed: [], conditional: 0});
    const expression = this.visitIn(node.expression, Ctx.Discard);
    this.popFrame();
    const statement = this.update(node, [[node.expression, expression]]);
    if (frame.released.length === 0) return statement;
    const list: Ir[] = [];
    for (const temp of frame.zeroed)
      list.push(exprStatement(this.assign(tempRef(temp), num(0))));
    list.push(statement);
    for (const temp of frame.released)
      list.push(exprStatement(this.call('__release', tempRef(temp))));
    return statements(list);
  }

  // A variable declaration: an owned local takes its initial value (+1), and
  // a counted local without one starts at 0.
  private visitVariableDeclaration(node: Node): Ir {
    const local = this.r.local(node);
    const parentStatement = (node.parent as Node | undefined)?.parent as
      | Node
      | undefined;
    const inForInOrOf =
      parentStatement?.kind === K.ForInStatement ||
      parentStatement?.kind === K.ForOfStatement;
    const ctx =
      local === Local.Owned ||
      local === Local.OwnedMoved ||
      local === Local.Module
        ? Ctx.Take
        : Ctx.AtOnce;
    const initializer = this.fullExpression(node.initializer, ctx);
    const name = this.visit(node.name);
    const edits: Edit[] = [];
    if (!isIdentity(name, node.name)) edits.push(this.editOf(node.name, name));
    if (initializer) {
      if (!isIdentity(initializer, node.initializer))
        edits.push(this.editOf(node.initializer, initializer));
    } else if (local !== Local.None && !inForInOrOf) {
      edits.push({start: node.end, end: node.end, ir: raw(' = 0')});
    }
    return this.src(node, edits);
  }

  // `const` becomes `let` when a return moves an owned local's count out.
  private visitVariableDeclarationList(node: Node): Ir {
    const result = this.visitEachChild(node) as Src;
    if (!(node.flags & NodeFlags.Const)) return result;
    for (const decl of node.declarations as Node[]) {
      if (this.r.local(decl) === Local.OwnedMoved) {
        const start = this.startOf(node);
        if (this.text.startsWith('const', start))
          result.edits.unshift({start, end: start + 5, ir: raw('let')});
        return result;
      }
    }
    return result;
  }

  // A function's parameters, visited all at once at its first (by the
  // others, the result for each). Once a default or pattern moves into the
  // body, those after it move too, so that they run in order; if one before
  // it has a default or a pattern, the list is visited again with all of
  // them moving, so that they all run in the body's scope (a closure in an
  // earlier default sees a pattern's bindings: TypeScript's ES5 lowering).
  private visitParameter(node: Node): Ir {
    const visited = this.paramIrs.get(node);
    if (visited) {
      this.paramIrs.delete(node);
      return visited;
    }
    const fn = node.parent as Node;
    const params = (fn.parameters as Node[]).filter(p => !isErased(p));
    if (
      !fn.body ||
      !isFunctionLikeDeclaration(fn) ||
      params[0] !== node ||
      params.length < 2
    )
      return this.visitParameterOnce(node);
    const scope = this.scopes[this.scopes.length - 1]!;
    const temps = scope.temps.length,
      scopes = this.allScopes.length;
    let irs = params.map(p => this.visitParameterOnce(p));
    const first = params.findIndex(
      p =>
        this.paramInits.has(p) ||
        this.movedDefaults.has(p) ||
        this.movedPatterns.has(p),
    );
    if (
      first > 0 &&
      params
        .slice(0, first)
        .some(
          p =>
            (p.initializer && !isConstant(p.initializer)) ||
            p.name.kind !== K.Identifier,
        )
    ) {
      scope.temps.length = temps;
      this.allScopes.length = scopes;
      for (const p of params) {
        this.paramInits.delete(p);
        this.movedDefaults.delete(p);
        this.movedPatterns.delete(p);
      }
      this.movingDefaults.add(fn);
      irs = params.map(p => this.visitParameterOnce(p));
    }
    params.forEach((p, i) => {
      if (i > 0) this.paramIrs.set(p, irs[i]!);
    });
    return irs[0]!;
  }

  // A parameter: the default value of an owned parameter moves into the
  // function's body.
  private visitParameterOnce(node: Node): Ir {
    const fn = node.parent as Node;
    const pattern = node.name.kind !== K.Identifier;
    const lowerable = !!fn.body && isFunctionLikeDeclaration(fn);
    let name: Ir = this.src(node.name);
    const edits: Edit[] = [];
    const scope = this.scopes[this.scopes.length - 1]!;
    const temps = scope.temps.length;
    forEachChild(node, child => {
      if (child === node.initializer || isErased(child)) return;
      const ir = this.visit(child);
      if (child === node.name) name = ir;
      if (!isIdentity(ir, child)) edits.push(this.editOf(child, ir));
    });
    // after a default that moved into the body, or with defaults in it whose
    // temporaries are the body's, a binding pattern is a temporary
    // parameter, destructured there in order
    if (
      pattern &&
      lowerable &&
      (this.movingDefaults.has(fn) || scope.temps.length > temps)
    ) {
      this.movingDefaults.add(fn);
      return this.lowerPattern(node, name, undefined);
    }
    if (node.initializer) {
      // ` = init` goes, and the parameter is optional (`p?: T`, stripped
      // with the types), so that one after it with no default may still
      // follow an optional one
      const before = node.type ?? node.questionToken ?? node.name;
      const optional = node.questionToken || node.type ? '' : '?';
      const remove = {
        start: before.end,
        end: node.initializer.end,
        ir: raw(optional),
      };
      const drop = () => {
        if (node.type && !node.questionToken)
          edits.push({start: node.name.end, end: node.name.end, ir: raw('?')});
        edits.push(remove);
      };
      const local = this.r.local(node);
      if (local === Local.Owned || local === Local.OwnedMoved) {
        this.paramInits.set(node, node.initializer);
        this.movingDefaults.add(fn);
        drop();
      } else if (
        lowerable &&
        this.movingDefaults.has(fn) &&
        !isConstant(node.initializer)
      ) {
        // after a default that moved: visited in the body, in order
        this.movedDefaults.set(node, undefined);
        drop();
      } else {
        const initializer = this.fullExpression(node.initializer, Ctx.AtOnce)!;
        if (lowerable && scope.temps.length > temps) {
          // its temporaries are the body's: it moves there, as the fork's
          // emit moves it (`if (n === void 0) { n = ...; }`)
          this.movingDefaults.add(fn);
          if (pattern) return this.lowerPattern(node, name, initializer);
          this.movedDefaults.set(node, initializer);
          drop();
        } else if (!isIdentity(initializer, node.initializer))
          edits.push(this.editOf(node.initializer, initializer));
      }
    }
    return this.src(node, edits);
  }

  // A binding-pattern parameter as a temporary one (`..._a` for a rest),
  // which the body destructures in its place among the defaults.
  private lowerPattern(node: Node, pattern: Ir, init: Ir | undefined): Ir {
    const temp = this.newTemp();
    this.movedPatterns.set(node, {temp, pattern, init});
    // `_a?`, as a parameter after it may have no default
    const ir = node.dotDotDotToken
      ? tempRef(temp)
      : gen(Prec.Primary, [tempRef(temp), '?']);
    return this.src(node, [
      {start: this.startOf(node.name), end: node.end, ir},
    ]);
  }

  // `=> E`: a function's result, or a block if the function owns a parameter.
  private visitConciseBody(node: Node, fn: Node): Ir {
    const prologue = this.functionPrologue(fn);
    const frame = this.pushFrame({released: [], zeroed: [], conditional: 0});
    let result = this.visitExpression(node, Ctx.Return);
    this.popFrame();
    result = this.moved(this.releaseAfter(result, frame, true), node);
    if (prologue.length === 0) return result;
    return block(this.guarded(prologue, [returnStatement(result)]));
  }

  // `__moved(E)` where a function's result moves into the runtime with its
  // count.
  private moved(result: Ir, expression: Node): Ir {
    if (this.r.isMovedReturn(expression)) return this.call('__moved', result);
    return result;
  }

  // The statements a function body starts with for its counted parameters:
  // an owned parameter is retained (or takes its default value), and an
  // optional borrowed one that is omitted is 0. Returns the owned
  // parameters' names, which the body releases.
  private functionPrologue(fn: Node): PrologueEntry[] {
    const entries: PrologueEntry[] = [];
    const prologue = {
      push: (ir: Ir, mayThrow = true) => entries.push({ir, mayThrow}),
    };
    for (const param of fn.parameters as Node[]) {
      const name = param.name as Node;
      const moved = this.movedPatterns.get(param);
      if (moved) {
        // `var {x} = _a === void 0 ? init : _a;`
        let value: Ir = tempRef(moved.temp);
        if (param.initializer) {
          const init =
            moved.init ?? this.fullExpression(param.initializer, Ctx.AtOnce)!;
          value = cond(
            binary(tempRef(moved.temp), '===', raw('void 0', Prec.Unary)),
            copyOf(init),
            tempRef(moved.temp),
          );
        }
        prologue.push(
          gen(Prec.Primary, [
            '\nvar ',
            copyOf(moved.pattern),
            ' = ',
            value,
            ';',
          ]),
        );
        continue;
      }
      if (!name || name.kind !== K.Identifier) continue;
      if (this.movedDefaults.has(param)) {
        // `if (p === void 0) { p = init; }`, in the parameters' order
        const init =
          this.movedDefaults.get(param) ??
          this.fullExpression(param.initializer, Ctx.AtOnce)!;
        prologue.push(
          gen(Prec.Primary, [
            '\nif (',
            binary(this.name(name), '===', raw('void 0', Prec.Unary)),
            ') {',
            exprStatement(this.assign(this.name(name), copyOf(init))),
            '\n}',
          ]),
        );
        continue;
      }
      switch (this.r.local(param)) {
        case Local.Owned:
        case Local.OwnedMoved: {
          let value: Ir = this.call('__retain', this.name(name));
          const init = this.paramInits.get(param);
          if (init)
            value = cond(
              binary(this.name(name), '===', raw('void 0', Prec.Unary)),
              this.fullExpression(init, Ctx.Take)!,
              value,
            );
          entries.push({
            ir: exprStatement(this.assign(this.name(name), value)),
            mayThrow: !!init,
            owned: name,
          });
          break;
        }
        case Local.Borrowed:
          if (param.questionToken)
            prologue.push(
              exprStatement(binary(this.name(name), '??=', num(0))),
              false,
            );
      }
    }
    return entries;
  }

  // A function's prologue and then its body, each owned parameter released
  // in a finally from when it is retained: around the body, and around the
  // rest of the prologue where that may throw (a default after it).
  private guarded(entries: PrologueEntry[], body: Ir[]): Ir[] {
    const out: Ir[] = [];
    const owned: Node[] = [];
    for (const [i, entry] of entries.entries()) {
      if (entry.mayThrow && owned.length > 0)
        return [
          ...out,
          this.tryFinally(this.guarded(entries.slice(i), body), owned),
        ];
      out.push(entry.ir);
      if (entry.owned) owned.push(entry.owned);
    }
    if (owned.length > 0) return [...out, this.tryFinally(body, owned)];
    return [...out, ...body];
  }

  // A block: owned locals are released when it ends, and a function body
  // retains and releases its owned parameters (and declares the function's
  // temporaries).
  private visitBlock(node: Node): Ir {
    let prologue: PrologueEntry[] = [];
    let list = node.statements as Node[];
    const parent = node.parent as Node | undefined;
    const isBody =
      !!parent &&
      (isFunctionLikeDeclaration(parent) ||
        parent.kind === K.ClassStaticBlockDeclaration) &&
      parent.body === node;
    const moving = isBody && this.movingDefaults.has(parent!);
    if (isBody && isFunctionLikeDeclaration(parent))
      prologue = this.functionPrologue(parent!);
    if (moving) this.renameShadowingVars(parent!, node);
    const directives: Node[] = [];
    if (prologue.length > 0 || isBody) {
      while (list.length > 0 && isPrologueDirective(list[0]!)) {
        directives.push(list[0]!);
        list = list.slice(1);
      }
    }
    let result = this.visitStatements(list);
    // after defaults that moved into the body, the body in a block of its
    // own, so that its declarations neither shadow what they read nor put
    // it in their temporal dead zone
    if (moving && this.bodyShadows(parent!, list)) result = [block(result)];
    // the whole body is in the try, its function declarations in place
    // (the fork moves them ahead of it)
    result = this.guarded(prologue, result);
    const head: Ir[] = directives.map(d => this.src(d));
    if (isBody) {
      // the function's temporaries, declared once it is visited
      const scope = this.scopes[this.scopes.length - 1]!;
      head.push(varsStatement(scope));
    }
    result = [...head, ...result];
    return this.withStatements(node, node.statements, result, []);
  }

  // The node with its statement list replaced by list (if it changed).
  private withStatements(
    node: Node,
    nodes: any,
    list: Ir[],
    parts: [Node | undefined, Ir | undefined][],
  ): Ir {
    const result = this.update(node, parts) as Src;
    const original = nodes as Node[];
    const same =
      list.length === original.length &&
      list.every((ir, i) => isIdentity(ir, original[i]!));
    if (!same) {
      const start = nodes.pos as number,
        end = nodes.end as number;
      result.edits.push({
        start,
        end,
        ir: gen(Prec.Primary, list, {t: 'stmts', list}),
      });
      result.edits.sort((a, b) => a.start - b.start || a.end - b.end);
    }
    return result;
  }

  // Visits a block's statements: the statements after a declaration of owned
  // locals are wrapped in `try { ... } finally { __release(x) }`, and a nested
  // function declaration that captures counted variables is held
  // (`__capture(f, x)`) as soon as they are declared.
  private visitStatements(list: Node[]): Ir[] {
    const holds = this.holdStatements(list);
    if (this.splitsScope(list)) return this.visitStatementsFlat(list, holds);
    interface Level {
      statements: Ir[];
      owned: Node[];
      nodes: Node[]; // the statements after its owned locals' declaration
    }
    const levels: Level[] = [{statements: [], owned: [], nodes: []}];
    let top = levels[0]!;
    top.statements.push(...(holds.get(-1) ?? []));
    list.forEach((statement, i) => {
      const visited = this.visitStatement(statement);
      if (isGen(visited) && visited.tag?.t === 'stmts')
        top.statements.push(...visited.tag.list);
      else top.statements.push(visited);
      const owned = this.ownedLocalsOf(statement);
      if (owned.length > 0) {
        top = {statements: [], owned, nodes: []};
        levels.push(top);
      } else top.nodes.push(statement);
      top.statements.push(...(holds.get(i) ?? []));
    });
    // the lexical names declared in each level's try and the ones inside it
    const declared: Set<string>[] = [];
    for (let i = levels.length - 1, names = new Set<string>(); i > 0; i--) {
      for (const n of lexicalNames(levels[i]!.nodes)) names.add(n);
      declared[i] = new Set(names);
    }
    for (let i = levels.length - 1; i > 0; i--) {
      const inner = levels[i]!,
        outer = levels[i - 1]!;
      const [functions, rest] = splitFunctionDeclarations(
        inner.statements,
        declared[i]!,
      );
      outer.statements.push(...functions);
      if (rest.length === 0)
        outer.statements.push(...this.releases(inner.owned));
      else outer.statements.push(this.tryFinally(rest, inner.owned));
    }
    return levels[0]!.statements;
  }

  // Reports whether the nested trys of visitStatements would split the
  // block's lexical scope: whether a statement before an owned local's try
  // (or a function declaration that moves ahead of it) reads a name that is
  // declared in the try (`const read = () => n; const p = new P(); const n =
  // 7;`).
  private splitsScope(list: Node[]): boolean {
    // each statement's level: the try it is in (a declaration of owned
    // locals is in the one around its own)
    const levels: number[] = [];
    let level = 0;
    for (const statement of list) {
      levels.push(level);
      const owned = this.ownedLocalsOf(statement);
      if (owned.length === 0) continue;
      if (owned.some(n => n.kind !== K.Identifier)) return false;
      level++;
    }
    for (let i = 1; i <= level; i++) {
      const inner = list.filter((_, j) => levels[j]! >= i);
      const outer = list.filter((_, j) => levels[j]! < i);
      // the names declared in the try: its lexical declarations, and its
      // function declarations that read them (the others move ahead of it)
      const names = lexicalNames(inner);
      const fns = inner.filter(s => s.kind === K.FunctionDeclaration);
      for (let changed = true; changed;) {
        changed = false;
        for (const f of fns)
          if (f.name && !names.has(f.name.text) && readsAny(f, names)) {
            names.add(f.name.text);
            changed = true;
          }
      }
      if (outer.some(s => readsAny(s, names))) return true;
    }
    return false;
  }

  // visitStatements for a block whose trys would split its scope: one try
  // around all of it, the owned locals declared (as 0) ahead of it and
  // assigned where they were declared, function declarations in place.
  private visitStatementsFlat(list: Node[], holds: Map<number, Ir[]>): Ir[] {
    const owned: Node[] = [];
    const statements: Ir[] = [...(holds.get(-1) ?? [])];
    list.forEach((statement, i) => {
      const names = this.ownedLocalsOf(statement);
      if (names.length === 0) {
        const visited = this.visitStatement(statement);
        if (isGen(visited) && visited.tag?.t === 'stmts')
          statements.push(...visited.tag.list);
        else statements.push(visited);
      } else {
        owned.push(...names);
        const declarationList = statement.declarationList as Node;
        const keyword =
          declarationList.flags & NodeFlags.Const ? 'const' : 'let';
        for (const decl of declarationList.declarations as Node[]) {
          if (names.includes(decl.name)) {
            const init = this.fullExpression(decl.initializer, Ctx.Take);
            if (init)
              statements.push(
                exprStatement(this.assign(this.name(decl.name), init)),
              );
          } else
            statements.push(
              gen(Prec.Primary, [
                `\n${keyword} `,
                this.visitVariableDeclaration(decl),
                ';',
              ]),
            );
        }
      }
      statements.push(...(holds.get(i) ?? []));
    });
    const declarations = gen(Prec.Primary, [
      '\nlet ',
      ...owned.flatMap((n, i) => [i > 0 ? ', ' : '', this.name(n), ' = 0']),
      ';',
    ]);
    return [declarations, this.tryFinally(statements, owned)];
  }

  // The names of the owned locals a statement declares.
  private ownedLocalsOf(statement: Node): Node[] {
    if (statement.kind !== K.VariableStatement) return [];
    return this.ownedLocalsOfList(statement.declarationList);
  }

  private ownedLocalsOfList(list: Node): Node[] {
    const owned: Node[] = [];
    for (const decl of list.declarations as Node[]) {
      const local = this.r.local(decl);
      if (local === Local.Owned || local === Local.OwnedMoved)
        owned.push(decl.name);
    }
    return owned;
  }

  // The `__capture(f, x, ...)` statements for the function declarations among
  // statements that capture counted variables, by the index of the statement
  // they follow (-1: the start): after the last of those variables declared
  // among the statements.
  private holdStatements(list: Node[]): Map<number, Ir[]> {
    const holds = new Map<number, Ir[]>();
    for (const statement of list) {
      if (statement.kind !== K.FunctionDeclaration || !statement.name) continue;
      const captures = this.r.captures(statement);
      if (captures.length === 0) continue;
      let after = -1;
      list.forEach((s, i) => {
        if (s.kind !== K.VariableStatement) return;
        for (const decl of s.declarationList.declarations as Node[])
          if (captures.includes(decl)) after = Math.max(after, i);
      });
      const args: Ir[] = [this.name(statement.name)];
      for (const decl of captures) args.push(this.name(decl.name));
      const held = holds.get(after) ?? [];
      held.push(exprStatement(this.call('__capture', ...args)));
      holds.set(after, held);
    }
    return holds;
  }

  private releases(owned: Node[]): Ir[] {
    const list: Ir[] = [];
    for (let i = owned.length - 1; i >= 0; i--)
      list.push(exprStatement(this.call('__release', this.name(owned[i]!))));
    return list;
  }

  private tryFinally(list: Ir[], owned: Node[]): Ir {
    return gen(Prec.Primary, [
      '\ntry {',
      ...list,
      '\n}\nfinally {',
      ...this.releases(owned),
      '\n}',
    ]);
  }

  // The owned locals a `for` statement declares in its head.
  private ownedLocalsOfFor(node: Node): Node[] {
    const init = node.initializer as Node | undefined;
    if (!init || init.kind !== K.VariableDeclarationList) return [];
    return this.ownedLocalsOfList(init);
  }

  // `for (init; cond; update) body`. Owned locals declared in the head move
  // out of the loop, which is wrapped in `try { ... } finally { ... }`.
  // label: the outermost of the loop's labels.
  private visitForStatement(node: Node, label: Node | undefined): Ir {
    const owned = this.ownedLocalsOfFor(node);
    const init = node.initializer as Node | undefined;
    const initializer =
      init && init.kind === K.VariableDeclarationList
        ? this.visit(init)
        : this.fullExpression(init, Ctx.Discard);
    const condition = this.fullExpression(node.condition, Ctx.AtOnce);
    const incrementor = this.fullExpression(node.incrementor, Ctx.Discard);
    const body = this.visitLoopBody(node.statement, node);
    if (owned.length === 0)
      return this.update(node, [
        [init, initializer],
        [node.condition, condition],
        [node.incrementor, incrementor],
        [node.statement, body],
      ]);
    // the loop without its initializer
    const loopEdits: Edit[] = [
      {start: this.startOf(init!), end: init!.end, ir: raw('')},
    ];
    for (const [child, ir] of [
      [node.condition, condition],
      [node.incrementor, incrementor],
      [node.statement, body],
    ] as [Node | undefined, Ir | undefined][]) {
      if (child && ir && !isIdentity(ir, child))
        loopEdits.push(this.editOf(child, ir));
    }
    let loop: Ir = this.src(node, loopEdits);
    if (label)
      loop = this.src(label, [
        {start: this.startOf(node), end: node.end, ir: loop},
      ]);
    // the declarations, copied ahead of the loop
    const declarations = gen(Prec.Primary, ['\n', copyOf(initializer!), ';']);
    return block([declarations, this.tryFinally([loop], owned)]);
  }

  // A loop's body. A for-of variable that owns each value (received from a
  // channel) is released when the iteration ends, and the iteration ends at
  // a quiescent point if the loop reads or stores a reference field.
  private visitLoopBody(body: Node, loop: Node): Ir {
    let visited = embedded(this.visit(body))!;
    if (
      loop.kind === K.ForOfStatement &&
      loop.initializer.kind === K.VariableDeclarationList
    ) {
      const owned = this.ownedLocalsOfList(loop.initializer);
      if (owned.length > 0) {
        const list = this.blockStatements(visited, body) ?? [visited];
        visited = this.replaceBody(body, visited, [
          this.tryFinally(list, owned),
        ]);
      }
    }
    if (!this.r.isQuiescentLoop(loop)) return visited;
    const list = this.blockStatements(visited, body);
    if (list)
      return this.replaceBody(body, visited, [...list, this.quiescent()]);
    return block([visited, this.quiescent()]);
  }

  // The statements of a visited block (or of a block that replaced a
  // statement); undefined for any other statement.
  private blockStatements(visited: Ir, body: Node): Ir[] | undefined {
    if (isGen(visited) && visited.tag?.t === 'block') return visited.tag.list;
    if (body.kind === K.Block && visited.k === 'src' && visited.node === body) {
      const edit = visited.edits.find(
        e => e.start === body.statements.pos && e.end === body.statements.end,
      );
      if (edit && isGen(edit.ir) && edit.ir.tag?.t === 'stmts')
        return edit.ir.tag.list;
      return (body.statements as Node[]).map(s => this.src(s));
    }
    return undefined;
  }

  // A loop body (a block, or what replaced it) with new statements.
  private replaceBody(body: Node, visited: Ir, list: Ir[]): Ir {
    if (body.kind === K.Block && visited.k === 'src' && visited.node === body) {
      // the block itself, with its statements replaced
      const edits = visited.edits.filter(
        e =>
          !(e.start === body.statements.pos && e.end === body.statements.end),
      );
      const result = this.src(body, edits);
      result.edits.push({
        start: body.statements.pos,
        end: body.statements.end,
        ir: gen(Prec.Primary, list, {t: 'stmts', list}),
      });
      return result;
    }
    return block(list);
  }

  private quiescent(): Ir {
    return exprStatement(this.call('__quiescent'));
  }

  // An arrow function or a function expression; one that captures counted
  // variables is held: `__capture(fn, x, ...)`.
  private visitClosure(node: Node): Ir {
    this.pushFrame(null);
    const scope = this.pushScope();
    let result = this.visitEachChild(node) as Src;
    this.popScope();
    this.popFrame();
    if (node.kind === K.ArrowFunction && node.body.kind !== K.Block) {
      // a concise body that declares temporaries is a block
      // (VisitFunctionBody)
      if (scope.temps.length > 0) result = this.withVars(node, result, scope);
    }
    const captures = this.r.captures(node);
    if (captures.length === 0) return result;
    const args: Ir[] = [result];
    for (const decl of captures) args.push(this.name(decl.name));
    return this.call('__capture', ...args);
  }

  // An arrow function whose concise body becomes `{ var _a; return E; }`
  // (or whose block, from visitConciseBody, starts with the var).
  private withVars(node: Node, result: Src, scope: Scope): Src {
    const body = node.body as Node;
    const at = result.edits.findIndex(
      e => e.start === this.startOf(body) && e.end === body.end,
    );
    const visited = at >= 0 ? result.edits[at]!.ir : this.src(body);
    let replacement: Ir;
    if (isGen(visited) && visited.tag?.t === 'block')
      replacement = block([varsStatement(scope), ...visited.tag.list]);
    else replacement = block([varsStatement(scope), returnStatement(visited)]);
    const edits = result.edits.filter((_, i) => i !== at);
    edits.push({start: this.startOf(body), end: body.end, ir: replacement});
    return this.src(node, edits);
  }

  private lower(node: Node, ctx: Ctx): Ir {
    switch (node.kind) {
      // (reached as a concise body: elsewhere visit() takes them first)
      case K.ArrowFunction:
      case K.FunctionExpression:
        return this.visitClosure(node);
      case K.ClassExpression: {
        this.pushFrame(null);
        const result = this.visitEachChild(node);
        this.popFrame();
        return result;
      }
      case K.NewExpression: {
        const lowered = this.lowerNew(node);
        if (lowered) return lowered;
        const expression = this.visit(node.expression);
        const args = this.visitArguments(node, false);
        return this.update(node, [[node.expression, expression], ...args]);
      }
      case K.CallExpression: {
        const structCall = this.r.structCall(node);
        if (structCall) return this.sharedStruct(structCall);
        const atomic = this.r.atomicCall(node);
        if (atomic) return this.lowerAtomic(node, atomic);
        const callee = this.visit(node.expression);
        const args = this.visitArguments(node, isOptionalChain(node));
        return this.update(node, [[node.expression, callee], ...args]);
      }
      case K.PropertyAccessExpression:
      case K.ElementAccessExpression: {
        const lowered = this.lowerAccess(node, false, undefined);
        if (lowered) return lowered;
        break;
      }
      case K.BinaryExpression:
        if (isAssignmentOperator(node.operatorToken.kind)) {
          const lowered = this.lowerAssignment(node, ctx);
          if (lowered) return lowered;
        }
        // `x ||= E`: E runs only sometimes
        if (isLogicalAssignment(node.operatorToken.kind)) {
          const left = this.visit(node.left);
          return this.update(node, [
            [node.left, left],
            [node.right, this.visitConditionally(node.right)],
          ]);
        }
        break;
      case K.PrefixUnaryExpression:
        if (
          node.operator === K.PlusPlusToken ||
          node.operator === K.MinusMinusToken
        ) {
          const operand = this.lowerAccess(node.operand, true, undefined);
          if (operand) return this.update(node, [[node.operand, operand]]);
        }
        break;
      case K.PostfixUnaryExpression: {
        const operand = this.lowerAccess(node.operand, true, undefined);
        if (operand) return this.update(node, [[node.operand, operand]]);
        break;
      }
      case K.VoidExpression:
        return this.update(node, [
          [node.expression, this.visitIn(node.expression, Ctx.Discard)],
        ]);
      case K.ShorthandPropertyAssignment: {
        // `{ b }` where b was renamed: `{ b: b_1 }`
        const renamed =
          this.renamed.size > 0 ? this.renamedName(node.name) : undefined;
        if (
          renamed !== undefined &&
          this.r.conversion(node.name) === Conversion.None
        )
          return gen(Prec.Primary, [raw(node.name.text), ': ', raw(renamed)]);
        // `{ b }` where b is boxed or unboxed: `{ b: __box(b) }`
        if (this.r.conversion(node.name) !== Conversion.None) {
          const value = this.visitExpression(node.name, Ctx.AtOnce);
          return gen(Prec.Primary, [raw(node.name.text), ': ', value]);
        }
        break;
      }
    }
    return this.visitEachChild(node);
  }

  // `struct({ a: f64, next: ref<T>(), ... })` as `__sharedStruct("S",
  // ["a", "next", ...], [1], "fr...")`: the reference fields' indexes, and
  // the fields' kinds if any is other than a number or a reference.
  private sharedStruct(structCall: StructCall): Ir {
    const layout = structCall.layout;
    const fields = arrayLiteral(layout.fields.map(str));
    const refs: Ir[] = [];
    layout.kinds.forEach((kind, k) => {
      if (kind === 'r') refs.push(num(k));
    });
    const args: Ir[] = [str(structCall.name), fields, arrayLiteral(refs)];
    const letters = kindLetters(layout);
    if (letters !== '') args.push(str(letters));
    return this.call('__sharedStruct', ...args);
  }

  // `atomic.add(s, "f", V)` as `Atomics.add(__I32, (S >> 2) + 2 + 2 * k, V)`,
  // and `atomic.add(a, I, V)` as `Atomics.add(__I32, ((A + 16) >> 2) +
  // (CHECK ? I : __outOfBounds[I]), V)`.
  private lowerAtomic(node: Node, atomic: AtomicCall): Ir {
    const args = node.arguments as Node[];
    const rest = args.slice(2);
    // the struct or the array is used at once, unless a value is computed by
    // a call, which may reach a quiescent point
    let objectContext: Ctx = Ctx.AtOnce;
    if (
      rest.some(a => this.containsCall(a)) ||
      (atomic.field < 0 && this.containsCall(args[1]))
    )
      objectContext = Ctx.Argument;
    const temps: Ir[] = [];
    let index: Ir;
    if (atomic.field >= 0) {
      const object = this.visitIn(args[0], objectContext)!;
      index = binary(
        paren(binary(object, '>>', num(2))),
        '+',
        num(2 + 2 * atomic.field),
      );
    } else {
      const a = this.copiable(
        this.receiver(args[0]!, objectContext, args.slice(1)),
        temps,
      );
      const i = this.copiable(this.visit(args[1]!), temps);
      const base = paren(binary(paren(binary(a, '+', num(16))), '>>', num(2)));
      index = binary(
        base,
        '+',
        paren(cond(this.inBounds(a, i), i, this.oob(i))),
      );
    }
    const operands: Ir[] = [helperRef('__I32'), index];
    for (const arg of rest) operands.push(this.visit(arg));
    const op = call(raw(`Atomics.${atomic.op}`, Prec.Member), operands);
    return this.sequence(temps, op);
  }

  // The arguments of a call: a counted argument the callee takes a count of
  // is `__countedRef(E)`; an unstable borrow is retained around the call.
  private visitArguments(
    node: Node,
    conditional: boolean,
  ): [Node | undefined, Ir | undefined][] {
    const args = node.arguments as Node[] | undefined;
    if (!args) return [];
    if (conditional) this.conditional++;
    const visited: [Node, Ir][] = [];
    for (const arg of args) {
      if (arg.kind === K.SpreadElement) visited.push([arg, this.visit(arg)]);
      else if (this.r.isRefArgument(arg))
        visited.push([
          arg,
          this.call('__countedRef', this.visitIn(arg, Ctx.AtOnce)!),
        ]);
      else visited.push([arg, this.unparen(this.visitIn(arg, Ctx.Argument)!)]);
    }
    if (conditional) this.conditional--;
    return visited;
  }

  // Assignments to struct fields, SharedArray elements and counted variables;
  // undefined for any other.
  private lowerAssignment(node: Node, ctx: Ctx): Ir | undefined {
    const operator = node.operatorToken.kind;
    const left = skipParentheses(node.left);
    if (
      left.kind === K.PropertyAccessExpression &&
      this.r.isReferenceField(left)
    ) {
      // __store((E >> 2) + 2k + 2, V'), V' taking a count
      const access = this.lowerAccess(left, true, node.right);
      if (!access) return undefined;
      const index = elemIndex(access);
      switch (operator) {
        case K.EqualsToken:
          return this.call(
            '__store',
            index,
            this.visitIn(node.right, Ctx.Take)!,
          );
        case K.BarBarEqualsToken:
        case K.QuestionQuestionEqualsToken:
        case K.AmpersandAmpersandEqualsToken: {
          const temps: Ir[] = [];
          const i = this.copiable(index, temps);
          this.conditional++;
          const value = this.visitIn(node.right, Ctx.Take)!;
          this.conditional--;
          const logical =
            operator === K.AmpersandAmpersandEqualsToken ? '&&' : '||';
          const read = this.i32(i);
          return this.sequence(
            temps,
            binary(read, logical, this.call('__store', i, value)),
          );
        }
      }
      return undefined;
    }
    const kind = this.convertedTarget(left);
    if (kind !== '')
      return this.lowerConvertedAssignment(node, left, ctx, kind);
    if (this.isBooleanTarget(left)) {
      switch (operator) {
        case K.BarBarEqualsToken:
        case K.AmpersandAmpersandEqualsToken:
        case K.QuestionQuestionEqualsToken: {
          // __U8[I] !== 0 || (__U8[I] = V): the value is a boolean
          const access = this.lowerAccess(left, true, node.right);
          if (!access) return undefined;
          const temps: Ir[] = [];
          const i = this.copiable(elemIndex(access), temps);
          const read = isTrue(this.u8(i));
          if (operator === K.QuestionQuestionEqualsToken)
            return this.sequence(temps, read); // a boolean is never null
          const logical =
            operator === K.AmpersandAmpersandEqualsToken ? '&&' : '||';
          this.conditional++;
          const value = this.visit(node.right);
          this.conditional--;
          const store = paren(this.assign(this.u8(i), value));
          return this.sequence(temps, binary(read, logical, store));
        }
      }
    }
    const lowered = this.lowerAccess(left, true, node.right);
    if (lowered) {
      const right = isLogicalAssignment(operator)
        ? this.visitConditionally(node.right)
        : this.visit(node.right);
      return this.update(node, [
        [node.left, lowered],
        [node.right, right],
      ]);
    }
    if (left.kind === K.Identifier) {
      switch (this.r.local(left)) {
        case Local.Owned:
        case Local.OwnedMoved:
        case Local.Module:
          return this.lowerLocalAssignment(node, left, ctx);
      }
    }
    return undefined;
  }

  // `x = E` for an owned local: the new value is retained before the old is
  // released, `_t = x, x = E', __release(_t)`. `x ||= E` is `x || (x = E')`.
  private lowerLocalAssignment(node: Node, x: Node, ctx: Ctx): Ir | undefined {
    const operator = node.operatorToken.kind;
    const replace = (value: Ir, keepValue: boolean): Ir => {
      const old = this.newTemp();
      const list = [
        this.assign(tempRef(old), this.name(x)),
        this.assign(this.name(x), value),
        this.call('__release', tempRef(old)),
      ];
      if (keepValue) list.push(this.name(x));
      return comma(list);
    };
    switch (operator) {
      case K.EqualsToken: {
        let result = replace(
          this.visitIn(node.right, Ctx.Take)!,
          ctx !== Ctx.Discard,
        );
        if (ctx !== Ctx.Discard) result = paren(result);
        return result;
      }
      case K.BarBarEqualsToken:
      case K.QuestionQuestionEqualsToken: {
        this.conditional++;
        const value = this.visitIn(node.right, Ctx.Take)!;
        this.conditional--;
        return binary(
          this.name(x),
          '||',
          paren(this.assign(this.name(x), value)),
        );
      }
      case K.AmpersandAmpersandEqualsToken: {
        this.conditional++;
        const value = this.visitIn(node.right, Ctx.Take)!;
        this.conditional--;
        return binary(this.name(x), '&&', paren(replace(value, true)));
      }
    }
    return undefined;
  }

  // An assignment to a string field or element, or a channel field, whose
  // value is converted as it is stored and read.
  private lowerConvertedAssignment(
    node: Node,
    left: Node,
    ctx: Ctx,
    kind: 's' | 'c',
  ): Ir | undefined {
    const operator = node.operatorToken.kind;
    const access = this.lowerAccess(left, true, node.right);
    if (!access) return undefined;
    let index = elemIndex(access);
    const temps: Ir[] = [];
    if (operator !== K.EqualsToken) index = this.copiable(index, temps);
    const readHelper = kind === 'c' ? '__box' : '__strAt';
    const read = () => this.call(readHelper, this.i32(index));
    // a string: __storeStr(I, V), which returns V. a channel: __I32[I] =
    // __cellAddress(V), or (__I32[I] = __cellAddress(_v = V), _v) where its
    // value is used
    const store = (value: Ir): Ir => {
      if (kind === 's') return this.call('__storeStr', index, value);
      if (ctx === Ctx.Discard)
        return this.assign(this.i32(index), this.call('__cellAddress', value));
      const v = this.newTemp();
      const converted = this.call(
        '__cellAddress',
        this.assign(tempRef(v), value),
      );
      return paren(
        comma([this.assign(this.i32(index), converted), tempRef(v)]),
      );
    };
    switch (operator) {
      case K.EqualsToken:
        return store(this.visit(node.right));
      case K.PlusEqualsToken:
        if (kind !== 's') return undefined;
        return this.sequence(
          temps,
          store(binary(read(), '+', this.visit(node.right))),
        );
      case K.QuestionQuestionEqualsToken:
      case K.BarBarEqualsToken:
      case K.AmpersandAmpersandEqualsToken: {
        if (operator === K.QuestionQuestionEqualsToken && kind === 's')
          return this.sequence(temps, read()); // a string is never null
        const logical =
          operator === K.AmpersandAmpersandEqualsToken
            ? '&&'
            : operator === K.QuestionQuestionEqualsToken
              ? '??'
              : '||';
        this.conditional++;
        const value = this.visit(node.right);
        this.conditional--;
        return this.sequence(
          temps,
          binary(read(), logical, paren(store(value))),
        );
      }
    }
    return undefined;
  }

  // `new S()` and `new SharedArray(S | Number | Boolean | String | i32 | u8,
  // n)`.
  private lowerNew(node: Node): Ir | undefined {
    const cell = this.r.cellType(node);
    if (cell.kind === CellKind.Struct)
      return this.call('__newStruct', this.visit(node.expression));
    const args = node.arguments as Node[] | undefined;
    if (cell.kind < CellKind.ArrayOfNumber || !args || args.length !== 2)
      return undefined;
    let elementType: Ir = num(8);
    switch (cell.kind) {
      case CellKind.ArrayOfStruct:
        elementType = this.visit(args[0]!);
        break;
      case CellKind.ArrayOfBoolean:
        elementType = num(1);
        break;
      case CellKind.ArrayOfString:
        elementType = num(4);
        break;
      case CellKind.ArrayOfI32:
        elementType = prefix('-', num(4));
        break;
      case CellKind.ArrayOfU8:
        elementType = prefix('-', num(1));
        break;
    }
    // a scalar element type that is more than a name still runs
    // (`(calls++, Number)`)
    if (cell.kind !== CellKind.ArrayOfStruct && !isNameChain(args[0]!))
      elementType = comma([this.visitIn(args[0]!, Ctx.Discard)!, elementType]);
    return this.call('__newSharedArray', elementType, this.visit(args[1]!));
  }

  private fieldKind(cell: CellType, name: string): string {
    return cell.kinds[cell.fields.indexOf(name)] ?? '';
  }

  // The kind of an access whose value is converted as it is stored: a string
  // field or a SharedArray<string> element ('s'), or a channel field ('c').
  private convertedTarget(access: Node): '' | 's' | 'c' {
    if (access.kind === K.PropertyAccessExpression) {
      const cell = this.r.cellType(access.expression);
      if (cell.kind !== CellKind.Struct) return '';
      const kind = this.fieldKind(cell, access.name.text);
      if (kind === 's' || kind === 'c') return kind;
    } else if (access.kind === K.ElementAccessExpression) {
      if (this.r.cellType(access.expression).kind === CellKind.ArrayOfString)
        return 's';
    }
    return '';
  }

  // A boolean field of a shared struct or an element of a
  // SharedArray<boolean>.
  private isBooleanTarget(access: Node): boolean {
    if (access.kind === K.PropertyAccessExpression) {
      const cell = this.r.cellType(access.expression);
      return (
        cell.kind === CellKind.Struct &&
        this.fieldKind(cell, access.name.text) === 'b'
      );
    }
    if (access.kind === K.ElementAccessExpression)
      return (
        this.r.cellType(access.expression).kind === CellKind.ArrayOfBoolean
      );
    return false;
  }

  // Lowers `e.f`, `a.length` and `a[i]` on structs and SharedArrays;
  // undefined if the access is not one. For a write, value is the assigned
  // expression: when it contains a call, an unstable object is retained first,
  // and so it is when the index of an element contains one.
  private lowerAccess(
    node: Node,
    isWrite: boolean,
    value: Node | undefined,
  ): Ir | undefined {
    node = skipParentheses(node);
    if (
      node.kind !== K.PropertyAccessExpression &&
      node.kind !== K.ElementAccessExpression
    )
      return undefined;
    if (isOptionalChain(node)) return undefined;
    const cell = this.r.cellType(node.expression);
    if (cell.kind === CellKind.None) return undefined;
    // a boolean read compares the byte with 0; a write, or an assignment
    // target, is the byte itself
    const isRead = !isWrite && !isAssignmentTarget(node);
    let objectContext: Ctx = Ctx.AtOnce;
    if (
      (isWrite && this.containsCall(value)) ||
      (node.kind === K.ElementAccessExpression &&
        this.containsCall(node.argumentExpression))
    )
      objectContext = Ctx.Argument;
    if (node.kind === K.PropertyAccessExpression) {
      const name = node.name.text as string;
      if (cell.kind === CellKind.Struct) {
        const k = cell.fields.indexOf(name);
        if (k < 0) return undefined;
        let object = this.visitIn(node.expression, objectContext)!;
        if (isGen(object) && object.tag?.t === 'binary') object = paren(object);
        const word = () =>
          binary(paren(binary(object, '>>', num(2))), '+', num(2 + 2 * k));
        switch (cell.kinds[k]) {
          case 'r':
          case 'i':
            return this.i32(word());
          case 's':
            return isRead
              ? this.call('__strAt', this.i32(word()))
              : this.i32(word());
          case 'c':
            return isRead
              ? this.call('__box', this.i32(word()))
              : this.i32(word());
          case 'b': {
            const b = this.u8(binary(object, '+', num(8 + 8 * k)));
            return isRead ? isTrue(b) : b;
          }
          case 'u':
            return this.u8(binary(object, '+', num(8 + 8 * k)));
        }
        return this.f64(
          binary(paren(binary(object, '>>', num(3))), '+', num(1 + k)),
        );
      }
      if (cell.kind >= CellKind.ArrayOfNumber) {
        if (name !== 'length' || isWrite) return undefined;
        return this.length(this.visitIn(node.expression, objectContext)!);
      }
      return undefined;
    }
    if (cell.kind === CellKind.ArrayOfStruct) {
      if (isWrite) return undefined; // reported by the checker
      const size = 8 + 8 * cell.fields.length;
      if (this.r.isElementAccessInBounds(node)) {
        // proven in bounds (A and I are identifiers): no check, no temporaries
        const a = this.visitIn(node.expression, objectContext)!;
        const i = this.visit(node.argumentExpression);
        return binary(binary(a, '+', num(16)), '+', binary(i, '*', num(size)));
      }
      const temps: Ir[] = [];
      const a = this.copiable(
        this.receiver(node.expression, objectContext, [
          node.argumentExpression,
        ]),
        temps,
      );
      const i = this.copiable(this.visit(node.argumentExpression), temps);
      const address = cond(
        this.inBounds(a, i),
        binary(binary(a, '+', num(16)), '+', binary(i, '*', num(size))),
        this.oob(i),
      );
      return this.sequence(temps, address);
    }
    const access = this.elementAccess(cell.kind);
    if (!access) return undefined;
    const {view, at} = access;
    const read = isRead ? access.read : (e: Ir) => e;
    if (this.r.isElementAccessInBounds(node)) {
      const a = this.visitIn(node.expression, objectContext)!;
      const i = this.visit(node.argumentExpression);
      return read(view(at(a, i)));
    }
    const temps: Ir[] = [];
    const a = this.copiable(
      this.receiver(node.expression, objectContext, [node.argumentExpression]),
      temps,
    );
    const i = this.copiable(this.visit(node.argumentExpression), temps);
    if (!isRead) {
      const index = paren(cond(this.inBounds(a, i), i, this.oob(i)));
      return view(this.sequence(temps, at(a, index)));
    }
    return this.sequence(
      temps,
      cond(this.inBounds(a, i), read(view(at(a, i))), this.oob(i)),
    );
  }

  // How an element of a SharedArray of numbers, i32s, u8s, booleans or
  // strings is accessed.
  private elementAccess(kind: CellKind):
    | {
        view: (e: Ir) => Ir;
        at: (a: Ir, i: Ir) => Ir;
        read: (e: Ir) => Ir;
      }
    | undefined {
    const same = (e: Ir) => e;
    const words = (shift: number) => (a: Ir, i: Ir) =>
      binary(
        paren(binary(paren(binary(a, '+', num(16))), '>>', num(shift))),
        '+',
        i,
      );
    const bytes = (a: Ir, i: Ir) => binary(binary(a, '+', num(16)), '+', i);
    switch (kind) {
      case CellKind.ArrayOfNumber:
        return {view: e => this.f64(e), at: words(3), read: same};
      case CellKind.ArrayOfI32:
        return {view: e => this.i32(e), at: words(2), read: same};
      case CellKind.ArrayOfString:
        return {
          view: e => this.i32(e),
          at: words(2),
          read: e => this.call('__strAt', e),
        };
      case CellKind.ArrayOfU8:
        return {view: e => this.u8(e), at: bytes, read: same};
      case CellKind.ArrayOfBoolean:
        return {view: e => this.u8(e), at: bytes, read: isTrue};
    }
    return undefined;
  }

  // Reports whether evaluating an expression may call a function (and so
  // reach a quiescent point). Allocating a struct or a SharedArray does not.
  private containsCall(node: Node | undefined): boolean {
    if (!node) return false;
    let found = false;
    const visit = (n: Node): boolean => {
      switch (n.kind) {
        case K.CallExpression:
        case K.TaggedTemplateExpression:
        case K.AwaitExpression:
        case K.YieldExpression:
          found = true;
          break;
        case K.NewExpression:
          found = this.r.cellType(n).kind === CellKind.None;
          break;
        case K.ArrowFunction:
        case K.FunctionExpression:
        case K.ClassExpression:
          return false;
      }
      return found || forEachChild(n, visit);
    };
    visit(node);
    return found;
  }

  // The array an element access (or an atomic operation) reads, visited. A
  // variable that what comes after it assigns (`a[(a = b, 0)]`) is read
  // before, into a temporary that holds a count until the full expression
  // ends, as JavaScript reads the array first (the fork reads it again,
  // after the index).
  private receiver(object: Node, ctx: Ctx, after: Node[]): Ir {
    const ir = this.visitIn(object, ctx)!;
    const id = skipParentheses(object);
    if (
      id.kind !== K.Identifier ||
      !isSimpleCopiable(ir) ||
      !after.some(n => this.r.assignsIn(n, id))
    )
      return ir;
    // no full expression around to release it after: a plain copy
    if (!this.frames[this.frames.length - 1]) {
      const temp = this.newTemp();
      return paren(this.assign(tempRef(temp), ir));
    }
    return this.temporary(this.call('__retain', ir));
  }

  // An expression that can be repeated: the expression itself if it is
  // simple, otherwise a temporary that is assigned first.
  private copiable(expr: Ir, temps: Ir[]): Ir {
    if (isSimpleCopiable(expr)) return expr;
    const assignment = this.unparen(expr);
    if (
      assignment !== expr &&
      isGen(assignment) &&
      assignment.tag?.t === 'binary' &&
      isGen(assignment.tag.left) &&
      assignment.tag.left.tag?.t === 'temp'
    ) {
      // already assigned to a temporary (one that holds a count): reuse it
      temps.push(assignment);
      return assignment.tag.left;
    }
    const temp = this.newTemp();
    temps.push(this.assign(tempRef(temp), expr));
    return tempRef(temp);
  }

  // An identifier's edit to its new name: `{x: x_1}` for a shorthand
  // binding element, which also names the property.
  private renameEdit(id: Node, renamed: string): Edit {
    const parent = id.parent as Node;
    const shorthand =
      parent.kind === K.BindingElement &&
      parent.name === id &&
      !parent.propertyName &&
      !parent.dotDotDotToken &&
      (parent.parent as Node).kind === K.ObjectBindingPattern;
    return {
      start: this.startOf(id),
      end: id.end,
      ir: shorthand
        ? gen(Prec.Primary, [`${id.text}: ${renamed}`])
        : gen(Prec.Primary, [renamed], {t: 'simple'}),
    };
  }

  // A new reference to a variable, by name.
  private name(name: Node): Ir {
    const text =
      (this.renamed.size > 0 && this.renamedName(name)) ||
      (name.text as string);
    return gen(Prec.Primary, [text], {t: 'simple'});
  }

  // The new name of a variable that an identifier declares or refers to, if
  // it was renamed.
  private renamedName(id: Node): string | undefined {
    const host = this.r.c.host;
    const parent = id.parent as Node | undefined;
    const symbol =
      parent &&
      isDeclarationName(id) &&
      parent.kind !== K.ShorthandPropertyAssignment
        ? host.symbolOfDeclaration(parent)
        : host.resolvedSymbol(id);
    return symbol ? this.renamed.get(host.symbolId(symbol)) : undefined;
  }

  // Reports whether a function body's statements declare (with let, const,
  // class or function) a name that its moved defaults read.
  private bodyShadows(fn: Node, list: Node[]): boolean {
    const declared = lexicalNames(list);
    for (const s of list)
      if (s.kind === K.FunctionDeclaration && s.name) declared.add(s.name.text);
    if (declared.size === 0) return false;
    return (fn.parameters as Node[]).some(
      param =>
        (this.paramInits.has(param) ||
          this.movedDefaults.has(param) ||
          this.movedPatterns.has(param)) &&
        ((param.initializer && readsAny(param.initializer, declared)) ||
          (param.name.kind !== K.Identifier && readsAny(param.name, declared))),
    );
  }

  // Renames the `var`s of a function's body (outside the functions in it)
  // that its moved defaults would see instead of what they read: the
  // defaults now run in the body, whose other declarations are in a block of
  // their own.
  private renameShadowingVars(fn: Node, body: Node): void {
    const host = this.r.c.host;
    const reads = new Map<string, unknown>();
    const collect = (node: Node | undefined): void => {
      if (!node) return;
      if (node.kind === K.Identifier) {
        if (isOwnReferencePosition(node))
          reads.set(node.text, host.resolvedSymbol(node));
        return;
      }
      forEachChild(node, child => {
        collect(child);
      });
    };
    for (const param of fn.parameters as Node[]) {
      if (
        this.paramInits.has(param) ||
        this.movedDefaults.has(param) ||
        this.movedPatterns.has(param)
      ) {
        collect(param.initializer);
        if (param.name.kind !== K.Identifier) collect(param.name);
      }
    }
    if (reads.size === 0) return;
    const visit = (node: Node): void => {
      if (isTypeNode(node) || isFunctionLike(node) || isClassLike(node)) return;
      if (
        node.kind === K.VariableDeclarationList &&
        !(node.flags & (NodeFlags.Let | NodeFlags.Const))
      ) {
        const names = (name: Node): void => {
          if (name.kind === K.Identifier) {
            if (!reads.has(name.text)) return;
            const symbol = host.symbolOfDeclaration(name.parent as Node);
            if (!symbol || symbol === reads.get(name.text)) return;
            const id = host.symbolId(symbol);
            if (this.renamed.has(id)) return;
            let n = name.text as string;
            for (let i = 1; this.fileIdentifiers.has(n); i++)
              n = `${name.text}_${i}`;
            this.fileIdentifiers.add(n);
            this.renamed.set(id, n);
            return;
          }
          forEachChild(name, child => {
            if (child.kind === K.BindingElement) names(child.name);
          });
        };
        for (const decl of node.declarations as Node[]) names(decl.name);
      }
      forEachChild(node, child => {
        visit(child);
      });
    };
    forEachChild(body, child => {
      visit(child);
    });
  }

  private sequence(temps: Ir[], expr: Ir): Ir {
    if (temps.length === 0) return expr;
    return comma([...temps, expr]);
  }

  // (I >>> 0) === I && I < __I32[(A + 4) >> 2]
  private inBounds(a: Ir, i: Ir): Ir {
    const isIndex = binary(paren(binary(i, '>>>', num(0))), '===', i);
    return binary(isIndex, '&&', binary(i, '<', this.length(a)));
  }

  // __I32[(A + 4) >> 2]
  private length(a: Ir): Ir {
    return this.i32(binary(paren(binary(a, '+', num(4))), '>>', num(2)));
  }

  // __outOfBounds[I]: throws a RangeError naming the index, without a call
  private oob(i: Ir): Ir {
    return elem(helperRef('__outOfBounds'), i);
  }

  private f64(index: Ir): Ir {
    return elem(helperRef('__F64'), index);
  }

  private u8(index: Ir): Ir {
    return elem(helperRef('__U8'), index);
  }

  private i32(index: Ir): Ir {
    return elem(helperRef('__I32'), index);
  }

  private call(helper: string, ...args: Ir[]): Ir {
    return call(
      helperRef(helper),
      args.map(a => this.unparen(a)),
    );
  }

  private assign(left: Ir, right: Ir): Ir {
    return binary(left, '=', right);
  }
}

// ---- helpers

// The precedence an expression's place needs, where the place says (an
// argument, an initializer, a statement's expression), or undefined: then
// what replaces it needs that of the expression itself.
function positionPrec(node: Node): number | undefined {
  const parent = node.parent as Node | undefined;
  if (!parent) return undefined;
  switch (parent.kind) {
    case K.CallExpression:
    case K.NewExpression:
      return parent.expression === node ? undefined : Prec.Assignment;
    case K.ArrayLiteralExpression:
    case K.SpreadElement:
    case K.SpreadAssignment:
    case K.ExportAssignment:
      return Prec.Assignment;
    case K.PropertyAssignment:
    case K.VariableDeclaration:
    case K.Parameter:
    case K.BindingElement:
    case K.PropertyDeclaration:
      return parent.initializer === node ? Prec.Assignment : undefined;
    case K.ConditionalExpression:
      return parent.condition === node ? undefined : Prec.Assignment;
    case K.ArrowFunction:
      return parent.body === node ? Prec.Assignment : undefined;
    case K.ForOfStatement:
      return parent.expression === node ? Prec.Assignment : undefined;
    case K.ReturnStatement:
    case K.ThrowStatement:
    case K.ExpressionStatement:
    case K.IfStatement:
    case K.WhileStatement:
    case K.DoStatement:
    case K.SwitchStatement:
    case K.CaseClause:
    case K.WithStatement:
    case K.ForStatement:
    case K.ForInStatement:
    case K.ParenthesizedExpression:
    case K.TemplateSpan:
      return Prec.Comma;
    case K.ElementAccessExpression:
      return parent.argumentExpression === node ? Prec.Comma : undefined;
    case K.BinaryExpression:
      if (
        parent.right === node &&
        isAssignmentOperator(parent.operatorToken.kind)
      )
        return Prec.Assignment;
  }
  return undefined;
}

function isIdentity(ir: Ir | undefined, node: Node | undefined): boolean {
  return !!ir && ir.k === 'src' && ir.node === node && ir.edits.length === 0;
}

function isIdentifierIr(ir: Ir): boolean {
  return (
    (ir.k === 'src' &&
      ir.node.kind === K.Identifier &&
      ir.edits.length === 0) ||
    (isGen(ir) &&
      ir.tag?.t === 'simple' &&
      typeof ir.parts[0] === 'string' &&
      /^[A-Za-z_$][\w$]*$/.test(ir.parts[0]))
  );
}

// IsSimpleCopiableExpression: a literal, a keyword, an identifier (or a
// temporary).
function isSimpleCopiable(ir: Ir): boolean {
  if (isGen(ir)) return ir.tag?.t === 'temp' || ir.tag?.t === 'simple';
  if (ir.edits.length > 0) return false;
  switch (ir.node.kind) {
    case K.Identifier:
    case K.StringLiteral:
    case K.NoSubstitutionTemplateLiteral:
    case K.NumericLiteral:
    case K.ThisKeyword:
    case K.TrueKeyword:
    case K.FalseKeyword:
    case K.NullKeyword:
    case K.SuperKeyword:
      return true;
  }
  return false;
}

// The index of a lowered element access (`__I32[I]`).
function elemIndex(access: Ir): Ir {
  if (isGen(access) && access.tag?.t === 'elem') return access.tag.index;
  throw new Error('threads-check: an access lowered to no element access');
}

// B !== 0
function isTrue(b: Ir): Ir {
  return binary(b, '!==', num(0));
}

function arrayLiteral(elements: Ir[]): Ir {
  const parts: Part[] = ['['];
  elements.forEach((e, i) => {
    if (i > 0) parts.push(', ');
    parts.push(e);
  });
  parts.push(']');
  return gen(Prec.Primary, parts);
}

// The fields' kinds as a string of their letters, if any is other than a
// number or a reference, and "" otherwise.
function kindLetters(layout: CellType): string {
  return layout.kinds.some(k => k !== 'f' && k !== 'r')
    ? layout.kinds.join('')
    : '';
}

function returnStatement(e: Ir): Ir {
  return gen(Prec.Primary, ['\nreturn ', e, ';']);
}

function varsStatement(scope: Scope): Ir {
  // written only if the scope declared any (known once it is visited)
  return gen(Prec.Primary, [{k: 'vars', scope}]);
}

// Statements in a statement's place make a block.
function embedded(ir: Ir | undefined): Ir | undefined {
  if (ir && isGen(ir) && ir.tag?.t === 'stmts') return block(ir.tag.list);
  return ir;
}

// Function declarations move ahead of a `try` (they are hoisted, and code
// before the try may call them), but for those that read a lexical binding
// declared in the try (`const n` there, or a class), which stay with it, as
// do those that read them (the fork moves them all, away from what they
// read).
function splitFunctionDeclarations(
  list: Ir[],
  declared: Set<string>,
): [Ir[], Ir[]] {
  const names = new Set(declared);
  const fns = list.filter(
    ir => ir.k === 'src' && ir.node.kind === K.FunctionDeclaration,
  ) as Src[];
  const stays = new Set<Ir>();
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fns) {
      if (stays.has(f) || !readsAny(f.node, names)) continue;
      stays.add(f);
      if (f.node.name) names.add(f.node.name.text);
      changed = true;
    }
  }
  const functions: Ir[] = [],
    rest: Ir[] = [];
  for (const ir of list) {
    if (
      ir.k === 'src' &&
      ir.node.kind === K.FunctionDeclaration &&
      !stays.has(ir)
    )
      functions.push(ir);
    else rest.push(ir);
  }
  return [functions, rest];
}

// The names that statements declare lexically: `let`, `const`, classes and
// enums (and function declarations, which the try would hold in its block).
function lexicalNames(statements: Node[]): Set<string> {
  const names = new Set<string>();
  const bind = (name: Node): void => {
    if (name.kind === K.Identifier) names.add(name.text);
    else
      forEachChild(name, child => {
        if (child.kind === K.BindingElement) bind(child.name);
      });
  };
  for (const s of statements) {
    if (
      s.kind === K.VariableStatement &&
      s.declarationList.flags & (NodeFlags.Let | NodeFlags.Const)
    )
      for (const d of s.declarationList.declarations as Node[]) bind(d.name);
    else if (
      (s.kind === K.ClassDeclaration || s.kind === K.EnumDeclaration) &&
      s.name
    )
      names.add(s.name.text);
  }
  return names;
}

// Reports whether a function reads (or names) any of names.
function readsAny(fn: Node, names: Set<string>): boolean {
  if (names.size === 0) return false;
  const visit = (node: Node): boolean => {
    if (node.kind === K.Identifier)
      return names.has(node.text) && isOwnReferencePosition(node);
    return forEachChild(node, visit);
  };
  return forEachChild(fn, visit);
}

// Reports whether an expression is a name or a property of one (`Number`,
// `threads.i32`), which reads nothing a lowering must keep.
function isNameChain(node: Node): boolean {
  if (node.kind === K.Identifier) return true;
  return (
    node.kind === K.PropertyAccessExpression && isNameChain(node.expression)
  );
}

// Reports whether a default is a literal (`0`, `-1`, `'x'`, `null`), which
// reads nothing and does nothing, so it may run before the defaults that
// move into the body, and stay in the parameter list.
function isConstant(node: Node): boolean {
  switch (node.kind) {
    case K.NumericLiteral:
    case K.BigIntLiteral:
    case K.StringLiteral:
    case K.NoSubstitutionTemplateLiteral:
    case K.TrueKeyword:
    case K.FalseKeyword:
    case K.NullKeyword:
      return true;
    case K.PrefixUnaryExpression:
      return (
        (node.operator === K.MinusToken || node.operator === K.PlusToken) &&
        (node.operand.kind === K.NumericLiteral ||
          node.operand.kind === K.BigIntLiteral)
      );
    case K.ParenthesizedExpression:
      return isConstant(node.expression);
  }
  return false;
}

function isLogicalAssignment(operator: number): boolean {
  return (
    operator === K.BarBarEqualsToken ||
    operator === K.AmpersandAmpersandEqualsToken ||
    operator === K.QuestionQuestionEqualsToken
  );
}

// The loop a `continue` statement continues.
function continueTarget(node: Node): Node | undefined {
  const label = node.label as Node | undefined;
  for (
    let parent = node.parent as Node | undefined;
    parent && !isFunctionLike(parent) && parent.kind !== K.SourceFile;
    parent = parent.parent as Node | undefined
  ) {
    if (label) {
      if (
        parent.kind === K.LabeledStatement &&
        parent.label.text === label.text
      ) {
        let statement = parent.statement as Node;
        while (statement.kind === K.LabeledStatement)
          statement = statement.statement;
        return statement;
      }
    } else if (isIterationStatement(parent)) return parent;
  }
  return undefined;
}

function isIterationStatement(node: Node): boolean {
  switch (node.kind) {
    case K.ForStatement:
    case K.ForInStatement:
    case K.ForOfStatement:
    case K.DoStatement:
    case K.WhileStatement:
      return true;
  }
  return false;
}

// The function whose concise body an expression is.
function conciseBodyOf(node: Node): Node | undefined {
  const parent = node.parent as Node | undefined;
  if (!parent || parent.kind !== K.ArrowFunction || parent.body !== node)
    return undefined;
  return parent;
}

// The contexts of the operands of a conditional or logical expression: an
// owned result takes each operand (+1) and is counted as a whole; a borrowed
// one is counted as a whole.
function operandContext(count: Count, ctx: Ctx): [Ctx, boolean] {
  switch (ctx) {
    case Ctx.Return:
      return [Ctx.Return, false];
    case Ctx.Take:
      if (count === Count.Owned) return [Ctx.Take, false];
      return [Ctx.AtOnce, true];
  }
  if (count === Count.Owned) return [Ctx.Take, true];
  return [Ctx.AtOnce, true];
}

function isLiteralExpression(node: Node): boolean {
  switch (node.kind) {
    case K.NumericLiteral:
    case K.BigIntLiteral:
    case K.StringLiteral:
    case K.RegularExpressionLiteral:
    case K.NoSubstitutionTemplateLiteral:
      return true;
  }
  return false;
}

function isPrologueDirective(node: Node): boolean {
  return (
    node.kind === K.ExpressionStatement &&
    node.expression.kind === K.StringLiteral
  );
}

// Statements (and the like) take their leading trivia with them, so that
// what is inserted between them goes between their comments too.
function isStatementLike(node: Node): boolean {
  switch (node.kind) {
    case K.Block:
    case K.VariableStatement:
    case K.EmptyStatement:
    case K.ExpressionStatement:
    case K.IfStatement:
    case K.DoStatement:
    case K.WhileStatement:
    case K.ForStatement:
    case K.ForInStatement:
    case K.ForOfStatement:
    case K.ContinueStatement:
    case K.BreakStatement:
    case K.ReturnStatement:
    case K.WithStatement:
    case K.SwitchStatement:
    case K.LabeledStatement:
    case K.ThrowStatement:
    case K.TryStatement:
    case K.DebuggerStatement:
    case K.FunctionDeclaration:
    case K.ClassDeclaration:
    case K.InterfaceDeclaration:
    case K.TypeAliasDeclaration:
    case K.EnumDeclaration:
    case K.ModuleDeclaration:
    case K.ImportDeclaration:
    case K.ImportEqualsDeclaration:
    case K.ExportDeclaration:
    case K.ExportAssignment:
    case K.CaseClause:
    case K.DefaultClause:
      return true;
  }
  return false;
}

// What the type eraser takes away: types, and declarations of types only
// (interfaces, type aliases, ambient declarations, overloads), which the
// lowering leaves to the type stripper.
function isErased(node: Node): boolean {
  // a class's `extends E` runs E
  if (isClassExtends(node)) return false;
  if (isTypeNode(node)) return true;
  switch (node.kind) {
    case K.InterfaceDeclaration:
    case K.TypeAliasDeclaration:
    case K.TypeParameter:
    case K.ImportDeclaration:
    case K.ImportEqualsDeclaration:
    case K.ExportDeclaration:
      return true;
    case K.HeritageClause:
      return node.token === K.ImplementsKeyword;
    case K.FunctionDeclaration:
    case K.MethodDeclaration:
    case K.Constructor:
    case K.GetAccessor:
    case K.SetAccessor:
      if (!node.body) return true;
      break;
    case K.PropertyDeclaration:
      if (
        node.modifiers?.some(
          (m: Node) =>
            m.kind === K.DeclareKeyword || m.kind === K.AbstractKeyword,
        )
      )
        return true;
      break;
  }
  if (node.flags & NodeFlags.Ambient) return true;
  if (node.modifiers?.some((m: Node) => m.kind === K.DeclareKeyword))
    return true;
  return false;
}
