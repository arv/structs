// the modules a pool worker loads on demand, which the bundler plugin lists
// (vite-plugin-threads.ts)
declare module 'virtual:threads/modules' {
  const modules: Record<string, () => Promise<unknown>>;
  export default modules;
}
