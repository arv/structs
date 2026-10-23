import {Body, Local, Vec} from './shapes.ts';

export function length(v: Vec): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

export function chain(n: number): Body {
  let head: Body | null = null;
  for (let i = 0; i < n; i++) {
    const b = new Body(i, -i);
    b.next = head;
    b.name = `b${i}`;
    head = b;
  }
  return head!;
}

export function total(b: Body | null): number {
  let sum = 0;
  for (; b; b = b.next) sum += b.x * b.mass;
  return sum;
}

export function step(b: Body) {
  b.x += 1; // compound: the slot read and written once
  b.y = b.y - 1;
}

export const local = new Local();
