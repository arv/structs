// The built site: every page of the sidebar is built, and every link leads
// somewhere, to a page and an anchor on it, a file of the site's, or a file of
// the repository on GitHub. With a path prefix, every absolute link has it
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import Eleventy, {type Page} from '@11ty/eleventy';
import {afterAll, beforeAll, expect, it} from 'vite-plus/test';
import {pages} from './lib/nav.ts';

const site = fileURLToPath(new URL('.', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const github =
  /^https:\/\/github\.com\/arv\/structs\/(?:blob|tree)\/main\/(.+)$/;

// Eleventy reads its configuration and the pages relative to the site
const cwd = process.cwd();
beforeAll(() => process.chdir(site));
afterAll(() => process.chdir(cwd));

async function build(base?: string): Promise<(Page & {url: string})[]> {
  const saved = process.env.BASE;
  if (base === undefined) delete process.env.BASE;
  else process.env.BASE = base;
  try {
    const built = await new Eleventy('src', 'dist', {
      configPath: 'eleventy.config.ts',
      quietMode: true,
    }).toJSON();
    return built.filter((page): page is Page & {url: string} =>
      Boolean(page.url),
    );
  } finally {
    if (saved === undefined) delete process.env.BASE;
    else process.env.BASE = saved;
  }
}

const attributes = (html: string, name: 'href' | 'src' | 'id') =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map(([, value]) =>
    value.replaceAll('&amp;', '&'),
  );

it('builds every page of the sidebar, and no other docs page', async () => {
  const built = await build();
  const docs = built.filter(page => page.inputPath.endsWith('.md'));
  expect(docs.map(page => page.url).sort()).toEqual(
    pages.map(page => page.url).sort(),
  );
});

it('links only to what is there', async () => {
  const built = await build();
  const ids = new Map(
    built.map(page => [page.url, new Set(attributes(page.content, 'id'))]),
  );
  // what the site serves besides its pages: the playground beside it, and the
  // files it writes or copies
  const served = (path: string) =>
    path === '/playground/' ||
    path === '/search-index.json' ||
    (path.startsWith('/assets/') && existsSync(`${site}src${path}`));

  const broken: string[] = [];
  for (const page of built) {
    for (const link of [
      ...attributes(page.content, 'href'),
      ...attributes(page.content, 'src'),
    ]) {
      const fail = () => broken.push(`${page.url}: ${link}`);
      if (link.startsWith('#') || link.startsWith('/')) {
        const [path, hash] = link.startsWith('#')
          ? [page.url, link.slice(1)]
          : (link.split('#') as [string, string | undefined]);
        if (ids.has(path)) {
          if (hash && !ids.get(path)!.has(decodeURIComponent(hash))) fail();
        } else if (!served(path) || hash) fail();
      } else if (github.test(link)) {
        if (!existsSync(repository + github.exec(link)![1])) fail();
      } else if (!link.startsWith('https://')) fail();
    }
  }
  expect(broken).toEqual([]);
});

it('puts the path prefix in front of every absolute link', async () => {
  const built = await build('/threads/');
  const unprefixed = built.flatMap(page =>
    [...attributes(page.content, 'href'), ...attributes(page.content, 'src')]
      .filter(link => link.startsWith('/') && !link.startsWith('/threads/'))
      .map(link => `${page.url}: ${link}`),
  );
  expect(unprefixed).toEqual([]);
  expect(
    attributes(built.find(page => page.url === '/')!.content, 'href'),
  ).toContain('/threads/playground/');
});
