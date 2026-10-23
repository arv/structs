# The Docs Site

These are the docs of [@arv/structs](../README.md), as a site, with
[the playground](../playground) beside them at /playground/. GitHub Pages
publishes them from main ([pages.yml](../.github/workflows/pages.yml)), so this
branch's docs go live only once it is main, or when the workflow is run by hand
on it.

The site is static, built by [Eleventy](https://www.11ty.dev) from the Markdown
in [src/](src). It has no framework: a Nunjucks layout, one stylesheet and two
small scripts.

## Working on It

```sh
vp run structs-site#dev     # The docs site, served as you edit it
vp run structs-site#build   # The docs site's static build, into site/dist/
```

`BASE` names the path the site is served from, `/` by default. The Pages
workflow ([pages.yml](../.github/workflows/pages.yml)) builds it for the path
the repository's Pages settings give it: `/structs/` on arv.github.io, or `/` on
a domain of its own. Every absolute link in the pages gets that path in front.

`vp test` checks the site as well:

- **Its links.** Every link leads to a page and an anchor on it, a file of the
  site's, or a file of this repository on GitHub ([site.test.ts](site.test.ts)).
- **Its content.** Every code block and table of the repository's Markdown
  (README.md and the playground's README.md) is in the site, and the other way
  around ([content.test.ts](content.test.ts)). The Markdown is what GitHub and
  npm show, and the site regroups it into pages, so a change to one is a change
  to the other.

## Layout

| Path                          | What It Is                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `src/*.md`, `src/api/*.md`    | The pages, at the URLs their paths give them                                 |
| `lib/nav.ts`                  | The sidebar's sections, and the order of Previous and Next                   |
| `src/_includes/`              | The layout: the navbar, the sidebar, the page and "On this page"             |
| `src/assets/`                 | The stylesheet, the scripts (theme, menu, search, copy buttons) and the icon |
| `lib/markdown.ts`             | The Markdown: heading anchors, notes (`::: note`), Shiki, tables that scroll |
| `lib/toc.ts`, `lib/search.ts` | "On this page", and the search index the build writes (`search-index.json`)  |
| `eleventy.config.ts`          | Eleventy's configuration                                                     |

## The Zero Docs

The site's look and structure follow the
[Zero docs](https://github.com/rocicorp/zero-docs) (Apache License 2.0): the
sidebar in sections, the page with "On this page" beside it, Previous and Next,
notes, the theme toggle and search on ⌘K. None of their code is copied: the site
is written anew on Eleventy, and its stylesheet takes their color tokens and
sizes, as [site.css](src/assets/site.css) says.

## License

Copyright 2026 Erik Arvidsson. Licensed under the
[Apache License 2.0](../LICENSE).
