// A compile for the load hook of a worker thread (register.ts), which cannot
// start tsgo itself: the source on stdin, the file's name and the runtime's
// specifier as arguments, what transpile gives as JSON on stdout.
import {readFileSync} from 'node:fs';
import {closeApi, transpile} from './index.ts';

const [fileName, runtime] = process.argv.slice(2);
const out = transpile(readFileSync(0, 'utf8'), {fileName, runtime});
closeApi();
process.stdout.write(JSON.stringify(out));
