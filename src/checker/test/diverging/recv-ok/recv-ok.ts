// recvOk blocks its thread as recv does: an async function calls recvOkAsync.
// The fork's table of blocking calls has no recvOk.
import { Channel, log } from "threads";

export async function blocks(ch: Channel<number[]>) {
  const [xs, ok] = ch.recvOk();              // error: blocks
  log(ok);
  return xs;
}

export async function waits(ch: Channel<number[]>) {
  const [xs, ok] = await ch.recvOkAsync();   // fine
  log(ok);
  return xs;
}

export function mayBlock(ch: Channel<number[]>) {
  const [xs, ok] = ch.recvOk();              // fine: not in an async function
  log(ok);
  return xs;
}
