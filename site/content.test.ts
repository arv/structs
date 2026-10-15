// The repository's Markdown (the README, TUTORIAL.md, REFCOUNT.md,
// docs/prototype.md and the playground's README) and these docs say the same
// things: every code block and every table of one is in the other, as it is
// (a table's links may lead elsewhere). The Markdown is what GitHub and npm
// show, and the docs regroup it into pages, so a change to one is a change to
// the other
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect, it} from 'vite-plus/test';

const site = fileURLToPath(new URL('src/', import.meta.url));
const repository = fileURLToPath(new URL('../', import.meta.url));

const markdown = [
  'README.md',
  'TUTORIAL.md',
  'REFCOUNT.md',
  'docs/prototype.md',
  'playground/README.md',
].map(file => readFileSync(repository + file, 'utf8'));

const pages = readdirSync(site, {recursive: true, encoding: 'utf8'})
  .filter(file => file.endsWith('.md'))
  .map(file => readFileSync(site + file, 'utf8'));

const codeBlocks = (text: string) =>
  [...text.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(
    ([, language, code]) => `${language}\n${code}`,
  );

// a table as its rows of cells, without the line under its header, its
// padding, or its links' targets
const tables = (text: string) =>
  [...text.matchAll(/(?:^\|.*\|\n)+/gm)].map(([table]) =>
    table
      .trimEnd()
      .split('\n')
      .filter(row => !/^\|[\s|:-]+\|$/.test(row))
      .map(row =>
        row
          .slice(1, -1)
          .split(/(?<!\\)\|/)
          .map(cell => cell.trim().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
          .join(' | '),
      )
      .join('\n'),
  );

function compare(of: (text: string) => string[]) {
  const inMarkdown = new Set(markdown.flatMap(of));
  const inPages = new Set(pages.flatMap(of));
  return {
    missingFromPages: [...inMarkdown].filter(item => !inPages.has(item)),
    missingFromMarkdown: [...inPages].filter(item => !inMarkdown.has(item)),
  };
}

it('has the same code blocks', () => {
  expect(compare(codeBlocks)).toEqual({
    missingFromPages: [],
    missingFromMarkdown: [],
  });
});

it('has the same tables', () => {
  expect(compare(tables)).toEqual({
    missingFromPages: [],
    missingFromMarkdown: [],
  });
});
