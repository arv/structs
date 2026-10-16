// "On this page": a page's h2s and h3s, with their text
import {expect, it} from 'vite-plus/test';
import {decode, textOf, toc} from './toc.ts';

it('lists h2s and h3s, and not h4s', () => {
  const html = [
    '<h2 id="before-you-start"><a class="heading-link" href="#before-you-start">Before You Start</a></h2>',
    '<p>Text</p>',
    '<h3 id="the-thread-function"><a href="#the-thread-function">The Thread <code>Function</code></a></h3>',
    '<h4 id="deeper">Deeper</h4>',
  ].join('\n');
  expect(toc(html)).toEqual([
    {level: 2, id: 'before-you-start', text: 'Before You Start'},
    {level: 3, id: 'the-thread-function', text: 'The Thread Function'},
  ]);
});

it('decodes entities in text and ids', () => {
  expect(toc('<h2 id="a&amp;b">Q&amp;A &lt;T&gt; &#39;x&#x27;</h2>')).toEqual([
    {level: 2, id: 'a&b', text: "Q&A <T> 'x'"},
  ]);
  expect(decode('&unknown; &nbsp;')).toBe('&unknown;  ');
});

it('keeps a line of code together, and blocks apart', () => {
  expect(
    textOf(
      '<pre><code><span>new</span><span> Channel</span><span>&#x3C;</span><span>number</span><span>></span></code></pre><p>One</p><p>Two</p>',
    ),
  ).toBe('new Channel<number> One Two');
});
