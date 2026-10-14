// The browser coordinator (page.ts) as far as it runs before it starts a
// worker: a heap it refuses fails the page with a result, which chrome.ts
// waits for, with no timeout. The page's globals are stand-ins.
import {expect, it} from 'vite-plus/test';

it('a ?heap= that sharedHeap refuses fails the page with a result', async () => {
  const g = globalThis as Record<string, unknown>;
  g.location = {search: '?heap=2048'};
  g.document = {getElementById: () => ({}), title: ''};
  g.window = globalThis;
  try {
    await expect(import('./page.ts')).rejects.toThrow(RangeError);
    expect(window.__escapeResult).toMatchObject({
      ok: false,
      error: expect.stringMatching(/from 2 to 2047, not 2048/),
    });
    expect(document.title).toBe('failed');
  } finally {
    delete g.location;
    delete g.document;
    delete g.window;
    delete g.__escapeResult;
  }
});
