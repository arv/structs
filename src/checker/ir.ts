// The code the transform (transform.ts) builds, before it is written into the
// source: a tree of the original nodes, each with the edits of its parts, and
// of generated expressions and statements around them. Writing it edits the
// original text in place with magic-string, so that what is left of the
// original (an object, an index, a statement) keeps its place and its source
// map: generated text goes into the gaps between the original parts it keeps,
// in the order it names them; an original part named a second time, or out of
// order, is copied.
//
// Generated expressions carry their precedence (TypeScript's
// OperatorPrecedence), and a part of lower precedence than its place needs is
// parenthesized as it is built, as the fork's printer parenthesizes the nodes
// its transforms make.

import type MagicString from 'magic-string';
import {K} from './syntax.ts';
import type {Node} from './syntax.ts';

export const Prec = {
  Comma: 0,
  Spread: 1,
  Yield: 2,
  Assignment: 3,
  Conditional: 4,
  Coalesce: 4,
  LogicalOR: 5,
  LogicalAND: 6,
  BitwiseOR: 7,
  BitwiseXOR: 8,
  BitwiseAND: 9,
  Equality: 10,
  Relational: 11,
  Shift: 12,
  Additive: 13,
  Multiplicative: 14,
  Exponentiation: 15,
  Unary: 16,
  Update: 17,
  LeftHandSide: 18,
  Member: 19,
  Primary: 20,
} as const;

// A temporary variable (`_a`), declared in the var scope of the function (or
// file) it is created in, and named when the code is written.
export interface Temp {
  scope: Scope;
  name?: string;
}
// The temporaries of a function or a file, in the order they were declared.
export interface Scope {
  temps: Temp[];
}

// An original node (its range: from its first token, or for a statement from
// its leading trivia, to its end), with edits of the parts of it that changed.
export interface Src {
  k: 'src';
  node: Node;
  start: number;
  end: number;
  edits: Edit[];
  prec: number;
}
export interface Edit {
  start: number;
  end: number;
  ir: Ir;
}
// A reference resolved when the code is written: a runtime helper by name, a
// temporary, or the `var` declarations of a scope's temporaries.
export type Ref =
  | {k: 'helper'; name: string}
  | {k: 'temp'; temp: Temp}
  | {k: 'vars'; scope: Scope}
  | {k: 'copy'; ir: Ir}; // code written as a copy, wherever its original is
export type Part = string | Ir | Ref;
// Generated code. `tag` tells the shapes apart that the transform looks at
// again (the fork looks at the nodes it made).
export interface Gen {
  k: 'gen';
  prec: number;
  parts: Part[];
  tag?: Tag;
}
export type Tag =
  | {t: 'paren'; inner: Ir}
  | {t: 'binary'; op: string; left: Ir; right: Ir}
  | {t: 'elem'; index: Ir}
  | {t: 'temp'; temp: Temp}
  | {t: 'simple'} // an identifier or a number: copied freely
  | {t: 'stmts'; list: Ir[]} // statements in a statement's place
  | {t: 'block'; list: Ir[]}; // a block of statements
export type Ir = Src | Gen;

export const isGen = (ir: Ir): ir is Gen => ir.k === 'gen';

// The precedence of an original expression.
export function precOf(node: Node): number {
  switch (node.kind) {
    case K.BinaryExpression:
      return binaryPrec(node.operatorToken.kind);
    case K.ConditionalExpression:
      return Prec.Conditional;
    case K.ArrowFunction:
      return Prec.Assignment;
    case K.YieldExpression:
      return Prec.Yield;
    case K.SpreadElement:
      return Prec.Spread;
    case K.PrefixUnaryExpression:
    case K.TypeOfExpression:
    case K.VoidExpression:
    case K.DeleteExpression:
    case K.AwaitExpression:
    case K.TypeAssertionExpression:
      return Prec.Unary;
    case K.PostfixUnaryExpression:
      return Prec.Update;
    case K.CallExpression:
      return Prec.LeftHandSide;
    case K.NewExpression:
      return node.arguments ? Prec.Member : Prec.LeftHandSide;
    case K.PropertyAccessExpression:
    case K.ElementAccessExpression:
    case K.TaggedTemplateExpression:
    case K.NonNullExpression:
    case K.MetaProperty:
      return Prec.Member;
    case K.AsExpression:
    case K.SatisfiesExpression:
      return Prec.Relational;
  }
  return Prec.Primary;
}

export function binaryPrec(op: K | string): number {
  switch (op) {
    case K.CommaToken:
    case ',':
      return Prec.Comma;
    case K.QuestionQuestionToken:
    case '??':
      return Prec.Coalesce;
    case K.BarBarToken:
    case '||':
      return Prec.LogicalOR;
    case K.AmpersandAmpersandToken:
    case '&&':
      return Prec.LogicalAND;
    case K.BarToken:
    case '|':
      return Prec.BitwiseOR;
    case K.CaretToken:
    case '^':
      return Prec.BitwiseXOR;
    case K.AmpersandToken:
    case '&':
      return Prec.BitwiseAND;
    case K.EqualsEqualsToken:
    case K.ExclamationEqualsToken:
    case K.EqualsEqualsEqualsToken:
    case K.ExclamationEqualsEqualsToken:
    case '==':
    case '!=':
    case '===':
    case '!==':
      return Prec.Equality;
    case K.LessThanToken:
    case K.GreaterThanToken:
    case K.LessThanEqualsToken:
    case K.GreaterThanEqualsToken:
    case K.InstanceOfKeyword:
    case K.InKeyword:
    case '<':
    case '>':
    case '<=':
    case '>=':
      return Prec.Relational;
    case K.LessThanLessThanToken:
    case K.GreaterThanGreaterThanToken:
    case K.GreaterThanGreaterThanGreaterThanToken:
    case '<<':
    case '>>':
    case '>>>':
      return Prec.Shift;
    case K.PlusToken:
    case K.MinusToken:
    case '+':
    case '-':
      return Prec.Additive;
    case K.AsteriskToken:
    case K.SlashToken:
    case K.PercentToken:
    case '*':
    case '/':
    case '%':
      return Prec.Multiplicative;
    case K.AsteriskAsteriskToken:
    case '**':
      return Prec.Exponentiation;
  }
  return Prec.Assignment; // =, +=, ||=, ...
}

// Builds generated code.
export const gen = (prec: number, parts: Part[], tag?: Tag): Gen => ({
  k: 'gen',
  prec,
  parts,
  tag,
});

export const paren = (inner: Ir): Gen =>
  gen(Prec.Primary, ['(', inner, ')'], {t: 'paren', inner});

// inner, parenthesized if its precedence is below min
export const atLeast = (inner: Ir, min: number): Ir =>
  inner.prec < min ? paren(inner) : inner;

const isLogical = (op: string) => op === '||' || op === '&&';

export function binary(left: Ir, op: string, right: Ir): Gen {
  const prec = binaryPrec(op);
  const rightAssoc = prec === Prec.Assignment || op === '**';
  const opOf = (ir: Ir): string | undefined =>
    isGen(ir) && ir.tag?.t === 'binary'
      ? ir.tag.op
      : ir.k === 'src' && ir.node.kind === K.BinaryExpression
        ? tokenText(ir.node.operatorToken.kind)
        : undefined;
  const wrap = (ir: Ir, isLeft: boolean): Ir => {
    if (ir.prec < prec) return paren(ir);
    const childOp = opOf(ir);
    // ?? does not mix with || and && unparenthesized
    if (
      childOp &&
      ((op === '??' && isLogical(childOp)) ||
        (isLogical(op) && childOp === '??'))
    )
      return paren(ir);
    if (ir.prec === prec && (isLeft ? rightAssoc : !rightAssoc))
      return paren(ir);
    return ir;
  };
  const l = wrap(left, true),
    r = wrap(right, false);
  return gen(prec, [l, ` ${op} `, r], {t: 'binary', op, left: l, right: r});
}

export function cond(c: Ir, t: Ir, f: Ir): Gen {
  return gen(Prec.Conditional, [
    atLeast(c, Prec.Coalesce + 1),
    ' ? ',
    atLeast(t, Prec.Assignment),
    ' : ',
    atLeast(f, Prec.Assignment),
  ]);
}

export function comma(list: Ir[]): Ir {
  if (list.length === 1) return list[0]!;
  const parts: Part[] = [];
  list.forEach((e, i) => {
    if (i > 0) parts.push(', ');
    parts.push(e);
  });
  return gen(Prec.Comma, parts);
}

export function call(callee: Ir, args: Ir[]): Gen {
  const parts: Part[] = [atLeast(callee, Prec.LeftHandSide), '('];
  args.forEach((a, i) => {
    if (i > 0) parts.push(', ');
    parts.push(atLeast(a, Prec.Assignment));
  });
  parts.push(')');
  return gen(Prec.LeftHandSide, parts);
}

export function elem(object: Ir, index: Ir): Gen {
  return gen(
    Prec.Member,
    [atLeast(object, Prec.LeftHandSide), '[', index, ']'],
    {t: 'elem', index},
  );
}

export function prefix(op: string, operand: Ir): Gen {
  const min = op === '++' || op === '--' ? Prec.LeftHandSide : Prec.Unary;
  // `- -x`, `+ +x`: a space keeps two operators apart
  const operandIr = atLeast(operand, min);
  return gen(Prec.Unary, [op, operandIr]);
}

export const raw = (text: string, prec: number = Prec.Primary): Gen =>
  gen(prec, [text]);

export const num = (n: number): Gen =>
  n < 0
    ? gen(Prec.Unary, [String(n)])
    : gen(Prec.Primary, [String(n)], {t: 'simple'});

export const str = (s: string): Gen =>
  gen(Prec.Primary, [JSON.stringify(s)], {t: 'simple'});

export const tempRef = (temp: Temp): Gen =>
  gen(Prec.Primary, [{k: 'temp', temp}], {t: 'temp', temp});

export const helperRef = (name: string): Gen =>
  gen(Prec.Primary, [{k: 'helper', name}]);

// A copy of code: written as text where it is used, its original left where it
// is (or edited away).
export const copyOf = (ir: Ir): Gen => gen(ir.prec, [{k: 'copy', ir}]);

// An expression statement: `E;` on a line of its own.
export const exprStatement = (e: Ir): Gen => gen(Prec.Primary, ['\n', e, ';']);

// Statements in a statement's place (a SyntaxList).
export const statements = (list: Ir[]): Gen =>
  gen(Prec.Primary, joinStatements(list), {t: 'stmts', list});

// A block of statements.
export const block = (list: Ir[]): Gen =>
  gen(Prec.Primary, ['\n{', ...joinStatements(list), '\n}'], {
    t: 'block',
    list,
  });

function joinStatements(list: Ir[]): Part[] {
  return list;
}

export function tokenText(kind: K): string | undefined {
  switch (kind) {
    case K.BarBarToken:
      return '||';
    case K.AmpersandAmpersandToken:
      return '&&';
    case K.QuestionQuestionToken:
      return '??';
  }
  return undefined;
}

// Writes code: names and helpers as `names` gives them.
export interface Names {
  helper(name: string): string;
  temp(temp: Temp): string;
  vars(scope: Scope): string;
}

// The text of code.
export function render(ir: Ir, text: string, names: Names): string {
  if (ir.k === 'src') {
    let out = '',
      at = ir.start;
    for (const e of ir.edits) {
      out += text.slice(at, e.start) + render(e.ir, text, names);
      at = e.end;
    }
    return out + text.slice(at, ir.end);
  }
  let out = '';
  for (const part of ir.parts) out += renderPart(part, text, names);
  return out;
}

function renderPart(part: Part, text: string, names: Names): string {
  if (typeof part === 'string') return part;
  switch (part.k) {
    case 'helper':
      return names.helper(part.name);
    case 'temp':
      return names.temp(part.temp);
    case 'vars':
      return names.vars(part.scope);
    case 'copy':
      return render(part.ir, text, names);
  }
  return render(part, text, names);
}

// The pieces of code in order: generated text, and the original nodes in it.
function flatten(ir: Ir, text: string, names: Names, out: (string | Src)[]) {
  if (ir.k === 'src') {
    out.push(ir);
    return;
  }
  for (const part of ir.parts) {
    if (typeof part === 'string') out.push(part);
    else if (part.k === 'src' || part.k === 'gen')
      flatten(part, text, names, out);
    else out.push(renderPart(part, text, names));
  }
}

// Writes code in place of the original text from start to end.
export function write(
  ms: MagicString,
  ir: Ir,
  start: number,
  end: number,
  text: string,
  names: Names,
): void {
  if (ir.k === 'src' && ir.start === start && ir.end === end) {
    for (const e of ir.edits) write(ms, e.ir, e.start, e.end, text, names);
    return;
  }
  const pieces: (string | Src)[] = [];
  flatten(ir, text, names, pieces);
  // the original nodes kept in place: those inside the range, in order, each
  // once; the others are copied
  const kept: Src[] = [];
  const gaps: {from: number; to: number; text: string}[] = [];
  let cursor = start,
    pending = '';
  const used = new Set<Src>();
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      pending += piece;
      continue;
    }
    if (!used.has(piece) && piece.start >= cursor && piece.end <= end) {
      used.add(piece);
      gaps.push({from: cursor, to: piece.start, text: pending});
      kept.push(piece);
      cursor = piece.end;
      pending = '';
    } else {
      pending += render(piece, text, names);
    }
  }
  gaps.push({from: cursor, to: end, text: pending});
  // what is kept first, so that the text around it goes outside what it
  // writes at its own edges
  for (const piece of kept)
    write(ms, piece, piece.start, piece.end, text, names);
  for (const gap of gaps) {
    if (gap.from === gap.to) {
      if (gap.text === '') continue;
      if (gap.from === start) ms.prependRight(gap.from, gap.text);
      else ms.appendLeft(gap.from, gap.text);
    } else if (text.slice(gap.from, gap.to) !== gap.text) {
      if (gap.text === '') ms.remove(gap.from, gap.to);
      else ms.overwrite(gap.from, gap.to, gap.text);
    }
  }
}
