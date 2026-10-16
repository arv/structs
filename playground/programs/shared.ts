// Shared structs: one object every worker sees, in shared memory. Their
// fields hold primitives and other shared objects only, and they have no
// prototype and no methods.

import {run} from '@arv/structs/agent';

shared struct Message {
  text = '';
  from = 0;
  next: Message | null = null;
}

// on a worker: one more message, at the front of the list
export function post(head: Message, from: number) {
  const m = new Message();
  m.text = `hello from worker ${from}`;
  m.from = from;
  m.next = head.next;
  head.next = m;
}

export async function main(workers: number) {
  const head = new Message();
  // one at a time: they all write head.next
  for (let i = 1; i <= workers; i++) await run(import.meta.url, 'post', head, i);
  for (let m = head.next; m; m = m.next) console.log(m.text);
  console.log('prototype:', Object.getPrototypeOf(head));
  try {
    (head as any).text = {not: 'shareable'};
  } catch (e) {
    console.log('an object in a field:', (e as Error).message);
  }
}
