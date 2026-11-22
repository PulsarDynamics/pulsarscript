import { createHash } from "node:crypto";

export enum Opcode {
  CONST = 0,
  ADD = 1,
  SUB = 2,
  MUL = 3,
  DIV = 4,
  NEG = 5,
  EQUAL = 6,
  NOT_EQUAL = 7,
  GREATER = 8,
  GREATER_EQUAL = 9,
  LESS = 10,
  LESS_EQUAL = 11,
  POP = 12,
  PRINT = 13,
  DEFINE_GLOBAL = 14,
  GET_GLOBAL = 15,
  SET_GLOBAL = 16,
  GET_LOCAL = 17,
  SET_LOCAL = 18,
  JUMP = 19,
  JUMP_IF_FALSE = 20,
  CALL = 21, // operand: arg count
  RETURN = 22,
  HOST_CALL = 23, // operand: name const index, then arg count
  HALT = 24,
  ENTER_BLOCK = 25, // operand: local count to allocate
  EXIT_BLOCK = 26, // operand: local count to drop
  EMIT_EVENT = 27, // operand: none; pops payload and enqueues
  POLL_EVENT = 28, // operand: none; pushes next event or nil
  YIELD = 29, // operand: none; yields control to host
  SLEEP = 30, // operand: none; pops duration (ms) and yields
  NOT = 31,
  AND = 32,
  OR = 33,
  // Exception handling opcodes
  TRY_PUSH = 34,   // operand: catch handler offset (relative to after operand)
  TRY_POP = 35,    // remove current exception handler
  // Array opcodes
  NEW_ARRAY = 36,  // operand: element count; pops N elements, pushes array
  ARRAY_GET = 37,  // pops index, pops array, pushes element
  ARRAY_SET = 38,  // pops value, pops index, pops array; sets element (no push)
  // Object opcodes
  NEW_OBJECT = 39, // operand: property count; pops N key/value pairs, pushes object
  OBJ_GET = 40,    // pops key, pops object, pushes value
  OBJ_SET = 41,    // pops value, pops key, pops object; sets property (no push)
}

export interface FunctionEntry {
  name: string;
  address: number;
  arity: number;
  locals: number;
}

export interface Chunk {
  constants: any[];
  code: number[]; // sequence of opcodes and operands
  functions?: FunctionEntry[];
  lineMap?: number[]; // instruction index → source line number
}

/** Identifies a PulsarScript bytecode file (SPEC §10, decision A5). */
export const BYTECODE_FORMAT = "pulsarscript-bytecode";

/**
 * Bytecode format version. Bump it on any change the VM must know about (opcodes,
 * operands, file fields); the VM rejects versions it does not support.
 *   0: no header (before SPEC v0.4); still loaded.
 *   1: header {format, version, compiler, sourceHash}; otherwise the same as 0.
 */
export const BYTECODE_VERSION = 1;

export interface BytecodeHeader {
  format: typeof BYTECODE_FORMAT;
  version: number;
  /** Compiler that wrote the file, e.g. "pulsarscript 0.4.0". */
  compiler: string;
  /** "sha256:<hex>" of the UTF-8 source, so tools can tell a stale bundle. */
  sourceHash: string;
}

export type BytecodeFile = BytecodeHeader & Chunk;

export function sourceHash(source: string): string {
  return "sha256:" + createHash("sha256").update(source, "utf8").digest("hex");
}

/** The file compile.ts writes: the header first, then the chunk. */
export function withHeader(chunk: Chunk, source: string, compilerVersion: string): BytecodeFile {
  return {
    format: BYTECODE_FORMAT,
    version: BYTECODE_VERSION,
    compiler: `pulsarscript ${compilerVersion}`,
    sourceHash: sourceHash(source),
    ...chunk,
  };
}
