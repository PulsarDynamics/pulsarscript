import { describe, expect, test } from "bun:test";
import { formatNumber, fromHost, stringify, toHost, toNumber, typeName, valuesEqual } from "../../Values";

// Mirrors pulsaros-api/internal/pulsarscriptvm/semantics_test.go so both runtimes pin the same rules.
describe("Values", () => {
  test("numbers print like the VM", () => {
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(formatNumber(1e21)).toBe("1e+21");
    expect(formatNumber(1.5e-7)).toBe("1.5e-7");
    expect(formatNumber(-Infinity)).toBe("-Infinity");
  });

  test("containers print with quoted strings and sorted keys", () => {
    expect(stringify([1, 'a"b', true, null, []])).toBe('[1, "a\\"b", true, nil, []]');
    const obj = new Map<string, any>([["b", 2], ["a", "x"], ["with space", new Map()], ["<tag>", 1]]);
    expect(stringify(obj)).toBe('{"<tag>": 1, a: "x", b: 2, "with space": {}}');
  });

  test("typeName", () => {
    expect([null, 1, "s", true, [], new Map()].map(typeName)).toEqual(["nil", "number", "string", "boolean", "array", "object"]);
  });

  test("structural equality", () => {
    expect(valuesEqual([1, [2]], [1, [2]])).toBe(true);
    expect(valuesEqual(new Map([["a", 1]]), new Map([["a", "1"]]))).toBe(false);
    expect(valuesEqual([], new Map())).toBe(false);
  });

  test("number() accepts decimal literals only", () => {
    expect(["42", " -3.5 ", "1e3", "", "0x10", "12px", "Infinity"].map(toNumber)).toEqual([42, -3.5, 1000, null, null, null, null]);
  });

  test("host conversion round-trips", () => {
    const v = fromHost({ a: [1, { b: null }] });
    expect(stringify(v)).toBe("{a: [1, {b: nil}]}");
    expect(toHost(v)).toEqual({ a: [1, { b: null }] });
  });
});
