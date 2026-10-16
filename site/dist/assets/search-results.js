// Search over the index the build writes (lib/search.ts): which entries match
// a query, best first, and the part of each entry's text to show, with the
// query's words marked. site.js shows them; lib/search-results.test.ts tests
// them.

/** @typedef {import('../../lib/search.ts').SearchEntry} Entry */

// a text's words, lowercased: letters, digits, _ and $
/** @type {(text: string) => string[]} */
export const words = text =>
  text.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? [];

// how well an entry matches: every word of the query starts a word of the
// entry, and a match in a title counts most. 0 is no match
/** @type {(entry: Entry, tokens: string[], phrase: string) => number} */
export function score(entry, tokens, phrase) {
  const page = entry.page.toLowerCase();
  const section = (entry.section ?? '').toLowerCase();
  const text = entry.text.toLowerCase();
  const titleWords = words(`${page} ${section}`);
  const textWords = words(text);
  let total = 0;
  for (const token of tokens) {
    const inTitle = titleWords.some(word => word.startsWith(token));
    const inText = textWords.some(word => word.startsWith(token));
    if (!inTitle && !inText) return 0;
    if (inTitle) total += entry.section ? 16 : 10;
    if (inText) total += 1;
  }
  if (section.includes(phrase)) total += 18;
  if (page.includes(phrase)) total += 12;
  if (text.includes(phrase)) total += 4;
  return total;
}

// the entries that match a query, best first, and the query's words
/**
 * @type {(index: Entry[], query: string, limit?: number) =>
 *   {entries: Entry[], tokens: string[]}}
 */
export function rank(index, query, limit = 20) {
  const phrase = query.trim().toLowerCase();
  const tokens = words(phrase);
  if (!tokens.length) return {entries: [], tokens};
  const entries = index
    .map(entry => ({entry, score: score(entry, tokens, phrase)}))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(result => result.entry);
  return {entries, tokens};
}

/** @type {Record<string, string>} */
const entities = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** @type {(text: string) => string} */
export const escape = text => text.replace(/[&<>"']/g, c => entities[c]);

/** @type {(text: string) => string} */
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// up to `length` characters of the text around the first of the tokens, as
// HTML, each token marked. The text is split at the tokens before it's
// escaped, so a mark never lands inside an entity
/** @type {(text: string, tokens: string[], length?: number) => string} */
export function snippet(text, tokens, length = 120) {
  const lower = text.toLowerCase();
  const found = tokens.map(token => lower.indexOf(token)).filter(i => i !== -1);
  // the first word found sits mid-snippet
  const start = found.length
    ? Math.max(Math.min(...found) - Math.floor(length / 2), 0)
    : 0;
  const part = text.slice(start, start + length);
  const pieces = tokens.length
    ? part.split(new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi'))
    : [part];
  // split puts what the pattern matched at the odd indexes
  const marked = pieces
    .map((piece, i) =>
      i % 2 ? `<mark>${escape(piece)}</mark>` : escape(piece),
    )
    .join('');
  return `${start > 0 ? '…' : ''}${marked}${start + length < text.length ? '…' : ''}`;
}
