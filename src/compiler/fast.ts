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
// Compound assignments (`o.x += 1`), increments, `delete` and destructuring
// are left as they are.

import type MagicString from 'magic-string';
import {SyntaxKind as K} from 'typescript/ast';
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

export function fastAccess(file: Node, ctx: FastContext) {
  const {ms, checker, rt} = ctx;
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
      ms.prependRight(target.getStart(), `${rt}.set(`);
      ms.overwrite(
        target.expression.end,
        value.getStart(),
        `, ${f.L}, ${f.i}, `,
        {
          contentOnly: true,
        },
      );
      ms.appendLeft(value.end, ')');
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
    const prop = checker.getSymbolAtLocation(node.name);
    const type = prop && checker.getTypeOfSymbol(prop);
    const numeric =
      !!type && !!(type.flags & (TypeFlags.Number | TypeFlags.NumberLiteral));
    ms.prependRight(node.getStart(), `${rt}.${numeric ? 'getNumber' : 'get'}(`);
    ms.overwrite(node.expression.end, node.end, `, ${f.L}, ${f.i})`, {
      contentOnly: true,
    });
  };
  visit(file);
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
