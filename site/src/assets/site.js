// The docs' few interactive parts, as the Zero docs have them: the theme
// (light, dark or the system's), the phone's menu, search (⌘K), the table of
// contents' current section, and a Copy button on each code block. It's plain
// JavaScript, which the site serves as it is.

import {escape, rank, snippet} from './search-results.js';

// The theme

const media = matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    return localStorage.getItem('theme') ?? 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('light', !dark);
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    const active = button.dataset.themeChoice === theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

for (const button of document.querySelectorAll('[data-theme-choice]'))
  button.addEventListener('click', () => {
    const theme = button.dataset.themeChoice;
    try {
      localStorage.setItem('theme', theme);
    } catch {}
    applyTheme(theme);
  });

media.addEventListener('change', () => applyTheme(storedTheme()));
applyTheme(storedTheme());

// Dialogs: the phone's menu and search close on their close button, a click
// outside them, or Escape

function setUpDialog(dialog) {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  for (const button of dialog.querySelectorAll('[data-close]'))
    button.addEventListener('click', () => dialog.close());
}

const menu = document.querySelector('[data-menu]');
setUpDialog(menu);
document
  .querySelector('[data-open-menu]')
  .addEventListener('click', () => menu.showModal());
// past the phone's width, the sidebar shows the menu instead
matchMedia('(min-width: 768px)').addEventListener('change', event => {
  if (event.matches) menu.close();
});

// Search, over the index the build writes (lib/search.ts). The input keeps the
// focus, and names the result the arrow keys select as its active descendant

const searchDialog = document.querySelector('[data-search]');
const searchInput = searchDialog.querySelector('input');
const resultList = searchDialog.querySelector('.search-results');
const emptyMessage = searchDialog.querySelector('.search-empty');
const indexLink = document.querySelector('link[rel="search-index"]');
// the site's root, which the index's URLs are relative to
const siteRoot = new URL('./', indexLink.href);
let index = null;
let loading = null;
// whether the last load of the index failed
let failed = false;
let results = [];
let selected = 0;

setUpDialog(searchDialog);

// The index loads once, the first time someone searches. A load that fails
// is forgotten, so the next search tries again
function loadIndex() {
  loading ??= fetch(indexLink.href)
    .then(response => {
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json();
    })
    .then(entries => {
      index = entries;
      failed = false;
    })
    .catch(() => {
      loading = null;
      failed = true;
    });
  return loading;
}

function openSearch() {
  if (searchDialog.open) return;
  searchDialog.showModal();
  searchInput.select();
  void loadIndex().then(() => search());
}

document
  .querySelector('[data-open-search]')
  .addEventListener('click', openSearch);

document.addEventListener('keydown', event => {
  if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (searchDialog.open) searchDialog.close();
    else openSearch();
  }
});

searchDialog.addEventListener('close', () => {
  searchInput.value = '';
  render([]);
});

function search() {
  if (!Array.isArray(index)) {
    render([]);
    return;
  }
  const {entries, tokens} = rank(index, searchInput.value);
  render(entries, tokens);
}

const pageIcon =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
const sectionIcon =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>';

function render(entries, tokens = []) {
  results = entries;
  selected = 0;
  resultList.innerHTML = entries
    .map(
      (entry, i) =>
        `<li role="presentation"><a role="option" id="search-result-${i}" href="${escape(new URL(entry.url.slice(1), siteRoot).href)}" aria-selected="${i === 0}">` +
        `<span class="search-result-title">${entry.section ? sectionIcon : pageIcon}` +
        `<span>${entry.section ? `${escape(entry.page)}: ${escape(entry.section)}` : escape(entry.page)}</span></span>` +
        (entry.text
          ? `<p class="search-result-snippet">${snippet(entry.text, tokens)}</p>`
          : '') +
        '</a></li>',
    )
    .join('');
  emptyMessage.textContent = failed
    ? "Search couldn't load. Try again."
    : 'No results found.';
  emptyMessage.hidden = entries.length > 0 || !searchInput.value.trim();
  searchInput.setAttribute('aria-expanded', String(entries.length > 0));
  if (entries.length)
    searchInput.setAttribute('aria-activedescendant', 'search-result-0');
  else searchInput.removeAttribute('aria-activedescendant');
}

function select(i) {
  const links = resultList.querySelectorAll('a');
  if (!links.length) return;
  selected = (i + links.length) % links.length;
  links.forEach((link, j) =>
    link.setAttribute('aria-selected', String(j === selected)),
  );
  links[selected].scrollIntoView({block: 'nearest'});
  searchInput.setAttribute('aria-activedescendant', links[selected].id);
}

searchInput.addEventListener('input', () => {
  void loadIndex().then(() => search());
});

searchInput.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    select(selected + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    select(selected - 1);
  } else if (event.key === 'Enter' && results.length) {
    event.preventDefault();
    resultList.querySelectorAll('a')[selected].click();
  }
});

// a result on this page only scrolls, so the dialog closes too
resultList.addEventListener('click', event => {
  if (event.target.closest('a')) searchDialog.close();
});

// The table of contents marks the section being read

const tocLinks = [...document.querySelectorAll('.toc-links a')];
const tocTargets = tocLinks
  .map(link => ({
    link,
    heading: document.getElementById(decodeURIComponent(link.hash.slice(1))),
  }))
  .filter(target => target.heading);

function markCurrentSection() {
  if (!tocTargets.length) return;
  let current = tocTargets[0];
  const atBottom =
    window.scrollY > 0 &&
    window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 24;
  if (atBottom) current = tocTargets[tocTargets.length - 1];
  else {
    // a heading that a link scrolled to sits at the scroll padding, under the
    // navbar; one a little lower is the section being read
    const offset =
      document.querySelector('.inner-docs-nav').getBoundingClientRect().height +
      24;
    for (const target of tocTargets) {
      if (target.heading.getBoundingClientRect().top > offset) break;
      current = target;
    }
  }
  for (const {link} of tocTargets)
    link.classList.toggle('active', link === current.link);
}

let frame = 0;
function scheduleMark() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(markCurrentSection);
}
addEventListener('scroll', scheduleMark, {passive: true});
addEventListener('resize', scheduleMark);
addEventListener('hashchange', scheduleMark);
markCurrentSection();

// A Copy button on each code block

for (const pre of document.querySelectorAll('.prose pre')) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-button';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(
        pre.querySelector('code')?.innerText ?? pre.innerText,
      );
      button.textContent = 'Copied!';
    } catch {
      button.textContent = 'Failed';
    }
    setTimeout(() => (button.textContent = 'Copy'), 1500);
  });
  pre.append(button);
}
