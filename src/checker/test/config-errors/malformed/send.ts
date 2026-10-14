import {Channel, SharedArray} from 'threads';
import type {Sending} from 'threads';

export function send(
  ch: Channel<SharedArray<number>>,
  xs: Sending<SharedArray<number>>,
) {
  ch.send(xs);
  return xs.length;
}
