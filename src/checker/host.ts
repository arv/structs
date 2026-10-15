// The checker's view of a program: TypeScript 7.1's synchronous JavaScript API,
// with the answers it gives cached by node, symbol and type, and fetched a file
// at a time in batches (one round trip for the types of all of a file's
// expressions, one for its call signatures, and so on).

import type {SourceFile} from 'typescript/ast';
import type {RequestFileSystem} from 'typescript/proto';
import {
  API,
  ElementFlags,
  IndexKind,
  ModuleKind,
  ObjectFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
} from 'typescript/sync';
import type {
  Checker,
  NodeHandle,
  Program,
  Signature,
  Snapshot,
  Symbol as TsSymbol,
  Type,
} from 'typescript/sync';
import {
  forEachChild,
  isDeclarationName,
  isExpression,
  isExpressionNode,
  isOwnValueReference,
  isTypeNode,
  K,
} from './syntax.ts';
import type {Node} from './syntax.ts';

export {
  ElementFlags,
  IndexKind,
  ModuleKind,
  ObjectFlags,
  SymbolFlags,
  TypeFlags,
};
export type {NodeHandle, Signature, TsSymbol, Type};

export class Host {
  readonly api: API;
  readonly snapshot: Snapshot;
  readonly program: Program;
  readonly checker: Checker;
  private readonly types = new Map<Node, Type>();
  private readonly symbolsAt = new Map<Node, TsSymbol | undefined>();
  private readonly resolved = new Map<Node, TsSymbol | undefined>();
  private readonly signatures = new Map<Node, Signature>();
  private readonly declarationSymbols = new Map<Node, TsSymbol | undefined>();
  private readonly symbolTypes = new Map<TsSymbol, Type>();
  private readonly declaredTypes = new Map<TsSymbol, Type>();
  private readonly aliases = new Map<TsSymbol, TsSymbol | undefined>();
  private readonly typeArgs = new Map<Type, readonly Type[]>();
  private readonly awaited = new Map<Type, Type>();
  private readonly calls = new Map<Type, readonly Signature[]>();
  private readonly constructs = new Map<Type, readonly Signature[]>();
  private readonly required = new Map<Signature, number>();
  private readonly wellKnown = new Map<string, string | undefined>();
  private readonly typeStrings = new Map<Type, string>();
  private readonly libraryPaths = new Map<string, boolean>();
  private readonly symbolIds = new Map<TsSymbol, number>();
  private readonly contextualSignatures = new Map<
    Node,
    Signature | undefined
  >();
  private readonly unknownSymbolChecked = new Map<TsSymbol, boolean>();

  constructor(
    api: API,
    snapshot: Snapshot,
    program: Program,
    checker: Checker,
  ) {
    this.api = api;
    this.snapshot = snapshot;
    this.program = program;
    this.checker = checker;
  }

  // Fetches what the analysis of a file asks for, in a few batches: the types
  // of its expressions, the symbols of its references and declarations, the
  // signatures of its calls and the types of those symbols. (Names of
  // properties and types are left to single requests: the analysis asks about
  // few of them, and their symbols, with all their declarations, are costly to
  // send.)
  prefetch(file: SourceFile): void {
    const expressions: Node[] = [];
    const references: Node[] = [];
    const calls: Node[] = [];
    const declarations: Node[] = [];
    const visit = (node: Node): void => {
      if (isTypeNode(node)) return;
      switch (node.kind) {
        case K.Identifier:
          if (isOwnValueReference(node)) references.push(node);
          break;
        case K.CallExpression:
        case K.NewExpression:
          calls.push(node);
          break;
        case K.VariableDeclaration:
        case K.Parameter:
        case K.BindingElement:
        case K.PropertyDeclaration:
        case K.PropertySignature:
          declarations.push(node);
          break;
      }
      if (isExpression(node) && isExpressionNode(node) && isTypeQueried(node))
        expressions.push(node);
      forEachChild(node, child => visit(child));
    };
    forEachChild(file as Node, child => visit(child));

    const types = expressions.length
      ? this.checker.getTypeAtLocation(expressions)
      : [];
    expressions.forEach((node, i) => this.types.set(node, types[i]!));
    const resolved = this.api.batch(
      ...references.map(id => this.checker.getResolvedSymbol.gen(id as any)),
    );
    references.forEach((id, i) =>
      this.resolved.set(id, this.known(resolved[i])),
    );
    const signatures = this.api.batch(
      ...calls.map(call => this.checker.getResolvedSignature.gen(call)),
    );
    calls.forEach((call, i) => this.signatures.set(call, signatures[i]!));
    const declared = this.api.batch(
      ...declarations.map(d => this.checker.getSymbolOfNode.gen(d)),
    );
    declarations.forEach((d, i) => this.declarationSymbols.set(d, declared[i]));

    const unique = new Set<TsSymbol>();
    for (const s of [...resolved, ...declared]) {
      if (s && !this.symbolTypes.has(s)) unique.add(s);
    }
    const list = [...unique];
    const symbolTypes = list.length ? this.checker.getTypeOfSymbol(list) : [];
    list.forEach((s, i) => this.symbolTypes.set(s, symbolTypes[i]!));
  }

  private known(symbol: TsSymbol | undefined): TsSymbol | undefined {
    if (!symbol) return undefined;
    let unknown = this.unknownSymbolChecked.get(symbol);
    if (unknown === undefined) {
      unknown = this.checker.isUnknownSymbol(symbol);
      this.unknownSymbolChecked.set(symbol, unknown);
    }
    return unknown ? undefined : symbol;
  }

  // checker.getTypeOfExpression (as the API gives it: the regular type of the
  // expression).
  typeOf(node: Node): Type {
    let t = this.types.get(node);
    if (!t) {
      t = this.checker.getTypeAtLocation(node);
      this.types.set(node, t);
    }
    return t;
  }

  // checker.getSymbolAtLocation, for names (of properties and types).
  symbolAt(node: Node): TsSymbol | undefined {
    if (this.symbolsAt.has(node)) return this.symbolsAt.get(node);
    const symbol = this.known(this.checker.getSymbolAtLocation(node));
    this.symbolsAt.set(node, symbol);
    return symbol;
  }

  // checker.getResolvedSymbol: what an identifier in an expression refers to
  // (an exported variable's local symbol, as in the fork), or undefined.
  resolvedSymbol(id: Node): TsSymbol | undefined {
    if (this.resolved.has(id)) return this.resolved.get(id);
    const symbol = this.known(this.checker.getResolvedSymbol(id as any));
    this.resolved.set(id, symbol);
    return symbol;
  }

  signatureOf(call: Node): Signature {
    let s = this.signatures.get(call);
    if (!s) {
      s = this.checker.getResolvedSignature(call);
      this.signatures.set(call, s);
    }
    return s;
  }

  symbolOfDeclaration(decl: Node): TsSymbol | undefined {
    if (this.declarationSymbols.has(decl))
      return this.declarationSymbols.get(decl);
    const symbol = this.checker.getSymbolOfNode(decl);
    this.declarationSymbols.set(decl, symbol);
    return symbol;
  }

  typeOfSymbol(symbol: TsSymbol): Type {
    let t = this.symbolTypes.get(symbol);
    if (!t) {
      t = this.checker.getTypeOfSymbol(symbol);
      this.symbolTypes.set(symbol, t);
    }
    return t;
  }

  declaredTypeOfSymbol(symbol: TsSymbol): Type {
    let t = this.declaredTypes.get(symbol);
    if (!t) {
      t = this.checker.getDeclaredTypeOfSymbol(symbol);
      this.declaredTypes.set(symbol, t);
    }
    return t;
  }

  // checker.resolveAlias, or undefined for the unknown symbol.
  resolveAlias(symbol: TsSymbol): TsSymbol | undefined {
    if (this.aliases.has(symbol)) return this.aliases.get(symbol);
    const target = this.known(this.checker.getAliasedSymbol(symbol));
    this.aliases.set(symbol, target);
    return target;
  }

  // getExportSymbolOfValueSymbolIfExported
  exportSymbolIfExported(symbol: TsSymbol): TsSymbol {
    if (symbol.flags & SymbolFlags.ExportValue) {
      return symbol.getExportSymbol() ?? symbol;
    }
    return symbol;
  }

  // A stable number for a symbol (the API's ids are per file).
  symbolId(symbol: TsSymbol): number {
    let id = this.symbolIds.get(symbol);
    if (id === undefined) {
      id = this.symbolIds.size + 1;
      this.symbolIds.set(symbol, id);
    }
    return id;
  }

  declarationOf(handle: NodeHandle | undefined): Node | undefined {
    return handle ? (handle.resolve() as Node | undefined) : undefined;
  }

  valueDeclaration(symbol: TsSymbol): Node | undefined {
    return this.declarationOf(symbol.valueDeclaration);
  }

  isDefaultLibraryPath(path: string): boolean {
    let result = this.libraryPaths.get(path);
    if (result === undefined) {
      result = !!this.program.getSourceFileMetadataByPath(path as any)
        ?.isDefaultLibrary;
      this.libraryPaths.set(path, result);
    }
    return result;
  }

  // The call signatures of t (a function type's), or its construct
  // signatures (a class's, a struct type's).
  callSignatures(t: Type, construct = false): readonly Signature[] {
    const cache = construct ? this.constructs : this.calls;
    let signatures = cache.get(t);
    if (!signatures) {
      signatures = this.checker.getSignaturesOfType(
        t as any,
        construct ? SignatureKind.Construct : SignatureKind.Call,
      ) as readonly Signature[];
      cache.set(t, signatures);
    }
    return signatures;
  }

  // How many arguments a call with signature s must pass: its parameters
  // before the first optional one, one with a default, or a rest.
  requiredArguments(s: Signature): number {
    let n = this.required.get(s);
    if (n === undefined) {
      n = 0;
      for (const p of s.getParameters()) {
        const decl = this.declarationOf(p.valueDeclaration);
        if (
          decl &&
          (decl.questionToken || decl.initializer || decl.dotDotDotToken)
        )
          break;
        n++;
      }
      this.required.set(s, n);
    }
    return n;
  }

  // The type an `await` of a value of type t gives: t itself unless it is a
  // promise.
  awaitedType(t: Type): Type {
    let awaited = this.awaited.get(t);
    if (!awaited) {
      awaited = this.checker.getAwaitedType(t as any) ?? t;
      this.awaited.set(t, awaited);
    }
    return awaited;
  }

  // The types an iteration of t may give (for...of, a spread, yield*): the
  // `value` of what next() returns, on the iterator t's [Symbol.iterator]()
  // returns (or, async, its [Symbol.asyncIterator]()'s, else its iterator's,
  // awaited), but for a result that is done (a generator's return value),
  // which an iteration does not give. Not the iterator's type arguments: an
  // iterator need not name what it yields first. Empty for a type that is not
  // iterable.
  iteratedTypes(t: Type, async = false): readonly Type[] {
    // a union's members each as it is: they need have no iterator method in
    // common (an AsyncIterable or an Iterable)
    if (t.flags & TypeFlags.Union)
      return this.memberTypes(t).flatMap(m => this.iteratedTypes(m, async));
    const properties = this.checker.getPropertiesOfType(
      this.checker.getApparentType(t as any) as any,
    );
    // the return types of the method of that name
    const returns = (of: Type, name: string): Type[] => {
      const result: Type[] = [];
      const p = this.checker
        .getPropertiesOfType(this.checker.getApparentType(of as any) as any)
        .find(p => p.name === name);
      if (!p) return result;
      for (const signature of this.checker.getSignaturesOfType(
        this.typeOfSymbol(p) as any,
        SignatureKind.Call,
      ))
        result.push(this.checker.getReturnTypeOfSignature(signature) as Type);
      return result;
    };
    const sync = this.wellKnownName('Iterable', '__@iterator@');
    for (const name of async
      ? [this.wellKnownName('AsyncIterable', '__@asyncIterator@'), sync]
      : [sync]) {
      if (name === undefined || !properties.some(p => p.name === name))
        continue;
      const awaited = async && name === sync;
      const result: Type[] = [];
      for (const iterator of returns(t, name)) {
        for (let next of returns(iterator, 'next')) {
          if (async) next = this.awaitedType(next);
          const members =
            next.flags & TypeFlags.Union ? this.memberTypes(next) : [next];
          for (const member of members) {
            const apparent = this.checker.getApparentType(member as any) as any;
            const done = this.checker.getPropertyOfType(apparent, 'done');
            if (done && this.isTrue(this.typeOfSymbol(done))) continue;
            const value = this.checker.getPropertyOfType(apparent, 'value');
            if (value) {
              const v = this.typeOfSymbol(value);
              result.push(awaited ? this.awaitedType(v) : v);
            }
          }
        }
      }
      return result;
    }
    return [];
  }

  // The name of the property that a well-known symbol (Symbol.iterator,
  // Symbol.asyncIterator) keys, as the lib's interface of it has it: only
  // that one, not every name of the prefix, which a unique symbol of the
  // program's of the same name has too. Undefined if the lib has none.
  private wellKnownName(iface: string, prefix: string): string | undefined {
    if (this.wellKnown.has(iface)) return this.wellKnown.get(iface);
    const symbol = this.checker.resolveName(iface, SymbolFlags.Interface);
    const name = symbol
      ? this.checker
          .getPropertiesOfType(this.checker.getDeclaredTypeOfSymbol(symbol))
          .find(p => p.name.startsWith(prefix))?.name
      : undefined;
    this.wellKnown.set(iface, name);
    return name;
  }

  // Whether t is the literal type true.
  isTrue(t: Type): boolean {
    return (
      !!(t.flags & TypeFlags.BooleanLiteral) && this.typeToString(t) === 'true'
    );
  }

  typeArguments(t: Type): readonly Type[] {
    let args = this.typeArgs.get(t);
    if (!args) {
      args = this.checker.getTypeArguments(t as any);
      this.typeArgs.set(t, args);
    }
    return args;
  }

  // The members of a union or intersection.
  memberTypes(t: Type): readonly Type[] {
    return (t as any).getTypes() ?? [];
  }

  // Type.Target(): the generic type of a type reference, or the type an
  // anonymous or mapped type was instantiated from.
  typeTarget(t: Type): Type | undefined {
    if (!(t.flags & TypeFlags.Object) || !(t as any).target) return undefined;
    return (t as any).getTarget() as Type | undefined;
  }

  typeSymbol(t: Type): TsSymbol | undefined {
    return t.getSymbol();
  }

  typeToString(t: Type): string {
    let s = this.typeStrings.get(t);
    if (s === undefined) {
      s = this.checker.typeToString(t);
      this.typeStrings.set(t, s);
    }
    return s;
  }

  // checker.tryGetTypeAtPosition: the type of the parameter an argument at a
  // position is passed to, or undefined past the parameters.
  parameterTypeAt(signature: Signature, pos: number): Type | undefined {
    const rest = signature.hasRestParameter;
    const count = signature.parameters.length - (rest ? 1 : 0);
    if (pos >= count && !rest) return undefined;
    return this.checker.getParameterType(signature, pos);
  }

  // checker.getContextualSignatureForFunctionLikeDeclaration (for function
  // expressions, arrow functions and object literal methods).
  contextualSignature(fn: Node): Signature | undefined {
    if (this.contextualSignatures.has(fn))
      return this.contextualSignatures.get(fn);
    let result: Signature | undefined;
    let t: Type | undefined;
    if (fn.kind === K.MethodDeclaration) {
      // An object literal method: the type of its property in the literal's
      // contextual type.
      const literalType = this.checker.getContextualType(fn.parent as any);
      const name = fn.name?.text as string | undefined;
      if (literalType && name !== undefined)
        t = this.checker.getTypeOfPropertyOfType(
          this.checker.getApparentType(literalType),
          name,
        );
    } else {
      t = this.checker.getContextualType(fn as any);
    }
    if (t) {
      const members = t.flags & TypeFlags.Union ? this.memberTypes(t) : [t];
      for (const member of members) {
        const signatures = this.checker.getSignaturesOfType(
          member.flags & TypeFlags.TypeParameter
            ? this.checker.getApparentType(member)
            : member,
          SignatureKind.Call,
        );
        if (signatures.length === 1) {
          result ??= signatures[0];
        } else if (signatures.length > 1 && members.length === 1) {
          result = undefined;
        }
      }
    }
    this.contextualSignatures.set(fn, result);
    return result;
  }
}

// Reports whether the analysis may ask for the type of an expression (to
// prefetch it): not for property names, declaration names, callees, updated
// variables, operands of arithmetic, and the like.
function isTypeQueried(node: Node): boolean {
  const parent = node.parent as Node | undefined;
  switch (node.kind) {
    case K.PostfixUnaryExpression:
    case K.PrefixUnaryExpression:
    case K.ConditionalExpression:
    case K.ParenthesizedExpression:
      return false;
    case K.Identifier:
      if (isDeclarationName(node)) return false;
      switch (parent?.kind) {
        case K.PropertyAccessExpression:
          return parent.name !== node;
        case K.CallExpression:
        case K.NewExpression:
          return parent.expression !== node;
        case K.PostfixUnaryExpression:
        case K.PrefixUnaryExpression:
          return false;
        case K.BinaryExpression:
          return isQueriedOperator(parent.operatorToken.kind);
      }
  }
  return true;
}

function isQueriedOperator(op: K): boolean {
  switch (op) {
    case K.PlusToken:
    case K.PlusEqualsToken:
    case K.EqualsToken:
    case K.BarBarEqualsToken:
    case K.AmpersandAmpersandEqualsToken:
    case K.QuestionQuestionEqualsToken:
    case K.EqualsEqualsEqualsToken:
    case K.ExclamationEqualsEqualsToken:
    case K.EqualsEqualsToken:
    case K.ExclamationEqualsToken:
    case K.BarBarToken:
    case K.AmpersandAmpersandToken:
    case K.QuestionQuestionToken:
    case K.CommaToken:
    case K.InKeyword:
    case K.InstanceOfKeyword:
      return true;
  }
  return false;
}

// The project of a tsconfig, read from disk, or from `fileSystem`: the files
// sent with the request (an API with no disk, as in WebAssembly).
export function createHost(
  api: API,
  tsconfig: string,
  fileSystem?: RequestFileSystem,
): Host {
  const snapshot = api.createSnapshot({
    openProjects: [tsconfig],
    ...(fileSystem && {fileSystem}),
  });
  const project =
    snapshot.getConfiguredProject(tsconfig) ?? snapshot.getProjects()[0];
  if (!project) {
    snapshot.dispose();
    throw new Error(`cannot open the project of ${tsconfig}`);
  }
  return new Host(api, snapshot, project.program, project.checker);
}
