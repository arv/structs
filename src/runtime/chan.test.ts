// chan.ts on one thread: channels, blocking and async.
import {describe, expect, it} from 'vite-plus/test';
import {runtime, threads as T} from './test-heap.ts';

describe('channels', () => {
  it('move values in order', () => {
    const ch = new T.Channel(4);
    ch.send(1);
    ch.send({a: 2});
    expect(ch.recv()).toBe(1);
    expect(ch.recv()).toEqual({a: 2});
  });

  it('drain once closed, and refuse sends', () => {
    const ch = new T.Channel(2);
    ch.send('a');
    ch.send('b');
    ch.close();
    expect([...ch]).toEqual(['a', 'b']);
    expect(ch.recv()).toBeUndefined();
    expect(() => ch.send('c')).toThrow(/closed channel/);
  });

  it('select the channel with a value', () => {
    const x = new T.Channel(1),
      y = new T.Channel(1);
    y.send(9);
    expect(T.select(x, y)).toEqual([1, 9]);
  });

  it('a blocking select is woken by its own channels, not by others', () => {
    // this test is the other thread too: the select's wait sends on a channel
    // the select does not wait on, then on one it does
    const x = new T.Channel(1),
      y = new T.Channel(1),
      other = new T.Channel(1);
    const atomics = Atomics as unknown as {wait: typeof Atomics.wait};
    const wait = atomics.wait;
    const bumped: boolean[] = [];
    atomics.wait = ((arr: Int32Array, i: number, v: number) => {
      other.send('elsewhere');
      bumped.push(Atomics.load(arr, i) !== v);
      y.send('mine');
      bumped.push(Atomics.load(arr, i) !== v);
      return 'not-equal';
    }) as typeof Atomics.wait;
    try {
      expect(T.select(x, y)).toEqual([1, 'mine']);
    } finally {
      atomics.wait = wait;
    }
    expect(bumped).toEqual([false, true]);
    // the select's records are out of the channels' lists
    for (const ch of [x, y, other])
      expect(runtime.I32[(ch.$cell >> 2) + 11]).toBe(0);
    expect(other.recv()).toBe('elsewhere');
  });

  it('wait without blocking in an async function', async () => {
    const unbuffered = new T.Channel();
    const received = unbuffered.recvAsync();
    await unbuffered.sendAsync(7); // waits until the receiver takes it
    expect(await received).toBe(7);

    const x = new T.Channel(1),
      later = new T.Channel(1);
    setTimeout(() => later.sendAsync('late'), 10);
    expect(await T.selectAsync(x, later)).toEqual([1, 'late']);
  });

  it('goroutines passing messages on one thread let its tasks run', async () => {
    // two async goroutines on this thread, each waking the other: a timer due
    // at once must run before they are done, as would any task of the thread
    const N = 2000;
    const x = new T.Channel(4),
      y = new T.Channel(4);
    let done = 0,
      fired = -1;
    setTimeout(() => (fired = done), 0);
    const a = (async () => {
      for (let i = 0; i < N; i++) {
        await x.sendAsync(i);
        await y.recvAsync();
        done = i + 1;
      }
      x.close();
    })();
    const b = (async () => {
      for await (const v of x) await y.sendAsync(v);
    })();
    await Promise.all([a, b]);
    expect(done).toBe(N);
    expect(fired).toBeGreaterThanOrEqual(0);
    expect(fired).toBeLessThan(N);
  });

  it('iterate with for await', async () => {
    const ch = new T.Channel(2);
    const sending = (async () => {
      for (const v of [1, 2, 3]) await ch.sendAsync(v);
      ch.close();
    })();
    const seen = [];
    for await (const v of ch) seen.push(v);
    await sending;
    expect(seen).toEqual([1, 2, 3]);
  });
});
