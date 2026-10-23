# @arv/structs-compiler

The compiler of [@arv/structs](https://github.com/arv/structs), the TC39
[structs proposal](https://tc39.es/proposal-structs/) for JavaScript today. It
compiles the proposal's syntax, `struct` and `shared struct`, to JavaScript that
calls the runtime, `@arv/structs`, which it needs installed beside it.

```sh
npm install @arv/structs
npm install --save-dev @arv/structs-compiler
```

In Node, its load hook compiles struct syntax as modules load, in workers too:

```sh
node --import @arv/structs-compiler/register main.js
```

The `structs` command compiles a single file, or a whole TypeScript project with
type checking. In TypeScript, where the types prove an object is a shared
struct, its field access is made direct, in shared memory:

```sh
npx structs transpile main.js
npx structs compile -p tsconfig.json
```

From code, use `transpile(source, {fileName})` and `compile(tsconfigPath)`.

The docs are at [structs.arv.tools](https://structs.arv.tools/), and there is a
playground at
[structs.arv.tools/playground](https://structs.arv.tools/playground/).

## License

Apache-2.0
