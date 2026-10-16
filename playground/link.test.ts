import {expect, test} from 'vite-plus/test';
import {link} from './link.ts';

test('imports of the runtime read globalThis.__structs', () => {
  expect(
    link(
      `import * as $struct from "@arv/structs/runtime"; import '@arv/structs';\nimport {run, spawn as s} from '@arv/structs/agent';\nimport {SharedArray} from "@arv/structs";`,
    ),
  ).toBe(
    `const $struct = globalThis.__structs.runtime; \nconst {run, spawn : s} = globalThis.__structs.agent;\nconst {SharedArray} = globalThis.__structs.structs;`,
  );
});
