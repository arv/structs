// chan.ts on one thread: channels, blocking and async.
import {describe, expect, it} from 'vite-plus/test';
import {own, runtime, threads as T} from './test-heap.ts';

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

  it('tell a sent undefined from a close with recvOk', () => {
    // recv gives undefined for both
    const ch = new T.Channel(4);
    ch.send(undefined);
    ch.close();
    expect(ch.recv()).toBeUndefined();
    expect(ch.recv()).toBeUndefined();

    const ok = new T.Channel(4);
    ok.send(1);
    ok.send(undefined);
    ok.close();
    expect(ok.recvOk()).toStrictEqual([1, true]);
    expect(ok.recvOk()).toStrictEqual([undefined, true]);
    expect(ok.recvOk()).toStrictEqual([undefined, false]);
    expect(ok.recvOk()).toStrictEqual([undefined, false]);
  });

  it('tell them apart with recvOkAsync', async () => {
    const ch = new T.Channel();
    const received = ch.recvOkAsync();
    await ch.sendAsync(undefined); // waits until the receiver takes it
    expect(await received).toStrictEqual([undefined, true]);
    const closed = ch.recvOkAsync();
    ch.close();
    expect(await closed).toStrictEqual([undefined, false]);
  });

  it('hand the receiver the count a counted value carries', () => {
    // as compiled code sends a struct: its address, as __countedRef(p), so the
    // message carries a count, which the receiver owns and releases
    const N = own.sharedStruct('Received', ['v']);
    const ch = new T.Channel(1);
    for (const receive of [() => ch.recv(), () => ch.recvOk()[0]]) {
      const a = own.newStruct(N);
      ch.send(own.countedRef(a));
      own.release(a); // the sender's count
      const b = receive();
      expect(b).toBe(a);
      expect(runtime.I32[(a >> 2) + 1]).toBe(1); // the message's, the receiver's
      const freed = T.heapStats().freed;
      own.release(b as number);
      expect(T.heapStats().freed - freed).toBe(1);
      expect(runtime.I32[a >> 2]).toBe(runtime.K_FREE);
    }
  });

  it('select the channel with a value', () => {
    const x = new T.Channel(1),
      y = new T.Channel(1);
    y.send(9);
    expect(T.select(x, y)).toStrictEqual([1, 9, true]);
  });

  it("select's third element tells a sent undefined from a close", async () => {
    const x = new T.Channel(1),
      y = new T.Channel(1);
    y.send(undefined);
    expect(T.select(x, y)).toStrictEqual([1, undefined, true]);
    y.close();
    expect(T.select(x, y)).toStrictEqual([1, undefined, false]);

    const later = new T.Channel(1);
    setTimeout(() => later.sendAsync(undefined), 10);
    expect(await T.selectAsync(x, later)).toStrictEqual([1, undefined, true]);
    setTimeout(() => later.close(), 10);
    expect(await T.selectAsync(x, later)).toStrictEqual([1, undefined, false]);
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
      expect(T.select(x, y)).toStrictEqual([1, 'mine', true]);
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
    expect(await T.selectAsync(x, later)).toStrictEqual([1, 'late', true]);
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
