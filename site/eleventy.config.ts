// The docs site: Eleventy turns the Markdown in src/ into static pages in
// dist/, in the layout of src/_includes/doc.njk. `vp run build` builds it for
// the site's root, and BASE names another path (/threads/ on arv.github.io,
// which the Pages workflow passes); `vp run dev` serves it, rebuilding as you
// edit. The playground is built apart (../playground) and published beside it,
// at /playground/
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {EleventyHtmlBasePlugin} from '@11ty/eleventy';
import type {MarkdownIt} from 'markdown-it';
import {markdown} from './lib/markdown.ts';
import {pager, pages, sections} from './lib/nav.ts';
import {searchIndex} from './lib/search.ts';
import {toc} from './lib/toc.ts';

// the part of Eleventy's configuration API the site uses
type Config = {
  addPlugin(plugin: unknown): void;
  setLibrary(name: 'md', library: MarkdownIt): void;
  addGlobalData(name: string, data: unknown): void;
  addFilter(name: string, filter: (...args: never[]) => unknown): void;
  addPassthroughCopy(paths: Record<string, string>): void;
  on(
    event: 'eleventy.after',
    listener: (event: {
      results: {url: string | false; content: string}[];
      directories: {output: string};
      outputMode: string;
    }) => Promise<void>,
  ): void;
};

export default async function (config: Config) {
  config.setLibrary('md', await markdown());

  // absolute URLs in the pages (/install/) get the site's path in front
  config.addPlugin(EleventyHtmlBasePlugin);

  config.addGlobalData('sections', sections);
  config.addGlobalData('repository', 'https://github.com/arv/threads');
  config.addFilter('pager', pager);
  config.addFilter('toc', toc);
  config.addPassthroughCopy({'src/assets': 'assets'});

  config.on('eleventy.after', async ({results, directories, outputMode}) => {
    if (outputMode !== 'fs') return;
    await writeFile(
      join(directories.output, 'search-index.json'),
      JSON.stringify(
        searchIndex(
          results.filter(result => pages.some(page => page.url === result.url)),
        ),
      ),
    );
  });

  return {
    dir: {input: 'src', output: 'dist', includes: '_includes'},
    // the Markdown is only Markdown: its code may hold what Nunjucks would read
    markdownTemplateEngine: false,
    htmlTemplateEngine: 'njk',
    templateFormats: ['md', 'njk'],
    pathPrefix: process.env.BASE ?? '/',
  };
}
