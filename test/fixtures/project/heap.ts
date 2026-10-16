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
