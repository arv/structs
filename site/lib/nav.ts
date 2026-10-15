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
      {title: 'Install', url: '/install/'},
      {title: 'Set Up', url: '/setup/'},
      {title: 'Tutorial', url: '/tutorial/'},
    ],
  },
  {
    title: 'Learning Threads',
    items: [
      {title: 'The Model', url: '/model/'},
      {title: 'Go-Style Concurrency', url: '/go-style-concurrency/'},
      {title: 'The Checker', url: '/checker/'},
      {title: 'Performance', url: '/performance/'},
      {title: 'Status', url: '/status/'},
    ],
  },
  {
    title: 'API Reference',
    items: [
      {title: 'Owned and Shared Values', url: '/api/owned-and-shared-values/'},
      {title: 'Threads', url: '/api/threads/'},
      {title: 'Goroutines and Channels', url: '/api/goroutines-and-channels/'},
      {title: 'Shared Memory', url: '/api/shared-memory/'},
      {title: 'Maps and Sets', url: '/api/maps-and-sets/'},
      {title: 'The Page', url: '/api/the-page/'},
      {title: 'Odds and Ends', url: '/api/odds-and-ends/'},
    ],
  },
  {
    title: 'Internals',
    items: [
      {title: 'Reference Counting', url: '/reference-counting/'},
      {title: 'The Prototypes', url: '/prototypes/'},
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
