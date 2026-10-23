// The collector (src/runtime/gc.ts): what no agent can reach is freed, so a
// program that lets go of what it allocates can allocate without end; what
// some agent can still reach is not.

import {describe, expect, test} from 'vite-plus/test';
import '../src/runtime/index.ts';
import {decode, encode, run, startWorker} from '../src/runtime/agent.ts';
import {collect} from '../src/runtime/gc.ts';
import {heapStats} from '../src/runtime/heap.ts';
import {load} from './helpers.ts';

const MB = 1 << 20;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

describe('the collector', () => {
  test('a loop lets go of what it allocates, many times the heap', async () => {
    const {size} = heapStats();
    const before = heapStats().collections;
    let total = 0;
    for (let round = 0; round < 64; round++) {
      for (let i = 0; i < 16; i++) {
        const a = new SharedArray(1 << 16);
        a[0] = a;
        total += MB;
      }
      await nextTurn();
    }
    expect(total).toBeGreaterThan(3 * size);
    expect(heapStats().collections).toBeGreaterThan(before);
    collect(true);
    expect(heapStats().used).toBeLessThan(size / 4);
  });

  test('workers allocate far more than the heap, together, and keep what they keep', async () => {
    const {size} = heapStats();
    const keep = new SharedArray<any>(4);
    const churn = new URL('./fixtures/churn.ts', import.meta.url);
    const totals = await Promise.all(
      [0, 1, 2, 3].map(me => run(churn, 'churn', keep, me, 384)),
    );
    expect(totals.reduce((a: number, b: any) => a + b, 0)).toBe(4 * 384 * MB);
    expect(4 * 384 * MB).toBeGreaterThan(5 * size);
    for (const me of [0, 1, 2, 3]) {
      expect(keep[me][0]).toBe(me);
      expect(keep[me][1]).toBe('kept');
      expect(keep[me][2].length).toBe(me * 2);
    }
  });

  test('what is still reachable survives a collection', async () => {
    const {Node} = await load(`
      export shared struct Node {
        value = 0;
        name = '';
        next = null;
        items = new SharedArray(3);
      }
    `);
    // a ring of nodes, held only by its first, and one held only by its Proxy
    const head = new Node();
    let last = head;
    for (let i = 1; i < 100; i++) {
      const n = new Node();
      n.value = i;
      n.name = `node ${i}`;
      n.items[0] = new SharedArray(i);
      n.items[1] = 10n ** BigInt(i);
      last.next = n;
      last = n;
    }
    last.next = head;
    const lone = new Node();
    lone.value = -1;
    await nextTurn();
    // garbage, collected, and allocated over
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 1000; i++) new Node().items[2] = new SharedArray(64);
      await nextTurn();
      collect(true);
    }
    let n = head.next;
    for (let i = 1; i < 100; i++, n = n.next) {
      expect(n.value).toBe(i);
      expect(n.name).toBe(`node ${i}`);
      expect(n.items[0].length).toBe(i);
      expect(n.items[1]).toBe(10n ** BigInt(i));
    }
    expect(n).toBe(head);
    expect(lone.value).toBe(-1);
  });

  test('a shared object in flight in a message is kept', async () => {
    let message: unknown = encode({
      array: new SharedArray<unknown>('in flight', 2),
    });
    await nextTurn();
    collect(true);
    // garbage of its size, which its block would go to
    for (let i = 0; i < 1000; i++) new SharedArray<unknown>('garbage', 3);
    message = decode(message);
    expect((message as any).array[0]).toBe('in flight');
  });

  test('what a worker held is let go of as it ends', async () => {
    collect(true);
    const before = heapStats().used;
    const w = startWorker(
      new URL('./fixtures/hold-worker.ts', import.meta.url),
    );
    const reply = new Promise(resolve => (w.onmessage = resolve));
    w.postMessage('hold');
    expect(await reply).toBe('holding');
    collect();
    expect(heapStats().used).toBeGreaterThan(before + 15 * MB);
    w.terminate();
    await w.exited;
    collect();
    expect(heapStats().used).toBeLessThan(before + MB);
  });
});
