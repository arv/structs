// A shared struct value used as another struct type: TypeScript relates the two
// by their members, the runtime reads each field at its place. The fork does
// not compare layouts.
import { f64, i32, ref, struct, SharedArray, type StructType } from "threads";

interface Node { value: number; next: Node | null }
const Node = struct<Node>({ value: f64, next: ref<Node>() });
// Node's fields after one of its own: not laid out as a Node
interface Child extends Node { extra: number }
const Child = struct<Child>({ extra: f64, value: f64, next: ref<Child>() });
// Node's fields first: laid out as a Node, and more
interface Leaf extends Node { depth: number }
const Leaf = struct<Leaf>({ value: f64, next: ref<Leaf>(), depth: f64 });
interface A { x: number; y: number }
interface B { y: number; x: number }
const A = struct<A>({ x: f64, y: f64 });
const B = struct<B>({ y: f64, x: f64 });
interface Count { n: number }
interface Index { n: i32 }                      // the field typed as the i32 it is
const Count = struct<Count>({ n: f64 });
const Index = struct<Index>({ n: i32 });

declare const flag: boolean;
declare function use(...xs: unknown[]): void;

export function asNode(): Node { return new Child(); }                  // error
export function param(n: Node) { return n.value; }
export function call() { return param(new Child()); }                   // error
export function viaConst() { const n: Node = new Child(); return n; }   // error
export function branch() { const n: Node = flag ? new Node() : new Child(); return n; }  // error, the Child
export function swapped(): A { return new B(); }                        // error: x and y swapped
export function kinds(): Count { return new Index(); }                  // error: an i32 for an f64
export function arrays(): SharedArray<Node> { return new SharedArray(Child, 4); }  // error
export function store(n: Node, c: Child) { n.next = c; use(n); }        // error

export function prefix(): Node { return new Leaf(); }                   // fine: Node's fields first
export function same(): Node { return new Node(); }                     // fine
export function nullable(): Node | null { return flag ? new Leaf() : null; }  // fine
export function leafArrays(): SharedArray<Leaf> { return new SharedArray(Leaf, 4); }  // fine
export function downcast(n: Node) { return (n as Leaf).depth; }           // fine: a Leaf lays out a Node's fields first
export function badDowncast(n: Node) { return (n as Child).extra; }       // error: a Child does not

export function andRight(child: Child | null): Node | null { return child && new Node(); }  // fine: the left is never the result
export function nullableArrays(): SharedArray<Node> | null { return new SharedArray(Child, 4); }  // error
interface Twice { a: number; b: number }
const Twice = struct<Twice>({ a: f64, b: f64 });
const TwiceAgain = struct<Twice>({ b: f64, a: f64 });             // error: the same type, laid out otherwise
const TwiceSame = struct<Twice>({ a: f64, b: f64 });              // fine: the same layout
export { Twice, TwiceAgain, TwiceSame };
// a union of arrays: the elements must be laid out as those of one the value's
// elements can be, not of any
export function mixedArrays(): SharedArray<Node> | SharedArray<number> { return new SharedArray(Child, 4); }  // error
export function mixedNodeArrays(): SharedArray<Node> | SharedArray<number> { return new SharedArray(Node, 4); }  // fine
// a function used as one of another type: what it returns is taken for what
// that one returns, and what that one is called with is passed to it
function makeChild() { return new Child(); }
function makeLeaf() { return new Leaf(); }
function readNode(n: Node) { return n.value; }
export const makeNode: () => Node = makeChild;                          // error
export const makeNodeOfLeaf: () => Node = makeLeaf;                     // fine: a Leaf lays out a Node's fields first
export const readChild: (c: Child) => number = readNode;               // error: a Child passed as a Node
export const readLeaf: (l: Leaf) => number = readNode;                 // fine
export function take(make: () => Node) { return make(); }
export function passMaker() { return take(makeChild); }                 // error
// a reference field: what it refers to is read as what the other's refers to
interface ChildBox { item: Child | null }
const ChildBox = struct<ChildBox>({ item: ref<Child>() });
interface NodeBox { item: Node | null }
const NodeBox = struct<NodeBox>({ item: ref<Node>() });
interface LeafBox { item: Leaf | null }
const LeafBox = struct<LeafBox>({ item: ref<Leaf>() });
export function boxes(): NodeBox { return new ChildBox(); }             // error: its item is a Child
export function leafBoxes(): NodeBox { return new LeafBox(); }          // fine
// an overloaded function: the overload TypeScript takes for the place's
declare function overloaded(x: string): Child;
declare function overloaded(x: number): Node;
export const fromOverloads: (x: string) => Node = overloaded;          // error
export const fromOtherOverload: (x: number) => Node = overloaded;      // fine
// a function deep in functions
declare function deep(): () => () => () => Child;
export const deeply: () => () => () => () => Node = deep;              // error
// one type's struct declared again, its fields the type's, its markers other
interface Measure { n: number }
const Measure = struct<Measure>({ n: f64 });                           // error: the type keeps the i32 one below
const MeasureAgain = struct<Measure>({ n: i32 });
export { Measure, MeasureAgain, NodeBox };
// a falsy alternative: the struct is what reaches the place
declare const childOrZero: Child | 0;
export const orNode: Node = childOrZero || new Node();                 // error: the Child
// a union of functions: each may be the one called
declare const makers: (() => Child) | (() => Node);
export const maker: () => Node = makers;                               // error
// a promise of a struct: what it resolves to
declare function makeChildLater(): Promise<Child>;
declare function makeLeafLater(): Promise<Leaf>;
export const later: () => Promise<Node> = makeChildLater;              // error
export const promised: Promise<Node> = makeChildLater();               // error
export const leafLater: () => Promise<Node> = makeLeafLater;           // fine
// an operand that cannot be the result is not checked
export function deadRight(n: Node): Node { return n || new Child(); }  // fine: a Node is truthy
export function deadNullish(n: Node): Node { return n ?? new Child(); }  // fine: a Node is not null
export function liveNullish(n: Node | null): Node { return n ?? new Child(); }  // error: the Child
// a constructor: what it constructs
export const Make: StructType<Node> = Child;                           // error
export const MakeLeaf: StructType<Node> = Leaf;                        // fine
// an overload of another arity, which TypeScript does not take
declare function arity(x: string, y: number): Child;
declare function arity(x: string): Node;
export const byArity: (x: string) => Node = arity;                     // fine: TypeScript takes the second
