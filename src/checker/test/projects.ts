// Projects the comparisons with the fork share (compare.ts, emit-compare.ts).

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

// A compiler test (`// @option: value` lines, then `// @filename: name` units)
// as a project.
export function writeCompilerTest(
  text: string,
  dir: string,
): {runtime: string} {
  const options: Record<string, unknown> = {};
  const files: string[] = [];
  let runtime = '';
  let current: string[] | undefined;
  let currentName = '';
  const flush = () => {
    if (current) writeFileSync(join(dir, currentName), current.join('\n'));
  };
  mkdirSync(dir, {recursive: true});
  for (const line of text.split(/\r?\n/)) {
    const directive = /^\/\/\s*@(\w+):\s*(.*?)\s*$/.exec(line);
    if (directive) {
      const [, key, value] = directive as unknown as [string, string, string];
      if (key.toLowerCase() === 'filename') {
        flush();
        current = [];
        currentName = value;
        files.push(value);
        continue;
      }
      if (!current) {
        if (key === 'ownRuntime') runtime = value;
        else
          options[key] =
            key === 'lib'
              ? value.split(',').map(s => s.trim())
              : value === 'true'
                ? true
                : value === 'false'
                  ? false
                  : value;
        continue;
      }
    }
    current?.push(line);
  }
  flush();
  options.noEmit = true;
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({compilerOptions: options, files}, null, 2),
  );
  return {runtime};
}
