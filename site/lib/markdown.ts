// The Markdown that Eleventy renders the docs with, doing what the Zero docs'
// MDX does: headings get GitHub's ids and link to themselves, `::: note` and
// `::: warning` blocks are notes, code is highlighted by Shiki in a light and a
// dark theme, and a table scrolls sideways on a narrow screen. It's
// markdown-it 15, which Shiki's plugin is written for, rather than Eleventy's
// own 14

import {fromHighlighter} from '@shikijs/markdown-it/core';
import {slug} from 'github-slugger';
import markdownIt, {type MarkdownIt} from 'markdown-it';
import anchor from 'markdown-it-anchor';
import container from 'markdown-it-container';
import {createHighlighter} from 'shiki';

export const themes = {light: 'github-light', dark: 'github-dark'} as const;

// the languages the docs' code is in; a block with no language is text, and
// one in another language fails the build
export const languages = ['ts', 'js', 'sh'] as const;

// each kind of note, and its heading when the note names none
const notes = {note: 'Note', warning: 'Warning'} as const;

export async function markdown(): Promise<MarkdownIt> {
  const md = markdownIt({html: true});
  md.use(anchor, {
    level: [2, 3, 4],
    slugify: slug,
    tabIndex: false,
    permalink: anchor.permalink.headerLink({class: 'heading-link'}),
  });

  // `::: warning Status: experimental` starts a note headed "Status:
  // experimental"; `:::` ends it
  for (const [type, heading] of Object.entries(notes))
    md.use(container, type, {
      render(tokens, i) {
        const token = tokens[i];
        if (token.nesting === -1) return '</div></div>\n';
        const title = token.info.trim().slice(type.length).trim() || heading;
        const id = slug(title);
        return (
          `<div class="note note-${type}" id="${md.utils.escapeHtml(id)}">` +
          `<p class="note-heading"><a class="heading-link" href="#${md.utils.escapeHtml(id)}">` +
          `<span>${md.utils.escapeHtml(title)}</span></a></p>` +
          '<div class="note-body">\n'
        );
      },
    });

  md.renderer.rules.table_open = () => '<div class="table-wrapper"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  const shiki = await createHighlighter({
    themes: Object.values(themes),
    langs: [...languages],
  });
  md.use(
    fromHighlighter(shiki, {
      themes,
      // each token's colors as --shiki-light and --shiki-dark, which site.css
      // picks between
      defaultColor: false,
    }),
  );
  return md;
}
