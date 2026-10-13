// A Channel that is not the runtime's: a loop over one, or a call on one, in an
// async function blocks nothing. Only a runtime Channel's `for...of` is
// TS96030 (and its send and recv TS96030 too).
import { log } from "threads"; // a program of threads: the checker needs one
import { Channel } from "./other";

export async function sum(c: Channel<number>) {
  let s = 0;
  for (const x of c) s += x;
  c.send(1);
  log(s);
  return s + (c.recv() ?? 0);
}
