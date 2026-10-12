// what Vite imports besides modules: a file's text (`?raw`), and stylesheets
declare module "*?raw" {
  const text: string;
  export default text;
}
declare module "*.css";
