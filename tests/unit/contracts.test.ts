import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOST_FUNCTIONS } from "../../HostApi";
import { HOSTAPI_CAPABILITIES, validateManifest } from "../../tools/manifest-validator";

const REPO = resolve(import.meta.dir, "..", "..");

describe("contracts (APP-04)", () => {
  test("shared AppManifest schema exists and matches VS Code schema copy", () => {
    const schemaPath = join(REPO, "contracts", "app_manifest.schema.json");
    const vscodeSchemaPath = join(REPO, "editors", "vscode", "schemas", "app-manifest.schema.json");
    expect(existsSync(schemaPath)).toBe(true);
    expect(existsSync(vscodeSchemaPath)).toBe(true);
    const schemaRaw = readFileSync(schemaPath, "utf8");
    const vscodeRaw = readFileSync(vscodeSchemaPath, "utf8");
    expect(vscodeRaw).toBe(schemaRaw);
    expect(() => JSON.parse(schemaRaw)).not.toThrow();
  });

  test("manifest fixtures validate identically for valid and invalid cases", () => {
    const dir = join(REPO, "contracts", "fixtures", "manifest");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    expect(files.filter((f) => f.startsWith("valid-")).length).toBeGreaterThanOrEqual(3);
    expect(files.filter((f) => f.startsWith("invalid-")).length).toBeGreaterThanOrEqual(4);

    for (const file of files) {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const res = validateManifest(parsed);
      if (file.startsWith("valid-")) {
        expect(res).toEqual({ valid: true, errors: [] });
      } else {
        expect(res.valid).toBe(false);
        expect(res.errors.length).toBeGreaterThan(0);
      }
    }
  });

  test("pulsar-vault AppManifest.json conforms to schema contract", () => {
    const vaultPath = join(REPO, "examples", "apps", "pulsar-vault", "AppManifest.json");
    if (!existsSync(vaultPath)) return;
    const manifest = JSON.parse(readFileSync(vaultPath, "utf8"));
    expect(validateManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  test("vm/hostapi.json entries satisfy contract invariants", () => {
    const seen = new Set<string>();
    for (const fn of HOST_FUNCTIONS) {
      expect(seen.has(fn.name)).toBe(false);
      seen.add(fn.name);
      expect(fn.doc.trim().length).toBeGreaterThan(0);
      expect(fn.returns.trim().length).toBeGreaterThan(0);
      if (fn.provider === "host") {
        expect(fn.capability).toBeDefined();
        expect(HOSTAPI_CAPABILITIES.has(fn.capability!)).toBe(true);
      } else {
        expect(fn.capability).toBeUndefined();
      }
    }
  });
});
