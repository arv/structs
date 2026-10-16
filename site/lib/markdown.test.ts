// The Markdown the docs are written in: notes, heading anchors and tables
import {expect, it} from 'vite-plus/test';
import {markdown} from './markdown.ts';

const md = await markdown();

it('heads a note with its title, and nothing more', () => {
  const html = md.render('::: note Disclaimer\n\nWritten with care.\n\n:::\n');
  expect(html).toContain('<div class="note note-note" id="disclaimer">');
  expect(html).toContain(
    '<a class="heading-link" href="#disclaimer"><span>Disclaimer</span></a>',
  );
  expect(html).toContain('<p>Written with care.</p>');
  expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
});

it('heads a note that names no title by its kind', () => {
  expect(md.render('::: warning\n\nCareful.\n\n:::\n')).toContain(
    '<span>Warning</span>',
  );
});

it("gives headings GitHub's ids, linking to themselves", () => {
  expect(md.render('## Compiled, or With the Types Only Erased')).toContain(
    '<h2 id="compiled-or-with-the-types-only-erased"><a class="heading-link" href="#compiled-or-with-the-types-only-erased">',
  );
});

it('lets a table scroll', () => {
  expect(md.render('| a |\n| - |\n| b |\n')).toMatch(
    /^<div class="table-wrapper"><table>/,
  );
});
