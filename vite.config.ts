// Vite+ for the whole workspace: `vp dev` and `vp build` here run the
// playground, `vp fmt` formats everything with Oxfmt, `vp lint` lints it all
// type-aware, and `vp check` does both and checks types
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite-plus';

const here: (file: string) => string = file =>
  fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  defaultPackage: './playground',
  fmt: {
    singleQuote: true,
    trailingComma: 'all',
    arrowParens: 'avoid',
    bracketSpacing: false,
    quoteProps: 'consistent',
    printWidth: 80,
    proseWrap: 'always',
    sortImports: {newlinesBetween: false, partitionByNewline: true},
    sortPackageJson: true,
    ignorePatterns: [
      // the checker's cases, whose diagnostics are expected at fixed lines and
      // columns, and its tsconfigs with errors (one does not parse)
      'src/checker/test/cases/**',
      'src/checker/test/diverging/**',
      'src/checker/test/expected/**',
      'src/checker/test/config-errors/**',
    ],
  },
  test: {
    // tests sit next to what they test
    include: [
      'src/**/*.test.ts',
      'playground/*.test.ts',
      'playground/tsgo/*.test.ts',
      'site/*.test.ts',
      'site/lib/*.test.ts',
    ],
    // the playground's imports of the runtime, as its Vite config resolves
    // them
    alias: [
      {find: /^@arv\/threads$/, replacement: here('src/runtime/threads.ts')},
      {
        find: /^@arv\/threads\/(heap|browser|compiled)$/,
        replacement: here('src/runtime/$1.ts'),
      },
    ],
  },
  lint: {
    jsPlugins: [{name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin'}],
    rules: {'vite-plus/prefer-vite-plus-imports': 'error'},
    options: {typeAware: true, typeCheck: true},
    ignorePatterns: [
      // programs wrong on purpose: the checker's cases, its projects whose
      // tsconfigs have errors, and the mistakes it catches
      'src/checker/test/cases/**',
      'src/checker/test/diverging/**',
      'src/checker/test/config-errors/**',
      'playground/programs/mistakes.ts',
    ],
  },
});
