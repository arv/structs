// The page's entry. SharedArrayBuffer needs a cross-origin isolated page, and
// only such a page loads the playground (main.ts, whose first import makes the
// shared memory). A host that cannot send the headers for it gets them from a
// service worker (public/coi-sw.js): the page registers it, waits for it to be
// active, and loads once more, under it. It tries that once a session, until a
// load is isolated; a page still not isolated says so and stops (a hard reload
// skips the worker, and Chrome may skip it for a reload soon after, too).
const RELOADED = 'threads-coi-reloaded';

const session = (f: (s: Storage) => string | null | void) => {
  try {
    return f(sessionStorage);
  } catch {
    return undefined; // no storage: no way to stop a reload loop
  }
};

if (crossOriginIsolated) {
  session(s => s.removeItem(RELOADED));
  await import('./main.ts');
} else if (
  isSecureContext &&
  'serviceWorker' in navigator &&
  session(s => s.getItem(RELOADED)) === null
) {
  session(s => s.setItem(RELOADED, '1'));
  try {
    await navigator.serviceWorker.register('coi-sw.js');
    await navigator.serviceWorker.ready;
    location.reload();
  } catch (e) {
    console.error('threads: no service worker', e);
    notIsolated();
  }
} else {
  notIsolated();
}

function notIsolated() {
  document.getElementById('status')!.textContent =
    'This page is not cross-origin isolated, so SharedArrayBuffer is not available: reload it (a hard reload skips the service worker that isolates it)';
}

// a module, for the top-level awaits
export {};
