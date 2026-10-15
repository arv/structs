// A number field whose marker and type disagree: TypeScript takes an i32 marker
// for a number field, and an f64 or a u8 one for an i32 field. The runtime
// stores the field as its marker says, and the checker checks what is stored
// into an integer by its type: a fraction into the first would be truncated
// unseen, one into the second refused though it is kept. The fork does not
// compare them.
import { f64, i32, u8, struct, type Field, type IntegerField, type i32 as I32, type u8 as U8 } from "threads";

interface Typed { n: number }
const Typed = struct<Typed>({ n: i32 });                       // error: a number marked i32
interface Marked { n: I32 }
const Marked = struct<Marked>({ n: f64 });                     // error: an i32 marked f64
interface Byte { n: I32 }
const Byte = struct<Byte>({ n: u8 });                          // error: an i32 marked u8
interface Agree { n: I32; b: U8; x: number }
const Agree = struct<Agree>({ n: i32, b: u8, x: f64 });        // fine
const Inferred = struct({ n: i32, b: u8, x: f64 });            // fine: its type is its markers'
export { Typed, Marked, Byte, Agree, Inferred };
// an integer marker is laid out by its kind, whatever its type says it holds
const byte: IntegerField<I32, "u8"> = u8;
interface Annotated { n: I32 }
const Annotated = struct<Annotated>({ n: byte });               // error: an i32 marked u8
export { Annotated };
// a marker typed a Field of a number: by the runtime's marker it holds, where
// the checker can follow it there, else of no kind it can tell
const erased: Field<number> = i32;
interface Erased { n: number }
const Erased = struct<Erased>({ n: erased });                  // error: a number marked i32
declare const someMarker: Field<number>;
interface Unknown { n: number }
const Unknown = struct<Unknown>({ n: someMarker });            // error: of no kind it can tell
const double = f64;
interface Doubled { n: number }
const Doubled = struct<Doubled>({ n: double });                // fine: the runtime's f64
export { Erased, Unknown, Doubled };
// a marker destructured from the runtime's namespace is the one it selects
import * as threads from "threads";
const { f64: float, i32: int } = threads;
interface Picked { x: number; n: number }
const Picked = struct<Picked>({ x: float, n: int });          // error: n, a number marked i32
export { Picked };
