// Vite+ for the package: `vp fmt` formats with Oxfmt, `vp lint` lints
// type-aware, `vp check` does both and checks types, `vp test` runs the tests
import {defineConfig} from 'vite-plus';

export default defineConfig({
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
    // programs in the proposal's syntax, which no formatter parses
    ignorePatterns: [
      'examples/**',
      'test/fixtures/**',
      'playground/programs/**',
    ],
  },
  test: {
    include: [
      'test/**/*.test.ts',
      'playground/*.test.ts',
      'playground/tsgo/*.test.ts',
    ],
    // the tests start workers, which take a moment
    testTimeout: 20000,
  },
  lint: {
    options: {typeAware: true, typeCheck: true},
    ignorePatterns: [
      'examples/**',
      'test/fixtures/**',
      'playground/programs/**',
    ],
  },
});
