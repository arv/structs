// A class named Channel that is not the runtime's.
export declare class Channel<T> {
  [Symbol.iterator](): Iterator<T>;
  send(value: T): void;
  recv(): T | undefined;
}
