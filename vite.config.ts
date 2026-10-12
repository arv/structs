// Vite+ for the whole workspace: `vp dev` and `vp build` here run the playground, and `vp lint` lints
// everything, type-aware. Formatting (`vp fmt`) is not set up: Oxfmt's style is not this code's
import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "./playground",
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [
      // the earlier syntax's types, which only the tsgo fork parses (`sending T`)
      "own.d.ts", "chan.d.ts",
      // programs wrong on purpose: the checker's cases, and the mistakes it catches
      "playground/checker/test/cases/**", "playground/programs/mistakes.ts", "app/presets/mistakes.ts",
    ],
  },
});
