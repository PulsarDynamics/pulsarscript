import { expect, test } from "bun:test";
import { updateSpec } from "../../scripts/gen-hostapi-docs";

test("SPEC.md §8 matches hostapi.json (run: bun run gen:hostapi)", async () => {
  const spec = await Bun.file(new URL("../../SPEC.md", import.meta.url).pathname).text();
  expect(updateSpec(spec)).toBe(spec);
});
