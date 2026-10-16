// The sidebar, in sections as the Zero docs have them, and the order that the
// pages' Previous and Next links follow. Every page of the site is here, at the
// URL its permalink gives it; `app` marks a link out to the playground, which
// isn't a page of the docs

export type NavItem = {title: string; url: string; app?: true};
export type NavSection = {title: string; items: NavItem[]};

export const sections: NavSection[] = [
  {
    title: 'Get Started',
    items: [
      {title: 'Introduction', url: '/'},
      {title: 'Running It', url: '/running-it/'},
    ],
  },
  {
    title: 'The Proposal',
    items: [
      {title: 'Structs', url: '/structs/'},
      {title: 'Shared Structs', url: '/shared-structs/'},
      {title: 'Mutex and Condition', url: '/mutex-and-condition/'},
      {title: 'Differences from the Spec', url: '/differences-from-the-spec/'},
    ],
  },
  {
    title: 'Beyond the Spec',
    items: [
      {title: 'Sharing Across Agents', url: '/sharing-across-agents/'},
      {title: 'TypeScript', url: '/typescript/'},
    ],
  },
  {
    title: 'Playground',
    items: [
      {title: 'The Playground', url: '/the-playground/'},
      {title: 'Open the Playground', url: '/playground/', app: true},
    ],
  },
  {
    title: 'Meta',
    items: [{title: 'This Repository', url: '/repository/'}],
  },
];

// the docs' pages, in order
export const pages: NavItem[] = sections.flatMap(section =>
  section.items.filter(item => !item.app),
);

export type Pager = {prev: NavItem | null; next: NavItem | null};

export function pager(url: string): Pager {
  const i = pages.findIndex(page => page.url === url);
  if (i === -1) return {prev: null, next: null};
  return {prev: pages[i - 1] ?? null, next: pages[i + 1] ?? null};
}
