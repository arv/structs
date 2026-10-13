// @arv/threads/compiled: what the Vite plugin and a page that compiles programs
// itself (the playground, in WebAssembly) do with a compiled program's text
// (compiled.ts)

/** The runtime helpers the fork's emit imports, by their exported names. */
export declare const HELPERS: Set<string>;
/** The local names of the helpers `code` imports from `runtime`. */
export declare function helpersOf(
  code: string,
  runtime: string,
): Record<string, string>;
/** A name like `name` that no identifier in `source` has. */
export declare function uniqueName(source: string, name: string): string;
/** `code` registering its functions with `key` in place of import.meta.url. */
export declare function keyRegistration(
  code: string,
  runtime: string,
  key: string,
): string;
/**
 * What a program with its types only erased needs at its end (the line that
 * registers its top-level functions), and how many lines that is.
 */
export declare function registration(
  source: string,
  runtime: string,
): {tail: string; added: number};
export type Diagnostic = {
  line: number;
  col: number;
  code: string;
  message: string;
};
/** tsc's `file(line,col): error TS1234: message` lines, parsed. */
export declare function diagnostics(text: string | undefined): Diagnostic[];
