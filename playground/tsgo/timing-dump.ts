// What TypeScript 7.1's sync API client writes its timing to, in place of its
// own (typescript/dist/api/timingDump.js, which reads TS_API_TIMING_DIR from
// process.env and writes a file there): in the browser there is no
// environment and no disk, so there is never a dump (vite.config.ts).
export class TimingDump {
  static fromEnvironment(): undefined {
    return undefined;
  }
  write(): never {
    throw new Error('a timing dump is not in the browser');
  }
}
