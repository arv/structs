// An ordinary object where a shared struct goes: TypeScript takes an object
// literal, or an instance of a class, for a struct type declared with an
// interface, by its members, and lets a cast make one of a struct type of any
// kind. The place holds an address in the shared heap, and the runtime cannot
// make one of the object. The fork lets them through.
import { f64, i32, str, ref, struct, Channel, SharedArray, type Cell, type Struct } from "threads";

interface Node { value: number; next: Node | null }
const Node = struct<Node>({ value: f64, next: ref<Node>() });
class Plain { value = 1; next: Node | null = null }
const Point = struct({ x: f64 });
type Point = Struct<typeof Point>;

declare const flag: boolean;
declare const handle: unknown;
declare const anything: any;

export function declared() { const n: Node = { value: 1, next: null }; return n; }   // error
export function returned(): Node { return { value: 1, next: null }; }                // error
export function constructed(): Node { return new Plain(); }                           // error
export function stored(n: Node) { n.next = { value: 2, next: null }; }                // error
export function param(n: Node) { return n.value; }
export function passed() { return param({ value: 3, next: null }); }                  // error
export function sent(ch: Channel<Node>) { ch.send({ value: 4, next: null }); }        // error
export function defaulted(n: Node = { value: 5, next: null }) { return n; }           // error
export function cast() { return { x: 1 } as Point; }                                  // error: a cast makes no struct
export function castNode() { return { value: 1, next: null } as Node; }               // error
export function branch(): Node { return flag ? new Node() : { value: 1, next: null }; }  // error: the literal
export function nullable(): Node | null { return flag ? null : new Plain(); }         // error: the Plain

export function made(): Node { return new Node(); }                                   // fine
export function none(): Node | null { return null; }                                  // fine
export function element(a: SharedArray<Node>): Node { return a[0]!; }                 // fine
export function fromHandle(): Node { return handle as Node; }                         // fine: a handle may hold one
export function fromAny(): Node { return anything; }                                  // fine
export function fromEmpty(x: {}): Node { return x as Node; }                          // fine: so may an {}
export function generic<T extends Node>(t: T): Node { return t; }                     // fine
// a place of structs and SharedArrays holds an address too
export function mixed() { const n: Node | SharedArray<number> = { value: 1, next: null }; return n; }  // error
// an async function's result is what its promise resolves to
export async function forwarded(): Promise<Node> { return Promise.resolve(new Node()); }  // fine
export async function forwardedPlain(): Promise<Node> { return Promise.resolve({ value: 1, next: null }); }  // error
// what a function returns, or a promise resolves to, as one of a struct
function plain() { return { value: 1, next: null }; }
export const make: () => Node = plain;                                // error
declare function plainLater(): Promise<{ value: number; next: null }>;
export const later: () => Promise<Node> = plainLater;                 // error
// the runtime's Cell holds a handle
export function roundTrip() { const h: Cell = new Point(); return h as Point; }  // fine
// a field marker is an ordinary object, though TypeScript may take it for a
// struct by its members
interface Tag { kind: string }
const Tag = struct<Tag>({ kind: str });
export const tagged: Tag = i32;                                       // error
// an ordinary object beside SharedArrays, as what a function returns
declare function source(): SharedArray<Node> | { value: number; next: null };
export const fromSource: () => Node | SharedArray<Node> = source;     // error
// a spread's values go into the parameters from its place on
const args = [{ value: 1, next: null }] as const;
export function spreadTuple() { return param(...args); }              // error
declare function many(...nodes: Node[]): void;
declare const plains: { value: number; next: null }[];
export function spreadRest() { many(...plains); }                     // error
declare const plainIterable: Iterable<{ value: number; next: null }>;
export function spreadIterable() { many(...plainIterable); }          // error
declare function headThenNodes(...args: [head?: unknown, ...tail: Node[]]): void;
export function spreadTupleRest() { headThenNodes(...plains); }      // error: ordinary objects for the Node tail
// two types of one name, one of them a struct
import type { Node as OtherNode } from "./other";
declare function two(a?: OtherNode, b?: Node, ...rest: unknown[]): void;
export function sameNames() { two(...plains); }                       // error: the Node
declare const trailingPlain: [...Node[], { value: number; next: null }];
declare function headNode(...values: [head?: Node, ...tail: unknown[]]): void;
export function spreadAfterEmptyRest() { headNode(...trailingPlain); }   // error: the ordinary object may be the head
