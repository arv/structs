// The page's search (src/assets/search-results.js): which entries match, and
// the snippet shown for each, with the query's words marked
import {expect, it} from 'vite-plus/test';
import {escape, rank, snippet} from '../src/assets/search-results.js';

it('marks the words in the text, not in the entities that escape it', () => {
  expect(snippet('Sending<T> moves', ['t'])).toBe(
    'Sending&lt;<mark>T</mark>&gt; moves',
  );
  expect(snippet('a < b && c', ['amp', 'lt'])).toBe('a &lt; b &amp;&amp; c');
});

it('escapes the text, and keeps the case of what it marks', () => {
  expect(snippet('<b>Recv</b> and recvOk', ['recv'])).toBe(
    '&lt;b&gt;<mark>Recv</mark>&lt;/b&gt; and <mark>recv</mark>Ok',
  );
  expect(escape(`"'&`)).toBe('&quot;&#39;&amp;');
});

it('shows the text around the first word found', () => {
  const text = `${'a '.repeat(100)}channel ${'b '.repeat(100)}`;
  const shown = snippet(text, ['channel'], 40);
  expect(shown.startsWith('…')).toBe(true);
  expect(shown.endsWith('…')).toBe(true);
  expect(shown).toContain('<mark>channel</mark>');
  expect(snippet('short', [])).toBe('short');
});

const entry = (page: string, section: string | null, text: string) => ({
  url: '/',
  page,
  section,
  text,
});

it('finds entries with every word, titles first', () => {
  const index = [
    entry('Threads', null, 'spawn starts a thread'),
    entry('Go-Style Concurrency', 'Closed Channels', 'use recvOk'),
    entry('Goroutines and Channels', null, 'ch.recvOk() and select'),
  ];
  expect(rank(index, 'recvok').entries.map(e => e.page)).toEqual([
    'Go-Style Concurrency',
    'Goroutines and Channels',
  ]);
  expect(rank(index, 'closed chan').entries).toEqual([index[1]]);
  expect(rank(index, 'spawn select').entries).toEqual([]);
  expect(rank(index, '  ')).toEqual({entries: [], tokens: []});
});
