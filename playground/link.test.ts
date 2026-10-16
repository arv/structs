import {expect, test} from 'vite-plus/test';
import {link} from './link.ts';

test('imports of the runtime read globalThis.__structs', () => {
  expect(
    link(
      `import * as $struct from "../../src/runtime/emit.ts"; import '../../src/runtime/index.ts';\nimport {run, spawn as s} from '../../src/runtime/agent.ts';\nimport {SharedArray} from "./src/runtime/index.ts";`,
    ),
  ).toBe(
    `const $struct = globalThis.__structs.runtime; \nconst {run, spawn : s} = globalThis.__structs.agent;\nconst {SharedArray} = globalThis.__structs.structs;`,
  );
});
