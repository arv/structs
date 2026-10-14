// a main that throws what a join threw (run.test.ts): the coordinator prints
// the failure the join told of, with the stack of the thread where it began
import {register, spawn} from '@arv/threads';

function bad(): number {
  throw new Error('boom');
}
export function main() {
  spawn(bad).join();
}
register(import.meta.url, {bad, main});
