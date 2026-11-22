// Typed access to vm/hostapi.json, the registry of built-in functions and host calls (SPEC §8).
// The compiler and the analyzer resolve every call against it, so an unknown name is a
// compile-time error (D3) instead of a host call that fails at runtime.
import registry from "./vm/hostapi.json";

export type ParamType = string; // "any" | "number" | "string" | "boolean" | "array" | "object" | unions with "|"

export interface HostParam {
  name: string;
  type: ParamType;
  optional?: boolean;
  variadic?: boolean;
  /** For a variadic parameter: how many values it needs at least (default 0). */
  min?: number;
}

export interface HostFunction {
  name: string;
  provider: "core" | "host";
  capability?: string;
  params: HostParam[];
  returns: string;
  doc: string;
}

export const HOST_API_VERSION: number = registry.version;
export const HOST_FUNCTIONS: readonly HostFunction[] = registry.functions as HostFunction[];

const byName = new Map(HOST_FUNCTIONS.map((f) => [f.name, f]));

export function lookupHostFunction(name: string): HostFunction | undefined {
  return byName.get(name);
}

/** Accepted argument counts; max is Infinity for a variadic function. */
export function arityRange(fn: HostFunction): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const p of fn.params) {
    if (p.variadic) {
      min += p.min ?? 0;
      max = Infinity;
    } else {
      if (!p.optional) min++;
      max++;
    }
  }
  return { min, max };
}

/** "Expected 2 arguments but got 3." style message, or null when the count is accepted. */
export function arityError(fn: HostFunction, got: number): string | null {
  const { min, max } = arityRange(fn);
  if (got >= min && got <= max) return null;
  const plural = (n: number) => `${n} argument${n === 1 ? "" : "s"}`;
  const expected = min === max ? plural(min) : max === Infinity ? `at least ${plural(min)}` : `${min} to ${plural(max)}`;
  return `${fn.name}: expected ${expected} but got ${got}.`;
}
