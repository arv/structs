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
      // the earlier syntax's types, which only the tsgo fork parses (`sending
      // T`)
      'src/own.d.ts',
      'src/chan.d.ts',
      // the checker's cases, whose diagnostics are expected at fixed lines and
      // columns
      'playground/checker/test/cases/**',
      'playground/checker/test/expected/**',
    ],
  },
  lint: {
    jsPlugins: [{name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin'}],
    rules: {'vite-plus/prefer-vite-plus-imports': 'error'},
    options: {typeAware: true, typeCheck: true},
    ignorePatterns: [
      // the earlier syntax's types, which only the tsgo fork parses (`sending
      // T`)
      'src/own.d.ts',
      'src/chan.d.ts',
      // programs wrong on purpose: the checker's cases, and the mistakes it
      // catches
      'playground/checker/test/cases/**',
      'playground/programs/mistakes.ts',
    ],
  },
});
