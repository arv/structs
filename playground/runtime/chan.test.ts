// chan.ts on one thread: channels, blocking and async.
import {describe, expect, it} from 'vite-plus/test';
import {threads as T} from './test-heap.ts';

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
