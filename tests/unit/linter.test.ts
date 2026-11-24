import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOST_FUNCTIONS } from "../../HostApi";
import { lintPulsarScript } from "../../tools/linter";

const REPO = resolve(import.meta.dir, "..", "..");
const FIXTURES = join(REPO, "tests", "fixtures", "lint");

function lintFixture(relPath: string) {
  const full = join(FIXTURES, relPath);
  return lintPulsarScript(readFileSync(full, "utf8"), { filePath: full });
}

describe("linter (DX-02)", () => {
  test("no-unused-vars: passing and failing fixtures", () => {
    expect(lintFixture("unused-pass.puls")).toEqual([]);
    const diags = lintFixture("unused-fail.puls");
    const unused = diags.filter((d) => d.rule === "no-unused-vars");
    expect(unused.map((d) => d.message)).toEqual([
      "Variable 'deadVar' is declared but never used.",
      "Function 'deadHelper' is declared but never used.",
      "Parameter 'unusedParam' is declared but never used.",
    ]);
  });

  test("no-shadow: passing and failing fixtures", () => {
    expect(lintFixture("shadow-pass.puls")).toEqual([]);
    const diags = lintFixture("shadow-fail.puls");
    const shadows = diags.filter((d) => d.rule === "no-shadow");
    expect(shadows.length).toBe(2);
    expect(shadows[0].message).toContain("'value' shadows");
    expect(shadows[1].message).toContain("'arg' shadows");
  });

  test("no-unknown-host-call: passing and failing fixtures", () => {
    expect(lintFixture("unknown-host-pass.puls")).toEqual([]);
    const diags = lintFixture("unknown-host-fail.puls");
    expect(diags).toHaveLength(1);
    expect(diags[0].rule).toBe("no-unknown-host-call");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("nonExistentHostCall");
  });

  test("missing-capability: checks AppManifest.json permissions.scopes", () => {
    expect(lintFixture("capability-pass/main.puls")).toEqual([]);
    const diags = lintFixture("capability-fail/main.puls");
    expect(diags).toHaveLength(1);
    expect(diags[0].rule).toBe("missing-capability");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("fsWrite");
    expect(diags[0].message).toContain("fs.write");
  });

  test("wrong-arity, unreachable-code, and deprecated-host-call", () => {
    const customRegistry = HOST_FUNCTIONS.map((f) =>
      f.name === "emitEvent" ? { ...f, deprecated: "use emit(name, payload)" } : f
    );
    const src = `function pair(a, b) {
  return a + b;
  print("unreachable");
}
emitEvent("hi");
print(pair(1));
print(len(1, 2));
`;
    const diags = lintPulsarScript(src, { registry: customRegistry });
    const rules = diags.map((d) => d.rule);
    expect(rules).toContain("unreachable-code");
    expect(rules).toContain("deprecated-host-call");
    expect(rules).toContain("wrong-arity");
    expect(diags.filter((d) => d.rule === "wrong-arity")).toHaveLength(2);
  });

  test("pulsar-vault scripts pass unknown-host/arity checks and detect missing window capability", () => {
    const vaultScript = join(REPO, "examples", "apps", "pulsar-vault", "scripts", "main.puls");
    if (!existsSync(vaultScript)) return;
    const diags = lintPulsarScript(readFileSync(vaultScript, "utf8"), { filePath: vaultScript });
    const nonCapErrors = diags.filter((d) => d.severity === "error" && d.rule !== "missing-capability");
    expect(nonCapErrors).toEqual([]);
    const capErrors = diags.filter((d) => d.rule === "missing-capability");
    expect(capErrors.map((d) => d.message)).toEqual([
      "'notifyWindow' requires capability 'window', which is not listed in AppManifest.json permissions.scopes.",
    ]);
  });

  test("CLI lint.ts returns JSON diagnostics and exits non-zero on errors", () => {
    const passRes = Bun.spawnSync(
      ["bun", "run", join(REPO, "lint.ts"), "--json", join(FIXTURES, "capability-pass/main.puls")],
      { cwd: REPO }
    );
    expect(passRes.exitCode).toBe(0);
    const passJson = JSON.parse(passRes.stdout.toString());
    expect(passJson.errors).toBe(0);

    const failRes = Bun.spawnSync(
      ["bun", "run", join(REPO, "lint.ts"), "--json", join(FIXTURES, "capability-fail/main.puls")],
      { cwd: REPO }
    );
    expect(failRes.exitCode).toBe(1);
    const failJson = JSON.parse(failRes.stdout.toString());
    expect(failJson.errors).toBe(1);
    expect(failJson.diagnostics[0].rule).toBe("missing-capability");
  });
});
