// The state of one check of a program: the API host, the runtime module's files, the caches of the
// layout and counting rules, and the diagnostics reported so far (the fork's *Checker, as far as the
// ownership checker uses it).

import type { SourceFile } from "typescript/ast";
import type { Host, Type } from "./host.ts";
import { formatMessage } from "./messages.ts";
import type { Diagnostic, Message } from "./messages.ts";
import { errorStart } from "./syntax.ts";
import type { Node } from "./syntax.ts";

// How a shared struct's field holds its value (printer.OwnFieldKind): f an f64, r a reference, b a
// boolean, s a string, i an i32, u a u8, c a channel; "" in a union of structs, where the fields differ.
export type FieldKind = "f" | "r" | "b" | "s" | "i" | "u" | "c" | "";

// A shared struct: its name, fields in slot order, and how each holds its value.
export interface StructInfo {
  decl: Node | undefined;
  name: string;
  fields: string[];
  kinds: FieldKind[];
}

// How a value is converted where it flows (printer.OwnConversion).
export const Conversion = { None: 0, Box: 1, Unbox: 2, Zero: 3 } as const;
export type Conversion = (typeof Conversion)[keyof typeof Conversion];

// The layout kind of a type (printer.OwnCellType).
export const CellKind = {
  None: 0, Struct: 1, ArrayOfNumber: 2, ArrayOfStruct: 3, ArrayOfBoolean: 4, ArrayOfString: 5, ArrayOfI32: 6, ArrayOfU8: 7,
} as const;
export type CellKind = (typeof CellKind)[keyof typeof CellKind];
export interface CellType {
  kind: CellKind;
  fields: string[];
  kinds: FieldKind[];
}

// Reports whether a layout is a SharedArray's.
export const isArrayKind = (kind: CellKind): boolean => kind >= CellKind.ArrayOfNumber;

// The counted variables that functions capture, for a file.
export interface CaptureInfo {
  captured: Set<unknown>; // symbols referenced from a function other than the declaring one
  members: Node[]; // references to counted locals of another function from a method or a class
}

export class Own {
  readonly host: Host;
  readonly runtime: string;
  readonly runtimeFiles: readonly SourceFile[];
  readonly runtimePaths: ReadonlySet<string>;
  readonly files: readonly SourceFile[];
  readonly diagnostics: Diagnostic[] = [];

  readonly runtimeTypes = new Map<string, Type | undefined>();
  structs: Map<Type, Node> | undefined;
  readonly structCalls = new Map<Node, StructInfo | undefined>();
  readonly structUnions = new Map<Type, StructInfo | undefined>();
  readonly conversions = new Map<Node, Conversion>();
  readonly captures = new Map<SourceFile, CaptureInfo>();
  readonly cellTypes = new Map<Type, boolean>();
  readonly structOfType = new Map<Type, StructInfo | undefined>();
  readonly sharedArrayElements = new Map<Type, Type | undefined>();
  readonly runtimeExportNames = new Map<unknown, string>();
  readonly cellBranded = new Map<Type, boolean>();
  // the runtime's integer types, by type: "i" for i32, "u" for u8, "" for any other
  readonly integerKinds = new Map<Type, FieldKind>();
  // local variables (by symbolId), by whether every value assigned to them is an integer; and the
  // files whose variables are computed (false while they are being computed)
  readonly integerVariables = new Map<number, boolean>();
  readonly integerFiles = new Map<SourceFile, boolean>();

  // files: the source files to check (not declaration files); runtimeFiles: the files that the
  // runtime specifier resolves to.
  constructor(host: Host, runtime: string, runtimeFiles: readonly SourceFile[], files: readonly SourceFile[]) {
    this.host = host;
    this.runtime = runtime;
    this.runtimeFiles = runtimeFiles;
    this.runtimePaths = new Set(runtimeFiles.map((f) => f.path as string));
    this.files = files;
  }

  isRuntimePath(path: string | undefined): boolean {
    return path !== undefined && this.runtimePaths.has(path);
  }

  error(node: Node, message: Message, ...args: (string | number)[]): void {
    const file = node.getSourceFile();
    const start = errorStart(file, node);
    const { line, character } = file.getLineAndCharacterOfPosition(start);
    this.diagnostics.push({
      file: file.fileName,
      start,
      line: line + 1,
      col: character + 1,
      code: message.code,
      message: formatMessage(message, args),
    });
  }
}
