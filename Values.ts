// Value model shared by the interpreter and tooling (SPEC §3).
//
//   nil     -> null
//   number  -> number
//   string  -> string
//   boolean -> boolean
//   array   -> JS array (never mutated after creation: arrays are values)
//   object  -> PulsarObject, a Map<string, value> (never mutated after creation)
//
// The Go VM (pulsaros-api/internal/pulsarscriptvm) implements the same rules; keep them in step.

export type PulsarObject = Map<string, any>;

export const isArray = (v: unknown): v is any[] => Array.isArray(v);
export const isObject = (v: unknown): v is PulsarObject => v instanceof Map;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Same pattern as the VM's numberLiteralRe; whitespace is spelled out to match Go's \s.
const NUMBER_LITERAL = /^[\t\n\f\r ]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[\t\n\f\r ]*$/;

/** Numbers print as JavaScript prints them, except that -0 prints as 0 (SPEC §3.2). */
export function formatNumber(n: number): string {
  return Object.is(n, -0) ? "0" : String(n);
}

/** Lexicographic Unicode code-point comparison matching Go UTF-8 string order. */
export function compareStringsByCodePoint(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

/** Keys in sorted code-point order, matching the Go VM's sortedKeys(). */
export function sortedKeys(o: PulsarObject): string[] {
  return [...o.keys()].sort(compareStringsByCodePoint);
}

function quote(s: string): string {
  // Matches Go's json encoding with HTML escaping off (Go also escapes U+2028 and U+2029).
  return JSON.stringify(s).replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
}

/** Form used inside containers: strings are quoted. */
function repr(v: any, show: (v: any) => string): string {
  return typeof v === "string" ? quote(v) : show(v);
}

/**
 * Printed form of a value (print, string(), concat, "+" with a string).
 * `other` formats values outside the language's types (host values, callables).
 */
export function stringify(v: any, other: (v: any) => string = String): string {
  const show = (x: any): string => stringify(x, other);
  if (v === null || v === undefined) return "nil";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (isArray(v)) return "[" + v.map((e) => repr(e, show)).join(", ") + "]";
  if (isObject(v)) {
    const parts = sortedKeys(v).map((k) => `${IDENT.test(k) ? k : quote(k)}: ${repr(v.get(k), show)}`);
    return "{" + parts.join(", ") + "}";
  }
  return other(v);
}

export function typeName(v: any): string {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return typeof v;
  if (isArray(v)) return "array";
  if (isObject(v)) return "object";
  return "function";
}

/** == compares type and value; arrays and objects compare by contents (SPEC §4.3). */
export function valuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (isArray(a) && isArray(b)) {
    return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    if (a.size !== b.size) return false;
    for (const [k, x] of a) {
      if (!b.has(k) || !valuesEqual(x, b.get(k))) return false;
    }
    return true;
  }
  return false;
}

/** number(v): numbers as-is, booleans 1/0, numeric strings parsed, anything else nil. */
export function toNumber(v: any): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && NUMBER_LITERAL.test(v)) return Number(v.trim());
  return null;
}

/** Converts a value from a host (plain JSON-like data) into language values. */
export function fromHost(v: any): any {
  if (v === undefined) return null;
  if (isArray(v)) return v.map(fromHost);
  if (isObject(v)) return v;
  if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return new Map(Object.entries(v).map(([k, x]) => [k, fromHost(x)]));
  }
  return v;
}

/** Converts a language value into plain JSON-like data for a host. */
export function toHost(v: any): any {
  if (isArray(v)) return v.map(toHost);
  if (isObject(v)) return Object.fromEntries([...v].map(([k, x]) => [k, toHost(x)]));
  return v;
}
