// The sidebar's pages: each once, in the order Previous and Next follow
import {expect, it} from 'vite-plus/test';
import {pager, pages, sections} from './nav.ts';

it('lists each page once', () => {
  const urls = pages.map(page => page.url);
  expect(new Set(urls).size).toBe(urls.length);
});

it('links the playground, which is no page of the docs', () => {
  const links = sections.flatMap(section => section.items);
  expect(links.find(link => link.app)?.url).toBe('/playground/');
  expect(pages.some(page => page.url === '/playground/')).toBe(false);
});

it('pages through the sections in order', () => {
  expect(pager('/')).toEqual({prev: null, next: pages[1]});
  expect(pager('/tutorial/').prev?.url).toBe('/setup/');
  expect(pager('/tutorial/').next?.url).toBe('/model/');
  expect(pager('/repository/').next).toBeNull();
  // across sections, past the playground's link
  expect(pager('/prototypes/').next?.url).toBe('/the-playground/');
  expect(pager('/the-playground/').next?.url).toBe('/repository/');
});

it('has nothing before or after a page not in the sidebar', () => {
  expect(pager('/404.html')).toEqual({prev: null, next: null});
});
