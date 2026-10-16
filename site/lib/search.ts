// The search index: a page's text, and the text of each of its sections (an h2
// or an h3 to the next one), from the HTML that Eleventy wrote. The page's
// script (assets/site.js) loads it the first time someone searches

import {decode, textOf} from './toc.ts';

export type SearchEntry = {
  // the page's URL, without the site's path prefix, and the section's anchor
  url: string;
  page: string;
  section: string | null;
  text: string;
};

// what the layout puts around a page's content
export const contentStart = '<!-- content -->';
export const contentEnd = '<!-- /content -->';

const sectionHeading = /<h[23] id="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/g;

export function searchEntries(url: string, html: string): SearchEntry[] {
  const start = html.indexOf(contentStart);
  const end = html.indexOf(contentEnd);
  if (start === -1 || end === -1) return [];
  const content = html.slice(start + contentStart.length, end);
  const page = textOf(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '');

  const headings = [...content.matchAll(sectionHeading)];
  const entries: SearchEntry[] = [
    {
      url,
      page,
      section: null,
      text: textOf(content.slice(0, headings[0]?.index ?? content.length)),
    },
  ];
  headings.forEach((match, i) => {
    const next = headings[i + 1]?.index ?? content.length;
    entries.push({
      url: `${url}#${decode(match[1])}`,
      page,
      section: textOf(match[2]),
      text: textOf(content.slice(match.index + match[0].length, next)),
    });
  });
  return entries;
}

export function searchIndex(
  results: {url: string | false; content: string}[],
): SearchEntry[] {
  return results
    .filter((result): result is {url: string; content: string} =>
      Boolean(result.url),
    )
    .sort((a, b) => a.url.localeCompare(b.url))
    .flatMap(result => searchEntries(result.url, result.content));
}
