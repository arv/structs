// Structs read from the heap as addresses: from a SharedArray's elements and
// from a field (test/compile.test.ts).

import '@arv/structs';

export shared struct Node {
  x: number = 0;
  next: Node | null = null;
}

export function points(n: number): SharedArray<Node> {
  const arr = new SharedArray<Node>(n);
  for (let i = 0; i < n; i++) {
    const node = new Node();
    node.x = i;
    arr[i] = node;
  }
  return arr;
}

// arr[i], with arr's length
export function sumX(arr: SharedArray<Node>): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i]!;
    sum += p.x;
  }
  return sum;
}

// used as itself too: made, as it is
export function firstY(arr: SharedArray<Node>): number {
  const q = arr[0]!;
  return q === arr[0] ? q.x : -1;
}

// s.next
export function nextX(s: Node): number {
  const n = s.next!;
  return n.x;
}

// an async function: the runtime's views, which it may resume to find made
export async function later(arr: SharedArray<Node>): Promise<number> {
  await null;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]!.x + 1;
  return sum;
}

// two blocks, each its own `p`: the one used as itself does not keep the
// other from being an address
export function twice(arr: SharedArray<Node>): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i]!;
    if (p === arr[0]) sum++;
  }
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i]!;
    sum += p.x;
  }
  return sum;
}

// an address held while its struct is taken out of the array, and the heap
// collected and allocated over (`meanwhile`): the struct is kept until the
// turn ends
export function held(arr: SharedArray<Node>, meanwhile: () => void): number {
  const p = arr[0]!;
  arr[0] = new Node();
  meanwhile();
  return p.x;
}

// in a closure, an address could outlive the turn: the struct is made
export function inClosure(arr: SharedArray<Node>): () => number {
  const p = arr[0]!;
  return () => p.x;
}

// arr[i].x with no binding: the element's address, the struct made only for
// the slow path
export function sumDirect(arr: SharedArray<Node>): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]!.x;
  return sum;
}

// an index that is no identifier, evaluated once; a field that is no number
export function nextAfter(arr: SharedArray<Node>, k: number): Node | null {
  return arr[k + 1]!.next;
}

// arr[i].x = v: the receiver before the value, its index evaluated once
export function setX(arr: SharedArray<Node>, i: number, v: number): number {
  return (arr[i]!.x = v);
}
export function setNext(arr: SharedArray<Node>): number {
  let j = 0;
  arr[j++]!.x = j;
  return j;
}
