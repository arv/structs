// Vite+ for the whole workspace: `vp dev` and `vp build` here run the
// playground, `vp fmt` formats everything with Oxfmt, `vp lint` lints it all
// type-aware, and `vp check` does both and checks types
import {defineConfig} from 'vite-plus';

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
      // columns
      'src/checker/test/cases/**',
      'src/checker/test/diverging/**',
      'src/checker/test/expected/**',
    ],
  },
  test: {
    // tests sit next to what they test
    include: ['src/**/*.test.ts'],
  },
  lint: {
    jsPlugins: [{name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin'}],
    rules: {'vite-plus/prefer-vite-plus-imports': 'error'},
    options: {typeAware: true, typeCheck: true},
    ignorePatterns: [
      // programs wrong on purpose: the checker's cases, and the mistakes it
      // catches
      'src/checker/test/cases/**',
      'src/checker/test/diverging/**',
      'playground/programs/mistakes.ts',
    ],
  },
});
