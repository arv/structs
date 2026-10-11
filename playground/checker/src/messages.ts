// The diagnostics of the ownership checker: the codes and messages of `tsgo own check`
// (internal/diagnostics in the fork).

import { relative } from "node:path";

export const Messages = {
  UsedAfterSend: { code: 96001, text: "'{0}' cannot be used here: it was sent to '{1}' on line {2}." },
  MaybeUsedAfterSend: { code: 96002, text: "'{0}' cannot be used here: it may have been sent to '{1}' on line {2}." },
  SharesWithSent: { code: 96003, text: "'{0}' cannot be used here: it shares objects with '{1}', which was sent to '{2}' on line {3}." },
  SharesWithMaybeSent: { code: 96004, text: "'{0}' cannot be used here: it shares objects with '{1}', which may have been sent to '{2}' on line {3}." },
  Consumed: { code: 96005, text: "'{0}' was consumed by '{1}' on line {2}." },
  MaybeConsumed: { code: 96006, text: "'{0}' may have been consumed by '{1}' on line {2}." },
  SendCallerReferenced: { code: 96007, text: "'{0}' cannot be sent: it may be referenced by the caller. Declare the parameter 'Sending<T>' to take ownership." },
  SendCaptured: { code: 96008, text: "'{0}' cannot be sent: it is captured from an outer scope." },
  ReturnSendingCallerReferenced: { code: 96009, text: "'{0}' cannot be returned as 'Sending<T>': it may be referenced by the caller." },
  ChangeShared: { code: 96010, text: "Cannot change '{0}': it is a shared value, which is immutable." },
  RuntimeNeedsESModules: { code: 96014, text: "Option '{0}' can only be used when 'module' is set to 'es2015' or later." },
  StructField: { code: 96015, text: "A shared struct field must be a number, a boolean, a shared struct or a SharedArray." },
  SharedArrayElement: { code: 96016, text: "The elements of a SharedArray must be numbers, booleans or a shared struct." },
  InlineStructElement: { code: 96017, text: "The elements of a SharedArray of shared structs are stored inline: assign their fields instead." },
  OptionalChaining: { code: 96018, text: "Optional chaining is not supported on '{0}': its value is an address in the shared heap." },
  Destructured: { code: 96019, text: "'{0}' cannot be destructured here: its value is an address in the shared heap." },
  CapturedReassigned: { code: 96020, text: "'{0}' cannot be reassigned: a closure captures it, and its value is a counted address in the shared heap." },
  StoredInOrdinary: { code: 96021, text: "A value of type '{0}' cannot be stored in an ordinary array or object: reference counting cannot see it there. Use a SharedArray or a shared struct field, or a place typed 'unknown', which holds a handle." },
  LoopVariable: { code: 96022, text: "A 'for-of' or 'for-in' variable cannot have type '{0}': its value is an address in the shared heap." },
  CapturedByMember: { code: 96023, text: "'{0}' cannot be captured by a method or a class: its value is a counted address in the shared heap, which only functions and arrow functions can hold." },
  BoundByDestructuring: { code: 96024, text: "'{0}' cannot be bound by destructuring: its value is an address in the shared heap." },
  GeneratorParameter: { code: 96025, text: "A generator's parameter cannot have type '{0}': the generator runs after its caller's borrow ends." },
  UnionField: { code: 96026, text: "Field '{0}' is at different places in the shared structs of this union." },
} as const;

export type Message = (typeof Messages)[keyof typeof Messages];

export function formatMessage(message: Message, args: readonly (string | number)[]): string {
  return message.text.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)]));
}

// A diagnostic: a 1-based line and column (in UTF-16 code units, as tsc prints them), or none for a
// global diagnostic.
export interface Diagnostic {
  file: string | undefined;
  start: number;
  line: number;
  col: number;
  code: number;
  message: string;
}

// A diagnostic in tsc's plain format: `file(line,col): error TS96001: message`, the file relative to
// cwd.
export function formatDiagnostic(d: Diagnostic, cwd: string = process.cwd()): string {
  const where = d.file === undefined ? "" : `${relative(cwd, d.file).split("\\").join("/")}(${d.line},${d.col}): `;
  return `${where}error TS${d.code}: ${d.message}`;
}
