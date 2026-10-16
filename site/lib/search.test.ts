// The search index: a page's text, and each section's
import {expect, it} from 'vite-plus/test';
import {
  contentEnd,
  contentStart,
  searchEntries,
  searchIndex,
} from './search.ts';

const page = (body: string) =>
  `<nav>Menu</nav><h1>The Model</h1>${contentStart}${body}${contentEnd}<aside>On this page</aside>`;

it('splits a page into its sections', () => {
  const html = page(
    [
      '<p>Every value is <code>owned</code> &amp; more.</p>',
      '<h2 id="kinds">Kinds</h2><p>Owned, shared.</p>',
      '<h3 id="cells">Cells</h3><p>In shared memory.</p>',
    ].join(''),
  );
  expect(searchEntries('/model/', html)).toEqual([
    {
      url: '/model/',
      page: 'The Model',
      section: null,
      text: 'Every value is owned & more.',
    },
    {
      url: '/model/#kinds',
      page: 'The Model',
      section: 'Kinds',
      text: 'Owned, shared.',
    },
    {
      url: '/model/#cells',
      page: 'The Model',
      section: 'Cells',
      text: 'In shared memory.',
    },
  ]);
});

it('leaves out what is not the content', () => {
  const [entry] = searchEntries('/model/', page('<p>Text</p>'));
  expect(entry.text).toBe('Text');
  expect(searchEntries('/x/', '<p>No markers</p>')).toEqual([]);
});

it('indexes the pages that have URLs, in order', () => {
  const index = searchIndex([
    {url: '/b/', content: page('<p>B</p>')},
    {url: false, content: page('<p>None</p>')},
    {url: '/a/', content: page('<p>A</p>')},
  ]);
  expect(index.map(entry => entry.url)).toEqual(['/a/', '/b/']);
});
