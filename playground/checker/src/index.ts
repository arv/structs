// The ownership checker of threads for JavaScript, on TypeScript 7.1's API: `check` reports what
// `tsgo own check` reports for programs written against the plain TypeScript API (threads.d.mts).

export { check, CheckError } from "./check.ts";
export type { CheckOptions } from "./check.ts";
export { formatDiagnostic, Messages } from "./messages.ts";
export type { Diagnostic } from "./messages.ts";
// an API session to pass to check() as `api`, so a long-running caller (the playground's dev server)
// opens TypeScript once
export { API } from "typescript/sync";
