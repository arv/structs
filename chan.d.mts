// Types for chan.mjs: Go-style goroutines and channels on own.mjs, for the own/shared TypeScript
// extension. A value sent on a channel moves: the checker rejects any use of it after `send`, as
// after `spawn`. The receiver owns what it receives.

/** A channel: values move through it from one thread to another, in order. */
export interface ChannelCell<T> {
  /**
   * Moves `value` into the channel. Waits while the channel is full; on an unbuffered channel, until
   * a receiver has taken the value. Throws on a closed channel.
   */
  send(value: sending T): void;
  /** The next value, which the caller now owns. Waits while the channel is empty; undefined once it is closed and empty. */
  recv(): sending T | undefined;
  /** No more sends. Receivers still get what is left. */
  close(): void;
  /** The values until the channel is closed and empty. */
  [Symbol.iterator](): Iterator<T>;
}
/** A channel holding up to `capacity` values; 0 (the default) is unbuffered. */
export declare const Channel: new <T>(capacity?: number) => shared ChannelCell<T>;

/** Starts `f` on a thread of its own, a goroutine. Nothing waits for it. Every argument is sent. */
export declare function go<A extends unknown[]>(f: (...args: A) => void, ...args: sending A): void;

/**
 * Waits until one of the channels has a value or is closed: its index and the value, which the
 * caller now owns (undefined for a closed channel).
 */
export declare function select<T>(...channels: (shared ChannelCell<T>)[]): [index: number, value: T | undefined];
