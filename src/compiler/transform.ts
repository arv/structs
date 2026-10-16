// Lowers the struct declarations of a file to classes that call the runtime
// (src/runtime/structs.ts says what they become, and why). The file is parsed
// as scan.ts spelled it, with its structs as classes; the edits are made to
// the original text, whose positions are the same, so the source map is
// exact.

import MagicString from 'magic-string';
import {SyntaxKind as K} from 'typescript/ast';
import type {Node as TsNode, SourceFile} from 'typescript/ast';
import type {Scan, StructSite} from './scan.ts';

// a node, its kind-specific properties untyped
export type Node = TsNode & {readonly [property: string]: any};

export interface Diagnostic {
  start: number;
  end: number;
  message: string;
}

// what a struct declaration is, for the TypeScript pass (fast.ts)
export interface StructInfo {
  node: Node;
  shared: boolean;
  name: string;
  // the instance fields' keys, the parent's first, when all are known: a
  // computed key makes it undefined
  ownKeys: string[] | undefined;
}

export interface Lowered {
  ms: MagicString;
  diagnostics: Diagnostic[];
  structs: StructInfo[];
  // the name the runtime is imported as, when anything uses it
  runtimeName: string;
}

export function children(node: Node): Node[] {
  const out: Node[] = [];
  node.forEachChild(child => {
    out.push(child as Node);
  });
  return out;
}

export function skipTrivia(text: string, i: number) {
  for (;;) {
    if (/\s/.test(text[i] ?? '')) i++;
    else if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else return i;
  }
}

// A name like `name` that no identifier in `text` is.
export function uniqueName(text: string, name: string) {
  const used = new Set(text.match(/[\p{ID_Start}$_][\p{ID_Continue}$]*/gu));
  let unique = name;
  for (let n = 1; used.has(unique); n++) unique = `${name}_${n}`;
  return unique;
}

const hasModifier = (node: Node, kind: K) =>
  !!node.modifiers?.some((m: Node) => m.kind === kind);

const isStatic = (member: Node) => hasModifier(member, K.StaticKeyword);

// where a class's `class` keyword is
function keywordOf(text: string, node: Node) {
  const mods = node.modifiers;
  const from =
    mods && mods.length ? mods[mods.length - 1].end : node.getStart();
  return skipTrivia(text, from);
}

export function lower(text: string, scanned: Scan, file: SourceFile): Lowered {
  const ms = new MagicString(text);
  const diagnostics: Diagnostic[] = [];
  const structs: StructInfo[] = [];
  const rt = uniqueName(text, '$struct');
  const sites = new Map<number, StructSite>(
    scanned.structs.map(s => [s.keyword, s]),
  );
  const error = (
    node: Node | {start: number; end: number},
    message: string,
  ) => {
    const start = 'getStart' in node ? (node as Node).getStart() : node.start;
    diagnostics.push({start, end: node.end, message});
  };
  // a range replaced, or (empty) inserted into
  const replace = (start: number, end: number, s: string) => {
    if (start === end) ms.appendLeft(start, s);
    else ms.overwrite(start, end, s);
  };

  const visit = (node: Node) => {
    if (node.kind === K.ClassDeclaration) {
      const site = sites.get(keywordOf(scanned.text, node));
      if (site) lowerStruct(node, site);
    }
    node.forEachChild(child => {
      visit(child as Node);
    });
  };

  function lowerStruct(node: Node, site: StructSite) {
    const shared = site.shared !== undefined;
    const what = shared ? 'a shared struct' : 'a struct';
    if (node.modifiers?.some((m: Node) => m.kind === K.Decorator))
      error(node, `${what} cannot have decorators`);
    // `shared struct` / `struct` is `class`, named if it was not
    let name = node.name?.text as string | undefined;
    const anonymous = name === undefined;
    if (anonymous) name = uniqueName(text, '$default');
    if (shared) ms.remove(site.shared!, skipTrivia(text, site.shared! + 6));
    ms.overwrite(
      site.keyword,
      site.keyword + 6,
      anonymous ? `class ${name}` : 'class',
    );

    // the heritage: checked to be a struct
    const ext = node.heritageClauses?.find(
      (h: Node) => h.token === K.ExtendsKeyword,
    );
    if (ext) {
      const expr = children(ext.types[0])[0]!;
      ms.prependRight(
        expr.getStart(),
        `${rt}.${shared ? 'sharedStructHeritage' : 'structHeritage'}(`,
      );
      ms.appendLeft(expr.end, ')');
    } else {
      let at = node.name ? node.name.end : site.keyword + 6;
      if (node.typeParameters)
        at = text.indexOf('>', node.typeParameters.end) + 1;
      ms.appendLeft(
        at,
        shared ? ' extends null' : ` extends ${rt}.structHeritage()`,
      );
    }

    const fields: string[] = [];
    const keys: string[] = [];
    let computed = false,
      init: string | undefined,
      n = 0;
    const members: Node[] = [...node.members];
    const constructors = members.filter(
      m => m.kind === K.Constructor && m.body,
    );
    if (constructors.length > 1)
      error(constructors[1]!, `${what} has more than one constructor`);

    for (const member of members) {
      const start = member.getStart();
      if (member.kind === K.Constructor) {
        if (!member.body) {
          ms.remove(start, member.end); // an overload
          continue;
        }
        for (const p of member.parameters)
          if (p.modifiers?.length)
            error(p, `${what} cannot have parameter properties`);
        if (shared && containsPrivate(member))
          error(
            member,
            'the constructor of a shared struct cannot use private names (§2.2.3)',
          );
        replace(
          start,
          member.parameters.pos - 1,
          shared ? 'static #$init' : '#$init',
        );
        lowerSuperCalls(member.body, name!);
        init = shared ? 'this.#$init' : '(o, a) => o.#$init(...a)';
        continue;
      }
      if (isStatic(member)) continue;
      switch (member.kind) {
        case K.PropertyDeclaration: {
          if (hasModifier(member, K.DeclareKeyword)) continue;
          if (hasModifier(member, K.AccessorKeyword)) {
            error(member, `${what} cannot have auto-accessors`);
            continue;
          }
          const nameNode = member.name as Node;
          const initializer = member.initializer as Node | undefined;
          const f = `#$f${n}`;
          if (nameNode.kind === K.PrivateIdentifier) {
            if (shared) {
              error(
                member,
                'a shared struct cannot have private fields (§2.2.3)',
              );
              continue;
            }
            if (!initializer) continue; // stamped by the class
            const priv = nameNode.text as string;
            replace(
              start,
              initializer.getStart(),
              `${priv}; ${f}() { return (`,
            );
            replace(initializer.end, member.end, '); }');
            fields.push(`{set: o => { o.${priv} = o.${f}(); }}`);
            n++;
            continue;
          }
          if (shared && initializer && containsPrivate(initializer))
            error(
              initializer,
              'a shared struct field initializer cannot use private names (§2.2.3)',
            );
          let key: string;
          if (nameNode.kind === K.ComputedPropertyName) {
            const expr = children(nameNode)[0]!;
            key = `${rt}.toKey(${text.slice(expr.getStart(), expr.end)})`;
            computed = true;
          } else {
            const k = propertyKey(nameNode);
            key = JSON.stringify(k);
            keys.push(k);
          }
          if (!initializer) {
            ms.remove(start, member.end);
            fields.push(`{key: ${key}}`);
            continue;
          }
          replace(
            start,
            initializer.getStart(),
            `${shared ? 'static ' : ''}${f}() { return (`,
          );
          replace(initializer.end, member.end, '); }');
          fields.push(
            `{key: ${key}, init: ${shared ? `this.${f}` : `o => o.${f}()`}}`,
          );
          n++;
          continue;
        }
        case K.MethodDeclaration:
        case K.GetAccessor:
        case K.SetAccessor:
          if (shared)
            error(
              member,
              'a shared struct cannot have instance methods or accessors (§2.2.3)',
            );
          continue;
      }
    }

    const spec = [`fields: [${fields.join(', ')}]`];
    if (init) spec.push(`init: ${init}`);
    if (!shared) spec.push('brand: o => #$brand in o');
    if (anonymous) spec.push('name: "default"');
    const define = shared ? 'defineSharedStruct' : 'defineStruct';
    const open = node.members.pos;
    ms.appendLeft(
      open,
      ` static { ${rt}.${define}(this, {${spec.join(', ')}}); }${shared ? '' : ' #$brand;'}`,
    );
    const close = node.end - 1;
    ms.appendLeft(
      close,
      shared
        ? ` constructor(...a) { return ${rt}.constructSharedStruct(new.target, ${name}, a); } static { ${rt}.sealSharedStruct(this); } `
        : ` constructor(...a) { super(${rt}.beginStruct(new.target, ${name})); return ${rt}.endStruct(this, ${name}, new.target, a); } static { ${rt}.sealStruct(this); } `,
    );
    structs.push({
      node,
      shared,
      name: name!,
      ownKeys: computed ? undefined : keys,
    });
  }

  // super(...args) in an initializer: the parent struct's initializer
  function lowerSuperCalls(body: Node, name: string) {
    const visit = (node: Node) => {
      switch (node.kind) {
        case K.FunctionDeclaration:
        case K.FunctionExpression:
        case K.ClassDeclaration:
        case K.ClassExpression:
        case K.MethodDeclaration:
        case K.GetAccessor:
        case K.SetAccessor:
          return;
        case K.CallExpression:
          if (node.expression.kind === K.SuperKeyword) {
            replace(
              node.getStart(),
              node.arguments.pos,
              `${rt}.superInit(${name}, this, [`,
            );
            replace(node.arguments.end, node.end, '])');
          }
      }
      node.forEachChild(child => {
        visit(child as Node);
      });
    };
    visit(body);
  }

  visit(file as Node);
  return {ms, diagnostics, structs, runtimeName: rt};
}

// the key a field's name is: an identifier's or a literal's text, a number's
// canonical string
export function propertyKey(name: Node): string {
  switch (name.kind) {
    case K.NumericLiteral:
      return String(Number(name.text));
    case K.BigIntLiteral:
      return String(BigInt(String(name.text).replace(/n$/, '')));
    default:
      return name.text;
  }
}

// whether a node mentions a private name (ContainsInstancePrivateIdentifier)
function containsPrivate(node: Node): boolean {
  if (node.kind === K.PrivateIdentifier) return true;
  let found = false;
  node.forEachChild(child => {
    if (!found && containsPrivate(child as Node)) found = true;
  });
  return found;
}
