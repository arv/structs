// What a program with its types only erased needs at its end (registration):
// the line registering the functions its compiled code registers. Which those
// are, from sources the compiler tells apart and a scan of the text would not,
// the Vite plugin's tests check with threads-check itself
import {describe, expect, it} from 'vite-plus/test';
import {registeredIn, registration} from './compiled.ts';

const RUNTIME = '@arv/threads';
// the compiled code of a program that registers main and gen
const EMIT = `import { register as __register } from "@arv/threads";
import { log } from '@arv/threads';
export default function main() { log('main'); }
function* gen() { yield 1; }
__register(import.meta.url, { main, gen });
//# sourceMappingURL=program.js.map`;

describe('registration', () => {
  it('registers what the compiled code registers', () => {
    expect(registeredIn(EMIT, RUNTIME)).toEqual(['main', 'gen']);
    const {tail, added} = registration('', RUNTIME, EMIT);
    expect(tail).toBe(
      `\n// added: the runtime finds a thread's function by module and name\nimport { register } from "@arv/threads";\nregister(import.meta.url, { main, gen });\n`,
    );
    expect(added).toBe(3);
  });

  it('imports register under a name the program does not have', () => {
    expect(registration('const register = 1;', RUNTIME, EMIT).tail).toContain(
      'import { register as register_1 } from "@arv/threads";\nregister_1(import.meta.url, { main, gen });',
    );
  });

  it('adds nothing where the compiler registers nothing, or emitted nothing', () => {
    const none = `import { log } from '@arv/threads';\nlog('x');\n`;
    expect(registeredIn(none, RUNTIME)).toBe(null);
    expect(registration('', RUNTIME, none)).toEqual({tail: '', added: 0});
    expect(registration('', RUNTIME, null)).toEqual({tail: '', added: 0});
  });
});
