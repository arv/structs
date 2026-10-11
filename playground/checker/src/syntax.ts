// Syntax helpers: the predicates of TypeScript's Go AST package (internal/ast) that the ownership
// checker uses, over the nodes of TypeScript 7.1's JavaScript API.

import { NodeFlags, SyntaxKind as K } from "typescript/ast";
import type { Node as TsNode, SourceFile } from "typescript/ast";

// A node of the API's tree, with its kind-specific properties (`expression`, `name`, ...) untyped.
export type Node = TsNode & { readonly [property: string]: any };

export { K, NodeFlags };

export function forEachChild(node: Node, visit: (child: Node) => boolean | void): boolean {
  let stop = false;
  node.forEachChild((child) => {
    if (stop) return true;
    if (visit(child as Node)) stop = true;
    return stop ? true : undefined;
  });
  return stop;
}

export function isTypeNode(node: Node): boolean {
  const kind = node.kind;
  return kind >= K.FirstTypeNode && kind <= K.LastTypeNode ||
    kind === K.AnyKeyword || kind === K.UnknownKeyword || kind === K.NumberKeyword || kind === K.BigIntKeyword ||
    kind === K.ObjectKeyword || kind === K.BooleanKeyword || kind === K.StringKeyword || kind === K.SymbolKeyword ||
    kind === K.VoidKeyword || kind === K.UndefinedKeyword || kind === K.NeverKeyword || kind === K.IntrinsicKeyword ||
    kind === K.ExpressionWithTypeArguments || kind === K.JSDocAllType || kind === K.JSDocNullableType ||
    kind === K.JSDocNonNullableType || kind === K.JSDocOptionalType || kind === K.JSDocVariadicType ||
    kind === K.JSDocTypeExpression || kind === K.JSDocTypeLiteral || kind === K.JSDocSignature;
}

// ast.IsExpression: an expression kind.
export function isExpression(node: Node): boolean {
  switch (node.kind) {
    case K.ConditionalExpression: case K.YieldExpression: case K.ArrowFunction: case K.BinaryExpression:
    case K.SpreadElement: case K.AsExpression: case K.OmittedExpression: case K.SatisfiesExpression:
    case K.PartiallyEmittedExpression:
    case K.PrefixUnaryExpression: case K.PostfixUnaryExpression: case K.DeleteExpression: case K.TypeOfExpression:
    case K.VoidExpression: case K.AwaitExpression: case K.TypeAssertionExpression:
    case K.PropertyAccessExpression: case K.ElementAccessExpression: case K.NewExpression: case K.CallExpression:
    case K.JsxElement: case K.JsxSelfClosingElement: case K.JsxFragment: case K.TaggedTemplateExpression:
    case K.ArrayLiteralExpression: case K.ParenthesizedExpression: case K.ObjectLiteralExpression:
    case K.ClassExpression: case K.FunctionExpression: case K.Identifier: case K.PrivateIdentifier:
    case K.RegularExpressionLiteral: case K.NumericLiteral: case K.BigIntLiteral: case K.StringLiteral:
    case K.NoSubstitutionTemplateLiteral: case K.TemplateExpression: case K.FalseKeyword: case K.NullKeyword:
    case K.ThisKeyword: case K.TrueKeyword: case K.SuperKeyword: case K.NonNullExpression:
    case K.ExpressionWithTypeArguments: case K.MetaProperty: case K.ImportKeyword: case K.MissingDeclaration:
    case K.JsxExpression:
      return true;
  }
  return false;
}

export function isFunctionLikeDeclaration(node: Node | undefined): boolean {
  switch (node?.kind) {
    case K.FunctionDeclaration: case K.MethodDeclaration: case K.Constructor: case K.GetAccessor:
    case K.SetAccessor: case K.FunctionExpression: case K.ArrowFunction:
      return true;
  }
  return false;
}

export function isFunctionLike(node: Node | undefined): boolean {
  switch (node?.kind) {
    case K.MethodSignature: case K.CallSignature: case K.JSDocSignature: case K.ConstructSignature:
    case K.IndexSignature: case K.FunctionType: case K.ConstructorType:
      return true;
  }
  return isFunctionLikeDeclaration(node);
}

export function isClassLike(node: Node): boolean {
  return node.kind === K.ClassDeclaration || node.kind === K.ClassExpression;
}

export function isFunctionExpressionOrArrowFunction(node: Node | undefined): boolean {
  return node?.kind === K.FunctionExpression || node?.kind === K.ArrowFunction;
}

export function isObjectLiteralMethod(node: Node | undefined): boolean {
  return node?.kind === K.MethodDeclaration && node.parent?.kind === K.ObjectLiteralExpression;
}

export function isBindingPattern(node: Node | undefined): boolean {
  return node?.kind === K.ObjectBindingPattern || node?.kind === K.ArrayBindingPattern;
}

export function isAccessExpression(node: Node): boolean {
  return node.kind === K.PropertyAccessExpression || node.kind === K.ElementAccessExpression;
}

export function isOptionalChain(node: Node): boolean {
  if ((node.flags & NodeFlags.OptionalChain) === 0) return false;
  switch (node.kind) {
    case K.PropertyAccessExpression: case K.ElementAccessExpression: case K.CallExpression: case K.NonNullExpression:
      return true;
  }
  return false;
}

export function isAssignmentOperator(kind: K): boolean {
  return kind >= K.FirstAssignment && kind <= K.LastAssignment;
}

export function skipParentheses(node: Node): Node {
  while (node.kind === K.ParenthesizedExpression) node = node.expression;
  return node;
}

// ast.OuterExpressionKinds
export const OEK = { Parentheses: 1, TypeAssertions: 2, NonNullAssertions: 4, PartiallyEmitted: 8, ExpressionsWithTypeArguments: 16, Satisfies: 32, Assertions: 2 | 4 | 32, All: 1 | 2 | 4 | 8 | 16 | 32 } as const;

export function isOuterExpression(node: Node, kinds: number): boolean {
  switch (node.kind) {
    case K.ParenthesizedExpression: return (kinds & OEK.Parentheses) !== 0;
    case K.TypeAssertionExpression: case K.AsExpression: return (kinds & OEK.TypeAssertions) !== 0;
    case K.SatisfiesExpression: return (kinds & (OEK.ExpressionsWithTypeArguments | OEK.Satisfies)) !== 0;
    case K.ExpressionWithTypeArguments: return (kinds & OEK.ExpressionsWithTypeArguments) !== 0;
    case K.NonNullExpression: return (kinds & OEK.NonNullAssertions) !== 0;
    case K.PartiallyEmittedExpression: return (kinds & OEK.PartiallyEmitted) !== 0;
  }
  return false;
}

export function skipOuterExpressions(node: Node, kinds: number): Node {
  while (isOuterExpression(node, kinds)) node = node.expression;
  return node;
}

export function walkUpParenthesizedExpressions(node: Node | undefined): Node | undefined {
  while (node && node.kind === K.ParenthesizedExpression) node = node.parent as Node;
  return node;
}

export function findAncestor(node: Node | undefined, test: (n: Node) => boolean): Node | undefined {
  while (node) {
    if (test(node)) return node;
    node = node.parent as Node | undefined;
  }
  return undefined;
}

// ast.GetContainingFunction
export function getContainingFunction(node: Node): Node | undefined {
  return findAncestor(node.parent as Node, isFunctionLike);
}

export function isThisParameter(node: Node): boolean {
  return node.kind === K.Parameter && node.name?.kind === K.Identifier && node.name.text === "this";
}

function hasModifier(node: Node, kind: K): boolean {
  return !!node.modifiers?.some((m: Node) => m.kind === kind);
}

export const FunctionFlags = { Normal: 0, Generator: 1, Async: 2, Invalid: 4 } as const;

// ast.GetFunctionFlags
export function getFunctionFlags(node: Node | undefined): number {
  if (!node || !isFunctionLikeDeclaration(node)) return FunctionFlags.Invalid;
  let flags = FunctionFlags.Normal;
  switch (node.kind) {
    case K.FunctionDeclaration: case K.FunctionExpression: case K.MethodDeclaration:
      if (node.asteriskToken) flags |= FunctionFlags.Generator;
    // falls through
    case K.ArrowFunction:
      if (hasModifier(node, K.AsyncKeyword)) flags |= FunctionFlags.Async;
  }
  if (!node.body) flags |= FunctionFlags.Invalid;
  return flags;
}

export function isParameterPropertyDeclaration(node: Node, parent: Node): boolean {
  return node.kind === K.Parameter && parent.kind === K.Constructor && !!node.modifiers?.some((m: Node) =>
    m.kind === K.PublicKeyword || m.kind === K.PrivateKeyword || m.kind === K.ProtectedKeyword ||
    m.kind === K.ReadonlyKeyword || m.kind === K.OverrideKeyword);
}

// ast.GetCombinedNodeFlags, for variable declarations and their lists.
export function getCombinedNodeFlags(node: Node): number {
  while (node.kind === K.BindingElement || isBindingPattern(node)) node = node.parent as Node;
  let flags = node.flags;
  let n: Node | undefined = node;
  if (n.kind === K.VariableDeclaration) n = n.parent as Node;
  if (n && n.kind === K.VariableDeclarationList) {
    flags |= n.flags;
    n = n.parent as Node;
  }
  if (n && n.kind === K.VariableStatement) flags |= n.flags;
  return flags;
}

// The declaration kinds that have a name (ast.IsDeclaration with Name()).
const namedDeclarationKinds = new Set<K>([
  K.BindingElement, K.ClassDeclaration, K.ClassExpression, K.EnumDeclaration, K.EnumMember, K.ExportSpecifier,
  K.FunctionDeclaration, K.FunctionExpression, K.ImportClause, K.ImportEqualsDeclaration, K.ImportSpecifier,
  K.InterfaceDeclaration, K.JsxAttribute, K.MethodDeclaration, K.MethodSignature, K.ModuleDeclaration,
  K.NamedTupleMember, K.NamespaceExport, K.NamespaceExportDeclaration, K.NamespaceImport, K.Parameter,
  K.PropertyAssignment, K.PropertyDeclaration, K.PropertySignature, K.ShorthandPropertyAssignment,
  K.TypeAliasDeclaration, K.TypeParameter, K.VariableDeclaration, K.GetAccessor, K.SetAccessor,
]);

// ast.IsDeclarationName
export function isDeclarationName(name: Node): boolean {
  const parent = name.parent as Node | undefined;
  return name.kind !== K.SourceFile && !isBindingPattern(name) && !!parent && namedDeclarationKinds.has(parent.kind) && parent.name === name;
}

function isPartOfTypeExpressionWithTypeArguments(node: Node): boolean {
  const parent = node.parent as Node;
  return parent.kind === K.HeritageClause && (!isClassLike(parent.parent as Node) || parent.token === K.ImplementsKeyword) ||
    parent.kind === K.JSDocImplementsTag || parent.kind === K.JSDocAugmentsTag;
}

function isPartOfTypeNodeInParent(node: Node): boolean {
  const parent = node.parent as Node;
  if (parent.kind === K.TypeQuery) return false;
  if (parent.kind === K.ImportType) return !parent.isTypeOf;
  if (parent.kind >= K.FirstTypeNode && parent.kind <= K.LastTypeNode) return true;
  switch (parent.kind) {
    case K.ExpressionWithTypeArguments:
      return isPartOfTypeExpressionWithTypeArguments(parent);
    case K.TypeParameter:
      return node === parent.constraint;
    case K.VariableDeclaration: case K.Parameter: case K.PropertyDeclaration: case K.PropertySignature:
    case K.FunctionDeclaration: case K.FunctionExpression: case K.ArrowFunction: case K.Constructor:
    case K.MethodDeclaration: case K.MethodSignature: case K.GetAccessor: case K.SetAccessor: case K.CallSignature:
    case K.ConstructSignature: case K.IndexSignature: case K.TypeAssertionExpression:
      return node === parent.type;
    case K.CallExpression: case K.NewExpression: case K.TaggedTemplateExpression:
      return !!parent.typeArguments?.includes(node);
  }
  return false;
}

// ast.IsPartOfTypeNode
export function isPartOfTypeNode(node: Node): boolean {
  const kind = node.kind;
  if (kind >= K.FirstTypeNode && kind <= K.LastTypeNode) return true;
  switch (kind) {
    case K.AnyKeyword: case K.UnknownKeyword: case K.NumberKeyword: case K.BigIntKeyword: case K.StringKeyword:
    case K.BooleanKeyword: case K.SymbolKeyword: case K.ObjectKeyword: case K.UndefinedKeyword: case K.NullKeyword:
    case K.NeverKeyword:
      return true;
    case K.VoidKeyword:
      return node.parent?.kind !== K.VoidExpression;
    case K.ExpressionWithTypeArguments:
      return isPartOfTypeExpressionWithTypeArguments(node);
    case K.TypeParameter:
      return node.parent?.kind === K.MappedType || node.parent?.kind === K.InferType;
    case K.Identifier: {
      const parent = node.parent as Node;
      if (parent.kind === K.QualifiedName && parent.right === node) return isPartOfTypeNodeInParent(parent);
      if (parent.kind === K.PropertyAccessExpression && parent.name === node) return isPartOfTypeNodeInParent(parent);
      return isPartOfTypeNodeInParent(node);
    }
    case K.QualifiedName: case K.PropertyAccessExpression: case K.ThisKeyword:
      return isPartOfTypeNodeInParent(node);
  }
  return false;
}

function isJsxTagName(node: Node): boolean {
  const parent = node.parent as Node;
  switch (parent.kind) {
    case K.JsxOpeningElement: case K.JsxSelfClosingElement: case K.JsxClosingElement:
      return parent.tagName === node;
  }
  return false;
}

function isImportCall(node: Node): boolean {
  if (node.kind !== K.CallExpression) return false;
  const e = node.expression as Node;
  return e.kind === K.ImportKeyword || e.kind === K.MetaProperty && e.keywordToken === K.ImportKeyword && e.name?.text === "defer";
}

// ast.IsExpressionNode
export function isExpressionNode(node: Node): boolean {
  switch (node.kind) {
    case K.SuperKeyword: case K.NullKeyword: case K.TrueKeyword: case K.FalseKeyword: case K.RegularExpressionLiteral:
    case K.ArrayLiteralExpression: case K.ObjectLiteralExpression: case K.PropertyAccessExpression:
    case K.ElementAccessExpression: case K.CallExpression: case K.NewExpression: case K.TaggedTemplateExpression:
    case K.AsExpression: case K.TypeAssertionExpression: case K.SatisfiesExpression: case K.NonNullExpression:
    case K.ParenthesizedExpression: case K.FunctionExpression: case K.ClassExpression: case K.ArrowFunction:
    case K.VoidExpression: case K.DeleteExpression: case K.TypeOfExpression: case K.PrefixUnaryExpression:
    case K.PostfixUnaryExpression: case K.BinaryExpression: case K.ConditionalExpression: case K.SpreadElement:
    case K.TemplateExpression: case K.OmittedExpression: case K.JsxElement: case K.JsxSelfClosingElement:
    case K.JsxFragment: case K.YieldExpression: case K.AwaitExpression:
      return true;
    case K.MetaProperty:
      return !isImportCall(node.parent as Node) || (node.parent as Node).expression !== node;
    case K.ExpressionWithTypeArguments:
      return node.parent?.kind !== K.HeritageClause;
    case K.QualifiedName: {
      let n = node;
      while ((n.parent as Node).kind === K.QualifiedName) n = n.parent as Node;
      const p = n.parent as Node;
      return p.kind === K.TypeQuery || p.kind === K.JSDocLink || p.kind === K.JSDocLinkCode || p.kind === K.JSDocLinkPlain ||
        p.kind === K.JSDocNameReference || isJsxTagName(n);
    }
    case K.PrivateIdentifier: {
      const p = node.parent as Node;
      return p.kind === K.BinaryExpression && p.left === node && p.operatorToken.kind === K.InKeyword;
    }
    case K.Identifier: {
      const p = node.parent as Node;
      if (p.kind === K.TypeQuery || p.kind === K.JSDocLink || p.kind === K.JSDocLinkCode || p.kind === K.JSDocLinkPlain ||
        p.kind === K.JSDocNameReference || isJsxTagName(node)) {
        return true;
      }
      return isInExpressionContext(node);
    }
    case K.NumericLiteral: case K.BigIntLiteral: case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: case K.ThisKeyword:
      return isInExpressionContext(node);
  }
  return false;
}

// ast.IsInExpressionContext
function isInExpressionContext(node: Node): boolean {
  const parent = node.parent as Node;
  switch (parent.kind) {
    case K.VariableDeclaration: case K.Parameter: case K.PropertyDeclaration: case K.PropertySignature:
    case K.EnumMember: case K.PropertyAssignment: case K.BindingElement:
      return parent.initializer === node;
    case K.ExpressionStatement: case K.IfStatement: case K.DoStatement: case K.WhileStatement: case K.ReturnStatement:
    case K.WithStatement: case K.SwitchStatement: case K.CaseClause: case K.DefaultClause: case K.ThrowStatement:
    case K.TypeAssertionExpression: case K.AsExpression: case K.TemplateSpan: case K.ComputedPropertyName:
    case K.SatisfiesExpression:
      return parent.expression === node;
    case K.ForStatement:
      return parent.initializer === node && parent.initializer.kind !== K.VariableDeclarationList ||
        parent.condition === node || parent.incrementor === node;
    case K.ForInStatement: case K.ForOfStatement:
      return parent.initializer === node && parent.initializer.kind !== K.VariableDeclarationList || parent.expression === node;
    case K.Decorator: case K.JsxExpression: case K.JsxSpreadAttribute: case K.SpreadAssignment:
      return true;
    case K.ExpressionWithTypeArguments:
      return parent.expression === node && !isPartOfTypeNode(parent);
    case K.ShorthandPropertyAssignment:
      return parent.objectAssignmentInitializer === node;
  }
  return isExpressionNode(parent);
}

// ast.GetAssignmentTarget
export function getAssignmentTarget(node: Node): Node | undefined {
  for (;;) {
    const parent = node.parent as Node | undefined;
    if (!parent) return undefined;
    switch (parent.kind) {
      case K.BinaryExpression:
        return isAssignmentOperator(parent.operatorToken.kind) && parent.left === node ? parent : undefined;
      case K.PrefixUnaryExpression: case K.PostfixUnaryExpression:
        return parent.operator === K.PlusPlusToken || parent.operator === K.MinusMinusToken ? parent : undefined;
      case K.ForInStatement: case K.ForOfStatement:
        return parent.initializer === node ? parent : undefined;
      case K.ParenthesizedExpression: case K.ArrayLiteralExpression: case K.SpreadElement: case K.NonNullExpression:
        node = parent;
        break;
      case K.SpreadAssignment:
        node = parent.parent as Node;
        break;
      case K.ShorthandPropertyAssignment:
        if (parent.name !== node) return undefined;
        node = parent.parent as Node;
        break;
      case K.PropertyAssignment:
        if (parent.name === node) return undefined;
        node = parent.parent as Node;
        break;
      default:
        return undefined;
    }
  }
}

export function isAssignmentTarget(node: Node): boolean {
  return getAssignmentTarget(node) !== undefined;
}

export function isPropertyNameLiteral(node: Node): boolean {
  switch (node.kind) {
    case K.Identifier: case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: case K.NumericLiteral:
      return true;
  }
  return false;
}

// The start of a diagnostic's span for a node (scanner.GetErrorRangeForNode).
export function errorStart(sourceFile: SourceFile, node: Node): number {
  let errorNode: Node | undefined = node;
  switch (node.kind) {
    case K.FunctionDeclaration: case K.MethodDeclaration:
      if (node.flags & NodeFlags.Reparsed) break;
    // falls through
    case K.VariableDeclaration: case K.BindingElement: case K.ClassDeclaration: case K.InterfaceDeclaration:
    case K.ModuleDeclaration: case K.EnumDeclaration: case K.EnumMember: case K.FunctionExpression:
    case K.GetAccessor: case K.SetAccessor: case K.TypeAliasDeclaration: case K.PropertyDeclaration:
    case K.PropertySignature: case K.NamespaceImport:
      errorNode = node.name;
      break;
    case K.ClassExpression:
      errorNode = node.name;
      break;
    case K.SatisfiesExpression:
      return skipTrivia(sourceFile.text, node.expression.end);
  }
  if (!errorNode) return skipTrivia(sourceFile.text, node.pos);
  return errorNode.getStart(sourceFile);
}

// scanner.SkipTrivia (whitespace and comments).
export function skipTrivia(text: string, pos: number): number {
  for (;;) {
    const ch = text.charCodeAt(pos);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 11 || ch === 12 || ch === 0xa0 || ch === 0xfeff ||
      ch === 0x2028 || ch === 0x2029) {
      pos++;
      continue;
    }
    if (ch === 47 /* / */) {
      const next = text.charCodeAt(pos + 1);
      if (next === 47) {
        pos += 2;
        while (pos < text.length && text.charCodeAt(pos) !== 10 && text.charCodeAt(pos) !== 13) pos++;
        continue;
      }
      if (next === 42) {
        const end = text.indexOf("*/", pos + 2);
        pos = end < 0 ? text.length : end + 2;
        continue;
      }
    }
    return pos;
  }
}

// Reports whether an identifier refers to a variable (rather than naming a property, a declaration
// or a label): isOwnValueReference of ownership.go.
export function isOwnValueReference(id: Node): boolean {
  const parent = id.parent as Node | undefined;
  if (!parent) return false;
  switch (parent.kind) {
    case K.PropertyAccessExpression: case K.PropertyAssignment: case K.PropertyDeclaration: case K.PropertySignature:
    case K.MethodDeclaration: case K.MethodSignature: case K.GetAccessor: case K.SetAccessor: case K.EnumMember:
    case K.VariableDeclaration: case K.Parameter: case K.FunctionDeclaration: case K.FunctionExpression:
    case K.ClassDeclaration: case K.ClassExpression: case K.TypeParameter: case K.ImportSpecifier:
    case K.ExportSpecifier: case K.ImportClause: case K.NamespaceImport: case K.ImportEqualsDeclaration:
    case K.InterfaceDeclaration: case K.TypeAliasDeclaration: case K.EnumDeclaration: case K.ModuleDeclaration:
    case K.JsxAttribute: case K.NamespaceExport:
      return parent.name !== id;
    case K.BindingElement:
      return parent.name !== id && parent.propertyName !== id;
    case K.LabeledStatement: case K.BreakStatement: case K.ContinueStatement: case K.MetaProperty: case K.QualifiedName:
      return false;
  }
  return true;
}

// Reports whether an identifier is in a reference position: isOwnReferencePosition of
// ownrefcount.go.
export function isOwnReferencePosition(id: Node): boolean {
  const parent = id.parent as Node | undefined;
  if (!parent) return false;
  switch (parent.kind) {
    case K.PropertyAccessExpression:
      if (parent.name === id) return false;
      break;
    case K.MetaProperty: case K.QualifiedName:
      return false;
  }
  return !isDeclarationName(id) && !isPartOfTypeNode(id) && isExpressionNode(id);
}

// Reports whether an expression is a value (not a property name, a declaration name, a label...):
// isOwnValueExpression of ownrefcount.go.
export function isOwnValueExpression(node: Node): boolean {
  if (!node.parent || !isExpression(node)) return false;
  if (node.kind === K.Identifier || node.kind === K.PrivateIdentifier) return isOwnReferencePosition(node);
  return true;
}

export function isWithin(node: Node | undefined, ancestor: Node): boolean {
  for (let n = node; n; n = n.parent as Node | undefined) {
    if (n === ancestor) return true;
  }
  return false;
}
