// the shared memory every thread uses. the runtime's views of it are module constants, so it must
// exist before the runtime loads: a page's entry module imports this first (`import "threads/heap"`).
// a pool worker gets the same buffer from the page instead (threads-worker.js)
if (globalThis.__escapeSab == null) {
  if (!globalThis.crossOriginIsolated) throw new Error('threads: SharedArrayBuffer needs a cross-origin isolated page (the COOP and COEP headers; the Vite plugin sets them)');
  globalThis.__escapeSab = new SharedArrayBuffer(256 << 20);
}
