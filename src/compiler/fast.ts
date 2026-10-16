// Field access on shared structs, made direct where TypeScript proves the
// object's type: the runtime is erased from the access, but for a check.
//
// `o.x` on a Shared Struct is a Proxy's get trap: a call, a lookup of the key,
// a read of the slot. Where the checker says `o` is an instance of a shared
// struct S whose fields are all known (no computed keys, its parents too), `x`
// is S's field number i, and the access is a call that reads slot i:
//
//   o.x        $struct.get(o, $L0, i)           (getNumber, for a number field)
//   o.x = v    $struct.set(o, $L0, i, v)
//
// where $L0 is S's layout, its field keys: `const $L0 = $struct.layout([...])`
// at the top of the module. The types are not trusted to be true: the runtime
// checks that `o` is a Shared Struct of that layout, and reads it through its
// Proxy otherwise, as the code was written (src/runtime/emit.ts). So a
// subclass instance, or any object TypeScript lets through structurally, is
// still read correctly.
//
// That check is a lookup of `o`'s address, and costs more than the read. Where
// `o` is a binding that keeps its value (a const or a let never assigned, or a
// parameter never assigned, of a function), the check is made once, beside the
// binding: `$a0 = $struct.addr(o, $L0)`, the address, or -1 for an object
// that is not a Shared Struct of the layout. The accesses then use it: a
// number field's slot is read and written in the heap's views, inline, and
// any other value (a field that holds no Number, an object that is not the
// struct, a value written that is not a Number) goes through the runtime
// (getAt, getNumberAt, setAt), which reads `o` as written when $a0 is -1:
//
//   const a = f(), $a0 = $struct.addr(a, $L0);
//   a.x        ($a0 < 0 || $struct.I32[($a0 >> 2) + w] !== 1
//                ? $struct.getNumberAt(a, $a0, $L0, i)
//                : $struct.F64[($a0 >> 3) + n])
//   a.x = v    ($v = v, $a0 < 0 || typeof $v !== 'number' || ... !== 1
//                ? $struct.setAt(a, $a0, $L0, i, $v)
//                : $struct.F64[($a0 >> 3) + n] = $v)
//
// where w and n index slot i's word and Float64 (src/runtime/shared.ts), and
// $v is the module's scratch variable: nothing runs between its write and its
// reads.
//
// Compound assignments (`o.x += 1`), increments, `delete` and destructuring
// are left as they are.

import type MagicString from 'magic-string';
import {NodeFlags, SyntaxKind as K} from 'typescript/ast';
import {TypeFlags} from 'typescript/sync';
import type {Checker} from 'typescript/sync';
import type {Node} from './transform.ts';

export interface Layout {
  keys: string[];
}

export interface FastContext {
  ms: MagicString;
  checker: Checker;
  rt: string;
  // the layout of the shared struct an expression's type is an instance of
  layoutOf(expression: Node): Layout | undefined;
  // the names of the layouts this module uses, by their keys (JSON)
  layouts: Map<string, string>;
  // the field names any shared struct has: a cheap test before the checker
  fieldNames: Set<string>;
}

const same = (a: Node, b: Node | undefined) =>
  !!b && a.kind === b.kind && a.pos === b.pos && a.end === b.end;

// A Shared Struct's slots (src/runtime/shared.ts): a header of 16 bytes, then
// 16 bytes a field, its word (W_NUMBER for a Number) then its Float64
const HEAD = 16,
  SLOT = 16,
  W_NUMBER = 1;

// Where a binding's checked address goes: beside it, or the first statement
// of the block its accesses are in
interface Site {
  // inserts the declaration of `name`, `$struct.addr(id, layout)`
  declare(name: string, init: string): void;
  // the range its accesses must be in
  pos: number;
  end: number;
}

// Rewrites the module's field accesses; returns what it needs declared at the
// top of the module.
export function fastAccess(file: Node, ctx: FastContext): string {
  const {ms, checker, rt} = ctx;
  const scratch = `$v_${rt}`;
  let usesScratch = false;
  // the addresses declared, by the binding and the layout
  const addresses = new Map<string, string>();
  const sites = new Map<string, Site | null>();
  // the address of `o`, checked against layout L once, if `o` is a binding
  // that keeps its value
  const addressOf = (o: Node, L: string, at: Node) => {
    if (o.kind !== K.Identifier) return undefined;
    const decl = checker
      .getSymbolAtLocation(o as any)
      ?.declarations?.[0]?.resolve() as Node | undefined;
    if (!decl || decl.getSourceFile().fileName !== file.fileName)
      return undefined;
    const key = `${decl.pos}`;
    if (!sites.has(key)) sites.set(key, siteOf(decl, ms));
    const site = sites.get(key);
    if (!site || at.pos < site.pos || at.end > site.end) return undefined;
    let name = addresses.get(`${key}:${L}`);
    if (!name) {
      name = `$a${addresses.size}_${rt}`;
      addresses.set(`${key}:${L}`, name);
      site.declare(name, `${rt}.addr(${o.text}, ${L})`);
    }
    return name;
  };
  const layoutName = (keys: string[]) => {
    const json = JSON.stringify(keys);
    let name = ctx.layouts.get(json);
    if (!name) ctx.layouts.set(json, (name = `$L${ctx.layouts.size}_${rt}`));
    return name;
  };
  // the layout and field number of `o.key`, if it can be made direct
  const field = (node: Node) => {
    if (node.kind !== K.PropertyAccessExpression) return undefined;
    if (node.questionDotToken || node.name.kind !== K.Identifier)
      return undefined;
    const key = node.name.text as string;
    if (!ctx.fieldNames.has(key)) return undefined;
    const layout = ctx.layoutOf(node.expression);
    const i = layout ? layout.keys.indexOf(key) : -1;
    return i < 0 ? undefined : {L: layoutName(layout!.keys), i};
  };
  const isNumber = (node: Node) => {
    const prop = checker.getSymbolAtLocation(node.name);
    const type = prop && checker.getTypeOfSymbol(prop);
    return (
      !!type && !!(type.flags & (TypeFlags.Number | TypeFlags.NumberLiteral))
    );
  };
  // slot i's word in I32, and its Float64 in F64, from the address `a`
  const word = (a: string, i: number) =>
    `${rt}.I32[(${a} >> 2) + ${(HEAD + i * SLOT) / 4}]`;
  const float = (a: string, i: number) =>
    `${rt}.F64[(${a} >> 3) + ${(HEAD + i * SLOT) / 8 + 1}]`;
  // after the children: what they write stays inside what this writes
  const visit = (node: Node) => {
    // a computed key is copied as it was written (transform.ts)
    if (node.kind === K.ComputedPropertyName) return;
    node.forEachChild(child => {
      visit(child as Node);
    });
    if (
      node.kind === K.BinaryExpression &&
      node.operatorToken.kind === K.EqualsToken
    ) {
      // o.key = v
      const target = node.left as Node,
        value = node.right as Node;
      const f = field(target);
      if (!f) return;
      const o = target.expression as Node;
      const a = addressOf(o, f.L, node);
      if (!a) {
        ms.prependRight(target.getStart(), `${rt}.set(`);
        ms.overwrite(o.end, value.getStart(), `, ${f.L}, ${f.i}, `, {
          contentOnly: true,
        });
        ms.appendLeft(value.end, ')');
        return;
      }
      const setAt = `${rt}.setAt(${o.text}, ${a}, ${f.L}, ${f.i}`;
      if (!isNumber(target)) {
        ms.overwrite(target.getStart(), value.getStart(), `${setAt}, `, {
          contentOnly: true,
        });
        ms.appendLeft(value.end, ')');
        return;
      }
      usesScratch = true;
      ms.overwrite(
        target.getStart(),
        value.getStart(),
        `${guard(node)}(${scratch} = `,
        {contentOnly: true},
      );
      ms.appendLeft(
        value.end,
        `, ${a} < 0 || typeof ${scratch} !== 'number' || ${word(a, f.i)} !== ${W_NUMBER} ? ${setAt}, ${scratch}) : ${float(a, f.i)} = ${scratch})`,
      );
      return;
    }
    if (node.kind !== K.PropertyAccessExpression) return;
    const parent = node.parent as Node | undefined;
    // a write, or a method call, is left as it is
    if (isAssignmentTarget(node)) return;
    if (
      (parent?.kind === K.CallExpression && same(node, parent.expression)) ||
      (parent?.kind === K.TaggedTemplateExpression && same(node, parent.tag))
    )
      return;
    const f = field(node);
    if (!f) return;
    const numeric = isNumber(node);
    const o = node.expression as Node;
    const a = addressOf(o, f.L, node);
    if (!a) {
      ms.prependRight(
        node.getStart(),
        `${rt}.${numeric ? 'getNumber' : 'get'}(`,
      );
      ms.overwrite(o.end, node.end, `, ${f.L}, ${f.i})`, {
        contentOnly: true,
      });
      return;
    }
    const args = `${o.text}, ${a}, ${f.L}, ${f.i}`;
    ms.overwrite(
      node.getStart(),
      node.end,
      numeric
        ? `${guard(node)}(${a} < 0 || ${word(a, f.i)} !== ${W_NUMBER} ? ${rt}.getNumberAt(${args}) : ${float(a, f.i)})`
        : `${rt}.getAt(${args})`,
      {contentOnly: true},
    );
  };
  visit(file);
  return usesScratch ? `let ${scratch}; ` : '';
}

// The site of the checked address of the binding `decl`, if it keeps its
// value: a const or a let that is never assigned, in a declaration list, or a
// parameter never assigned, of a function with a body
function siteOf(decl: Node, ms: MagicString): Site | null {
  if (decl.name?.kind !== K.Identifier) return null;
  const name = decl.name.text as string;
  if (decl.kind === K.VariableDeclaration) {
    const list = decl.parent as Node;
    const flags =
      list.flags & (NodeFlags.Let | NodeFlags.Const | NodeFlags.Using);
    if (flags !== NodeFlags.Const && flags !== NodeFlags.Let) return null;
    const holder = list.parent as Node;
    if (flags === NodeFlags.Let && assigned(scopeOf(holder), name)) return null;
    if (holder.kind === K.ForOfStatement || holder.kind === K.ForInStatement) {
      // for (const o of xs) { ... }: the first statement of the body
      const body = holder.statement as Node;
      if (body.kind !== K.Block) return null;
      return {
        pos: body.pos,
        end: body.end,
        declare: (n, init) =>
          ms.appendLeft(body.getStart() + 1, ` const ${n} = ${init};`),
      };
    }
    // `export const o = ..., $a0 = ...` would export it too
    if (
      holder.kind === K.VariableStatement &&
      holder.modifiers?.some((m: Node) => m.kind === K.ExportKeyword)
    )
      return null;
    if (!decl.initializer) return null;
    // const o = ..., $a0 = $struct.addr(o, $L0), the rest
    const scope = scopeOf(holder);
    return {
      pos: scope.pos,
      end: scope.end,
      declare: (n, init) => ms.appendLeft(decl.end, `, ${n} = ${init}`),
    };
  }
  if (decl.kind === K.Parameter) {
    if (decl.dotDotDotToken) return null;
    const fn = decl.parent as Node;
    const body = fn.body as Node | undefined;
    if (fn.kind === K.Constructor || body?.kind !== K.Block) return null;
    if (assigned(fn, name)) return null;
    // after the body's directives
    const directives = (body.statements as Node[]).filter(
      (st, i, all) =>
        st.kind === K.ExpressionStatement &&
        st.expression.kind === K.StringLiteral &&
        all.slice(0, i).every(p => p.kind === K.ExpressionStatement),
    );
    const at = directives.length
      ? directives[directives.length - 1]!.end
      : body.getStart() + 1;
    return {
      pos: body.pos,
      end: body.end,
      declare: (n, init) => ms.appendLeft(at, ` const ${n} = ${init};`),
    };
  }
  return null;
}

// the function, or the module, a declaration is in
function scopeOf(node: Node): Node {
  let n = node;
  while (
    n.parent &&
    n.kind !== K.SourceFile &&
    !(
      n.kind === K.FunctionDeclaration ||
      n.kind === K.FunctionExpression ||
      n.kind === K.ArrowFunction ||
      n.kind === K.MethodDeclaration ||
      n.kind === K.GetAccessor ||
      n.kind === K.SetAccessor ||
      n.kind === K.Constructor
    )
  )
    n = n.parent as Node;
  return n;
}

// whether `name` is assigned anywhere in `scope` (any binding of the name:
// a shadowing one too, to be safe)
function assigned(scope: Node, name: string): boolean {
  let found = false;
  const visit = (node: Node) => {
    if (found) return;
    if (
      node.kind === K.Identifier &&
      node.text === name &&
      isAssignmentTarget(node)
    )
      found = true;
    else node.forEachChild(child => visit(child as Node));
  };
  visit(scope);
  return found;
}

// `;` before an access that begins a statement, as `(` would continue the
// statement before it where there is no semicolon
function guard(node: Node): string {
  let n = node;
  for (
    let p = n.parent as Node | undefined;
    p && p.getStart() === node.getStart();
    n = p, p = p.parent
  )
    if (p.kind === K.ExpressionStatement) {
      const block = p.parent as Node;
      if (
        block.kind !== K.Block &&
        block.kind !== K.SourceFile &&
        block.kind !== K.ModuleBlock &&
        block.kind !== K.CaseClause &&
        block.kind !== K.DefaultClause
      )
        return '';
      // after a semicolon, or first in its block, it needs none
      const before = (node.getSourceFile().text as string)
        .slice(0, node.getStart())
        .trimEnd();
      return before === '' || before.endsWith(';') || before.endsWith('{')
        ? ''
        : ';';
    }
  return '';
}

// whether a node is written to: the target of an assignment or a
// destructuring, or an operand of ++, -- or delete
function isAssignmentTarget(node: Node): boolean {
  for (
    let n = node, p = node.parent as Node | undefined;
    p;
    n = p, p = p.parent
  ) {
    switch (p.kind) {
      case K.PrefixUnaryExpression:
      case K.PostfixUnaryExpression:
        return (
          p.operator === K.PlusPlusToken || p.operator === K.MinusMinusToken
        );
      case K.DeleteExpression:
        return true;
      case K.BinaryExpression:
        return (
          same(n, p.left) &&
          p.operatorToken.kind >= K.FirstAssignment &&
          p.operatorToken.kind <= K.LastAssignment
        );
      case K.ForInStatement:
      case K.ForOfStatement:
        return same(n, p.initializer);
      case K.ParenthesizedExpression:
      case K.ArrayLiteralExpression:
      case K.SpreadElement:
      case K.ShorthandPropertyAssignment:
      case K.PropertyAssignment:
      case K.ObjectLiteralExpression:
        continue;
      default:
        return false;
    }
  }
  return false;
}
