// What TypeScript 7.1's API client imports from node, in the browser: it
// imports these to find and spawn tsgo, or to guess the file system's case,
// none of which it does here (tsgo is in WebAssembly, and the compiler's
// worker says the case), so each one throws if it is ever called.
const absent = (name: string) => (): never => {
  throw new Error(`${name} is not in the browser`);
};

export const existsSync = absent('fs.existsSync');
export const readFileSync = absent('fs.readFileSync');
export const fileURLToPath = absent('url.fileURLToPath');
export const createRequire = absent('module.createRequire');
export const spawn = absent('child_process.spawn');
export default {existsSync, readFileSync, createRequire};
