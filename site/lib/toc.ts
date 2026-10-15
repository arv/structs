// The "On this page" list: a page's h2s and h3s, read from its HTML, where
// markdown-it-anchor has given each heading its id

export type TocEntry = {level: 2 | 3; id: string; text: string};

const heading = /<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;

export function toc(html: string): TocEntry[] {
  return [...html.matchAll(heading)].map(([, level, id, inner]) => ({
    level: level === '2' ? 2 : 3,
    id: decode(id),
    text: textOf(inner),
  }));
}

// a tag that ends a block of text, rather than marking up a word in a line
const blockTag =
  /<\/?(?:p|li|ul|ol|dl|dt|dd|table|thead|tbody|tr|th|td|h[1-6]|div|pre|blockquote|br|hr)\b[^>]*>/gi;

// the text of some HTML: its blocks apart, its other tags dropped (a line of
// highlighted code is many spans), its entities decoded and its whitespace
// collapsed
export function textOf(html: string): string {
  return decode(html.replace(blockTag, ' ').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decode(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (entity, name: string) => {
      if (name[0] === '#')
        return String.fromCodePoint(
          name[1] === 'x' || name[1] === 'X'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10),
        );
      return entities[name.toLowerCase()] ?? entity;
    },
  );
}
