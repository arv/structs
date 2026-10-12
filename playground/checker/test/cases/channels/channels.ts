// Moves through channels (ownLayoutChannelsErrors, in the plain API).
import { Channel, f64, go, ref, select, SharedArray, struct, type Sending } from "threads";

interface Node { value: number; next: Node | null }
const Node = struct<Node>({ value: f64, next: ref<Node>() });

declare const flag: boolean;

export function useAfterSend(ch: Channel<Node>) {
  const n = new Node();
  ch.send(n);
  return n.value;                            // error: sent
}

export function alias(ch: Channel<Node>) {
  const n = new Node();
  const other = n;
  ch.send(n);
  return other.value;                        // error: shares the block with n
}

export function element(ch: Channel<SharedArray<Node>>) {
  const nodes = new SharedArray(Node, 4);
  const first = nodes[0]!;                   // stored inline in the array's block
  ch.send(nodes);
  return first.value;                        // error
}

export function maybe(ch: Channel<Node>) {
  const n = new Node();
  if (flag) ch.send(n);
  return n.value;                            // error: may have been sent
}

export function maybeAlias(ch: Channel<Node>) {
  const n = new Node();
  const other = n;
  if (flag) ch.send(n);
  return other.value;                        // error: may have been sent, through n
}

export function twice(ch: Channel<Node>) {
  const n = new Node();
  ch.send(n);
  ch.send(n);                                // error: sent
}

export function borrowed(ch: Channel<Node>, n: Node) {
  ch.send(n);                                // error: the caller may still use it
}

export function owned(ch: Channel<Node>, n: Sending<Node>) {
  ch.send(n);                                // fine: declared Sending
}

export function captured(ch: Channel<Node>) {
  const n = new Node();
  return () => ch.send(n);                   // error: captured from an outer scope
}

export function inLoop(ch: Channel<Node>) {
  for (let i = 0; i < 3; i++) {
    const n = new Node();                    // fresh in every iteration
    ch.send(n);
  }
  const kept = new Node();
  for (let i = 0; i < 3; i++) ch.send(kept); // error: sent in an earlier iteration
}

// Not moves: a thread's arguments share a counted value, and a reference field is not tracked.
function work(n: Node) {}
export function notMoves(ch: Channel<Node>, holder: Node) {
  const n = new Node();
  go(work, n);
  go(work, n);
  ch.send(holder.next!);
  return n.value + holder.next!.value;       // not reported: aliases through reference fields are not tracked
}

// select returns its value in an ordinary tuple, where nothing could count it.
export function selects(a: Channel<Node>, b: Channel<Node>) {
  const result = select(a, b);               // error
  return result[0];
}

// A for-of over a channel owns its values; over an ordinary array, it cannot.
export function loops(ch: Channel<Node>, list: Node[]) {
  let total = 0;
  for (const n of ch) total += n.value;
  for (const n of list) total += n.value;    // error
  return total;
}

export function received(ch: Channel<Node>, out: Channel<Node>) {
  const n = ch.recv();
  if (n) out.send(n);
  return n?.value;                           // errors: may have been sent, and optional chaining
}
