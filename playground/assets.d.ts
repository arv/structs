// what Vite imports besides modules: a file's text (`?raw`), a worker
// (`?worker`), and stylesheets
declare module '*?raw' {
  const text: string;
  export default text;
}
declare module '*.css';
declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
// the modules a pool worker loads on demand, which the bundler plugin lists
declare module 'virtual:threads/modules' {
  const modules: Record<string, () => Promise<unknown>>;
  export default modules;
}
