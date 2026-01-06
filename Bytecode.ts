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
