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
// $v is a scratch variable: nothing runs between its write and its reads.
// A function keeps the heap's views and its scratch variable in locals
// ($I, $F, $v: `const {I32: $I, F64: $F} = $struct.views()` at its start),
// since the heap's size is fixed and its views never change; an async function
// or a generator, which may resume after the heap is attached, and code at the
// top of the module use the runtime's.
//
// Better still, the address need not be looked up. Where such a binding takes
// a struct from the heap, an element of a SharedArray<S> (`arr[i]`) or a field
// that holds an S (`s.f`), arr or s having addresses of their own, its address
// is the word of that slot, which the runtime reads without making the struct's
// Proxy ($struct.elem, $struct.ref). If every use of the binding is a field
// access made direct, the binding itself is made only where that address is
// -1 (the slow path, which reads it as written):
//
//   const b = arr[i];  const $b = $struct.elem($arr, i, $L0),
//                        b = $b < 0 ? arr[i] : undefined;
//
// Such an address is held without a Proxy, and the collector keeps its struct
// only for the rest of the turn (src/runtime/gc.ts): so only in a function
// that is neither async nor a generator, and with no use in its closures.
//
// And a SharedArray's length, which its header holds and never changes, is
// read from there: arr.length is ($arr < 0 ? arr.length : $I[($arr >> 2) + 1]).
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
  // the same, of a type that may be null or undefined too (`Body | null`)
  nullableLayoutOf(expression: Node): Layout | undefined;
  // the layout of the shared struct an expression's SharedArray holds
  elementLayoutOf(expression: Node): Layout | undefined;
  // whether an expression's type is a SharedArray
  isSharedArray(expression: Node): boolean;
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
  // the address of `o`, checked against layout L once (L null: checked to be
  // a Shared Array), if `o` is a binding that keeps its value
  const addressOf = (
    o: Node,
    L: string | null,
    at: Node,
  ): string | undefined => {
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
      const source = L && sourceOf(decl, L, o.text as string);
      if (source) {
        // `const b = arr[i]` becomes `const $a = <its address>, b = $a < 0
        // ? arr[i] : undefined`: b is made only for the slow path
        const init = decl.initializer as Node;
        ms.prependRight(decl.getStart(), `${name} = ${source}, `);
        ms.prependRight(init.getStart(), `${name} < 0 ? `);
        ms.appendLeft(init.end, ' : undefined');
      } else
        site.declare(
          name,
          L ? `${rt}.addr(${o.text}, ${L})` : `${rt}.addrArray(${o.text})`,
        );
    }
    return name;
  };
  // Where a const (or a let never assigned) takes a struct from the heap,
  // `arr[i]` of a SharedArray or `s.f` of a struct, both with addresses of
  // their own, its address is the word of that slot, read without making a
  // Proxy: what declares it, if it can be. Only if every use of the binding
  // is a field access made direct, since the binding itself is then made only
  // where the address is -1.
  const sourceOf = (decl: Node, L: string, name: string) => {
    if (decl.kind !== K.VariableDeclaration) return undefined;
    const fn = scopeOf(decl);
    if (
      fn.kind === K.SourceFile ||
      (fn.body as Node | undefined)?.kind !== K.Block ||
      fn.asteriskToken ||
      hasModifier(fn, K.AsyncKeyword)
    )
      return undefined;
    let init = decl.initializer as Node | undefined;
    if (!init || !onlyFieldUses(decl, name, L)) return undefined;
    // through what only TypeScript sees: `arr[i]!`, `(s.f as S)`
    while (
      init.kind === K.NonNullExpression ||
      init.kind === K.ParenthesizedExpression ||
      init.kind === K.AsExpression ||
      init.kind === K.SatisfiesExpression
    )
      init = init.expression as Node;
    if (init.kind === K.ElementAccessExpression) {
      const arr = init.expression as Node,
        index = init.argumentExpression as Node;
      // the index is evaluated twice
      if (index.kind !== K.Identifier && index.kind !== K.NumericLiteral)
        return undefined;
      const element = ctx.elementLayoutOf(arr);
      if (!element || layoutName(element.keys) !== L) return undefined;
      const a = addressOf(arr, null, decl);
      // the function's views() begins the turn the address is kept for
      if (a) viewsAt(decl);
      return a && `${rt}.elem(${a}, ${index.text}, ${L})`;
    }
    if (init.kind === K.PropertyAccessExpression) {
      const f = field(init),
        holder = init.expression as Node;
      const held = ctx.nullableLayoutOf(init);
      if (!f || !held || layoutName(held.keys) !== L) return undefined;
      const a = addressOf(holder, f.L, decl);
      if (a) viewsAt(decl);
      return a && `${rt}.ref(${a}, ${f.i}, ${L})`;
    }
    return undefined;
  };
  // whether every use of `name` in its scope is `name.key` made direct, of
  // layout L, and none is in a function or class inside it
  const onlyFieldUses = (decl: Node, name: string, L: string) => {
    let only = true;
    let inner = 0;
    const visit = (node: Node) => {
      if (!only) return;
      if (isFunctionLike(node) || isClass(node)) {
        inner++;
        node.forEachChild(child => visit(child as Node));
        inner--;
        return;
      }
      if (
        node.kind === K.Identifier &&
        node.text === name &&
        // a declaration's name: this one, or another binding of the name
        !(
          (node.parent as Node | undefined)?.name &&
          same(node, (node.parent as Node).name) &&
          (node.parent.kind === K.VariableDeclaration ||
            node.parent.kind === K.Parameter ||
            node.parent.kind === K.BindingElement)
        )
      ) {
        const parent = node.parent as Node;
        const f =
          parent?.kind === K.PropertyAccessExpression &&
          same(node, parent.expression)
            ? field(parent)
            : undefined;
        if (!f || f.L !== L || !direct(parent) || inner > 0) only = false;
      } else node.forEachChild(child => visit(child as Node));
    };
    visit(blockOf(decl));
    return only;
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
  // The views of the heap and the scratch variable an access uses: in a
  // function, its locals, read once at its start (the heap's views never
  // change); elsewhere (at the top of the module, in an async function or a
  // generator, which may run before the heap is attached and resume after),
  // the runtime's
  const hoisted = new Set<number>();
  const viewsAt = (node: Node) => {
    const fn = scopeOf(node);
    const body = fn.body as Node | undefined;
    if (
      fn.kind === K.SourceFile ||
      body?.kind !== K.Block ||
      fn.asteriskToken ||
      hasModifier(fn, K.AsyncKeyword)
    ) {
      return {I: `${rt}.I32`, F: `${rt}.F64`, v: scratch, local: false};
    }
    const names = {I: `$I_${rt}`, F: `$F_${rt}`, v: scratch, local: true};
    if (!hoisted.has(fn.pos)) {
      hoisted.add(fn.pos);
      ms.appendLeft(
        bodyStart(body),
        ` const {I32: ${names.I}, F64: ${names.F}} = ${rt}.views(); let ${scratch};`,
      );
    }
    return names;
  };
  // slot i's word in I32, and its Float64 in F64, from the address `a`
  const word = (I: string, a: string, i: number) =>
    `${I}[(${a} >> 2) + ${(HEAD + i * SLOT) / 4}]`;
  const float = (F: string, a: string, i: number) =>
    `${F}[(${a} >> 3) + ${(HEAD + i * SLOT) / 8 + 1}]`;
  // whether `o.key` is read or written directly: read but not called, or
  // the target of `=`
  const direct = (node: Node) => {
    const parent = node.parent as Node | undefined;
    if (
      parent?.kind === K.BinaryExpression &&
      parent.operatorToken.kind === K.EqualsToken &&
      same(node, parent.left)
    )
      return true;
    if (isAssignmentTarget(node)) return false;
    return !(
      (parent?.kind === K.CallExpression && same(node, parent.expression)) ||
      (parent?.kind === K.TaggedTemplateExpression && same(node, parent.tag))
    );
  };
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
      const v = viewsAt(node);
      if (!v.local) usesScratch = true;
      ms.overwrite(
        target.getStart(),
        value.getStart(),
        `${guard(node)}(${scratch} = `,
        {contentOnly: true},
      );
      ms.appendLeft(
        value.end,
        `, ${a} < 0 || typeof ${scratch} !== 'number' || ${word(v.I, a, f.i)} !== ${W_NUMBER} ? ${setAt}, ${scratch}) : ${float(v.F, a, f.i)} = ${scratch})`,
      );
      return;
    }
    if (node.kind !== K.PropertyAccessExpression) return;
    // a SharedArray's length, which its header holds and never changes
    if (
      node.name.kind === K.Identifier &&
      node.name.text === 'length' &&
      direct(node) &&
      !isAssignmentTarget(node) &&
      ctx.isSharedArray(node.expression)
    ) {
      const o = node.expression as Node;
      const a = addressOf(o, null, node);
      if (a) {
        const v = viewsAt(node);
        ms.overwrite(
          node.getStart(),
          node.end,
          `${guard(node)}(${a} < 0 ? ${o.text}.length : ${v.I}[(${a} >> 2) + 1])`,
          {contentOnly: true},
        );
      }
      return;
    }
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
    const v = viewsAt(node);
    ms.overwrite(
      node.getStart(),
      node.end,
      numeric
        ? `${guard(node)}(${a} < 0 || ${word(v.I, a, f.i)} !== ${W_NUMBER} ? ${rt}.getNumberAt(${args}) : ${float(v.F, a, f.i)})`
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
    const at = bodyStart(body);
    return {
      pos: body.pos,
      end: body.end,
      declare: (n, init) => ms.appendLeft(at, ` const ${n} = ${init};`),
    };
  }
  return null;
}

// where a function's body begins: after its directives
function bodyStart(body: Node) {
  const directives = (body.statements as Node[]).filter(
    (st, i, all) =>
      st.kind === K.ExpressionStatement &&
      st.expression.kind === K.StringLiteral &&
      all.slice(0, i).every(p => p.kind === K.ExpressionStatement),
  );
  return directives.length
    ? directives[directives.length - 1]!.end
    : body.getStart() + 1;
}

const hasModifier = (node: Node, kind: K) =>
  !!node.modifiers?.some((m: Node) => m.kind === kind);

// the block a let or const declaration is in, which is its scope (a for
// statement's, for one in its head)
function blockOf(decl: Node): Node {
  const statement = (decl.parent as Node).parent as Node;
  return statement.kind === K.VariableStatement
    ? (statement.parent as Node)
    : statement;
}

const isFunctionLike = (n: Node) =>
  n.kind === K.FunctionDeclaration ||
  n.kind === K.FunctionExpression ||
  n.kind === K.ArrowFunction ||
  n.kind === K.MethodDeclaration ||
  n.kind === K.GetAccessor ||
  n.kind === K.SetAccessor ||
  n.kind === K.Constructor;

const isClass = (n: Node) =>
  n.kind === K.ClassDeclaration || n.kind === K.ClassExpression;

// the function, or the module, a declaration is in
function scopeOf(node: Node): Node {
  let n = node;
  while (n.parent && n.kind !== K.SourceFile && !isFunctionLike(n))
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
