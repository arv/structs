// Do shared Wasm structs cross agents? Main makes a Bodies array and a Body,
// posts them to a worker; the worker writes a field, then posts the Body back.
// Main checks that it sees the write, and that what came back is the very
// object it sent (===). The worker also tries accessors that ref.cast the
// struct inside Wasm, and they pass strings through a shared struct's
// (shared extern) field. Then the two agents race on one field: the worker
// spins until main sets it, with no message between.
//
//   node --experimental-wasm-shared experiments/wasm-shared/share.js
//   deno run -A --v8-flags=--experimental-wasm-shared experiments/wasm-shared/share.js
//   deno run -A --v8-flags=--experimental-wasm-shared experiments/wasm-shared/share.js web

import {instantiate} from './body-module.js';

const web = (globalThis.Deno?.args ?? process.argv.slice(2)).includes('web');
const isWorker = web
  ? typeof WorkerGlobalScope !== 'undefined'
  : !(await import('node:worker_threads')).isMainThread;

const shared = !(globalThis.Deno?.args ?? process.argv.slice(2)).includes(
  'unshared',
);
const w = instantiate({shared});

async function port() {
  if (web)
    return {
      post: m => self.postMessage(m),
      on: f => (self.onmessage = e => f(e.data)),
    };
  const {parentPort} = await import('node:worker_threads');
  return {
    post: m => parentPort.postMessage(m),
    on: f => parentPort.on('message', f),
  };
}

if (isWorker) {
  const p = await port();
  p.on(msg => {
    if (msg.kind === 'write') {
      const b = w.bodies_get(msg.bodies, 0);
      const sameAsSent = b === msg.body;
      // a cast in Wasm, of a struct another agent allocated
      const cast = {};
      for (const f of ['any_get_x', 'xget_x']) {
        try {
          cast[f] = w[f](msg.body);
        } catch (e) {
          cast[f] = `${e.constructor.name}: ${e.message}`;
        }
      }
      w.set_y(msg.body, 1234.5);
      // a string main stored in a shared struct; and one stored back
      const string = w.box_get(msg.box);
      w.box_set(
        msg.box,
        ['from', 'worker', String(Math.random()).slice(0, 4)].join(' '),
      );
      p.post({
        kind: 'wrote',
        body: msg.body,
        sameAsSent,
        cast,
        string,
        x: w.get_x(msg.body),
      });
    } else if (msg.kind === 'spin') {
      p.post({kind: 'spinning'});
      let n = 0;
      while (w.get_z(msg.body) === 0) n++;
      p.post({kind: 'saw', z: w.get_z(msg.body), spins: n});
    }
  });
} else {
  const body = w.new_body(7, 0, 0, 0, 0, 0, 1);
  const bodies = w.new_bodies(1);
  w.bodies_set(bodies, 0, body);
  const box = w.new_box(['made', 'on', 'main'].join(' '));
  let worker, on, post;
  if (web) {
    worker = new Worker(import.meta.url + (shared ? '' : '?unshared'), {
      type: 'module',
    });
    on = f => (worker.onmessage = e => f(e.data));
    post = m => worker.postMessage(m);
    worker.onerror = e => {
      console.log('worker error:', e.message);
      e.preventDefault();
    };
  } else {
    const {Worker} = await import('node:worker_threads');
    worker = new Worker(new URL(import.meta.url), {
      argv: process.argv.slice(2),
    });
    on = f => worker.on('message', f);
    post = m => worker.postMessage(m);
    worker.on('error', e => console.log('worker error:', e.message));
  }
  const next = () => new Promise(r => on(r));
  try {
    post({kind: 'write', body, bodies, box});
  } catch (e) {
    console.log('postMessage failed:', e.constructor.name, e.message);
    worker.terminate();
    process?.exit?.(1);
  }
  const r = await next();
  console.log('worker read x:', r.x, '(main wrote 7)');
  console.log('worker: bodies[0] === posted body:', r.sameAsSent);
  for (const [f, v] of Object.entries(r.cast))
    console.log(`worker: ${f}(body), a ref.cast inside:`, v);
  console.log('main: xget_x(body):', w.xget_x(body));
  console.log('worker read the string in a Box:', JSON.stringify(r.string));
  const back = w.box_get(box);
  console.log(
    'main reads the string the worker stored:',
    JSON.stringify(back),
    typeof back,
  );
  console.log(
    'main sees worker write of y:',
    w.get_y(body),
    '(worker wrote 1234.5)',
  );
  console.log('posted back === original:', r.body === body);
  post({kind: 'spin', body});
  await next(); // spinning
  await new Promise(r => setTimeout(r, 50));
  w.set_z(body, 99);
  const s = await next();
  console.log(
    'worker, spinning, saw main write z =',
    s.z,
    `after ${s.spins} spins`,
  );
  worker.terminate();
}
