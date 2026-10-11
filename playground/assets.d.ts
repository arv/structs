// what Vite imports besides modules: a file's text (`?raw`), a worker (`?worker`), and stylesheets
declare module "*?raw" {
  const text: string;
  export default text;
}
declare module "*.css";
declare module "*?worker" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
