// `ownRuntime` (here --runtime) needs ES module output: with CommonJS it is an error (TS96014), and
// the program is still checked.
import { Channel } from "threads";

export function f(ch: Channel<number[]>) {
  const xs = [1];
  ch.send(xs);
  return xs.length; // error: sent
}
