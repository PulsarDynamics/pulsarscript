// PulsarScript conformance runner.
//
// Every tests/conformance/**/<name>.poo has a sibling <name>.expected that holds the
// output the language SPEC requires: one line per print(), and, if the program must
// fail, a final line "!error" or "!error: <kind>" (kind = parse | semantic | runtime |
// compile | timeout). An "!error..." line matches when the actual error line starts
// with it.
//
// Each case runs on every available runtime:
//   interp  TypeScript tree-walking interpreter (tests/conformance/interp-runner.ts)
//   vm      compile.ts -> bytecode -> Go VM (`vmrun`; set PULSARSCRIPT_VMRUN or --vmrun)
//
// Directives in the leading comment block of a .poo file:
//   // @xfail <runtimes> <defect-id> <note>   runtime is known to fail this case
//   // @skip  <runtimes> <note>               do not run on that runtime
// <runtimes> is a comma-separated list of interp, vm, or "all".
//
// Exit code is non-zero when any case FAILs (unexpected failure) or XPASSes (an
// @xfail case now passes: remove the directive). Known failures (XFAIL) do not fail.
//
// Usage:
//   bun tests/conformance/run.ts [--vmrun <path>] [--require-vm] [--runtime interp|vm]
//                                [--filter <substring>] [--json <report.json>] [--verbose]

import { readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";

type Runtime = "interp" | "vm";
type Status = "pass" | "fail" | "xfail" | "xpass" | "skip";

interface Directive {
  runtimes: Runtime[];
  defect: string;
  note: string;
}
interface Case {
  file: string;
  name: string;
  expected: string[];
  xfail: Directive[];
  skip: Directive[];
}
interface Result {
  case: string;
  runtime: Runtime;
  status: Status;
  actual?: string[];
  expected?: string[];
  reason?: string;
}

const ROOT = dirname(new URL(import.meta.url).pathname);
const REPO = join(ROOT, "..", "..");
const OUT = join(ROOT, ".out");
const TIMEOUT_MS = 5000;
const ALL: Runtime[] = ["interp", "vm"];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const vmrun = opt("--vmrun") ?? process.env.PULSARSCRIPT_VMRUN;
const requireVm = flag("--require-vm");
const onlyRuntime = opt("--runtime") as Runtime | undefined;
const filter = opt("--filter");
const jsonOut = opt("--json");
const verbose = flag("--verbose");

if (requireVm && (!vmrun || !existsSync(vmrun))) {
  console.error("--require-vm given but no vmrun binary found (set PULSARSCRIPT_VMRUN or --vmrun).");
  process.exit(2);
}

function findCases(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findCases(p));
    else if (entry.endsWith(".poo")) out.push(p);
  }
  return out.sort();
}

function parseRuntimes(s: string): Runtime[] {
  if (s === "all") return [...ALL];
  return s.split(",").map((r) => {
    if (r !== "interp" && r !== "vm") throw new Error(`unknown runtime '${r}'`);
    return r;
  });
}

async function loadCase(file: string): Promise<Case> {
  const src = await Bun.file(file).text();
  const xfail: Directive[] = [];
  const skip: Directive[] = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("//")) {
      if (t === "") continue;
      break; // directives live in the leading comment block only
    }
    const m = t.match(/^\/\/\s*@(xfail|skip)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const [, kind, rts, rest] = m;
    if (kind === "xfail") {
      const [defect, ...note] = rest.split(/\s+/);
      xfail.push({ runtimes: parseRuntimes(rts), defect: defect ?? "", note: note.join(" ") });
    } else {
      skip.push({ runtimes: parseRuntimes(rts), defect: "", note: rest });
    }
  }
  const expFile = file.replace(/\.poo$/, ".expected");
  if (!existsSync(expFile)) throw new Error(`missing ${relative(REPO, expFile)}`);
  const raw = (await Bun.file(expFile).text()).replace(/\r/g, "");
  const expected = raw === "" ? [] : raw.replace(/\n$/, "").split("\n");
  return { file, name: relative(ROOT, file).replace(/\.poo$/, ""), expected, xfail, skip };
}

async function run(cmd: string[]): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { stdout, stderr, code, timedOut };
}

// Split process output into lines, keeping empty print() lines; only one trailing newline is dropped.
const lines = (s: string) => {
  const t = s.replace(/\r/g, "");
  return t === "" ? [] : t.replace(/\n$/, "").split("\n");
};

async function runInterp(c: Case): Promise<string[]> {
  const r = await run(["bun", join(ROOT, "interp-runner.ts"), c.file]);
  const out = lines(r.stdout);
  if (r.timedOut) out.push("!error: timeout");
  else if (r.code !== 0 && !out.some((l) => l.startsWith("!error"))) out.push(`!error: internal: ${lines(r.stderr).at(-1) ?? "exit " + r.code}`);
  return out;
}

async function runVm(c: Case): Promise<string[]> {
  mkdirSync(OUT, { recursive: true });
  const bc = join(OUT, c.name.replace(/[\/\\]/g, "__") + ".json");
  const comp = await run(["bun", join(REPO, "compile.ts"), "-s", c.file, bc]);
  if (comp.code !== 0 || comp.timedOut) {
    const err = comp.stderr + comp.stdout;
    const kind = /Parse Error/i.test(err) ? "parse" : /Semantic Error/i.test(err) ? "semantic" : comp.timedOut ? "timeout" : "compile";
    const msg = lines(err).filter((l) => l.trim()).find((l) => !/^\s*(\d+\s*\||\^)/.test(l)) ?? "";
    return [`!error: ${kind}: ${msg.trim()}`];
  }
  const r = await run([vmrun!, bc]);
  const out: string[] = [];
  for (const l of lines(r.stdout + (r.stderr ? "\n" + r.stderr : ""))) {
    if (l === "Execution completed successfully." || l === "") continue;
    if (l.startsWith("[print] ")) out.push(l.slice("[print] ".length));
    else if (l.startsWith("Error: ")) out.push(`!error: runtime: ${l.slice("Error: ".length)}`);
    else out.push(l);
  }
  if (r.timedOut) out.push("!error: timeout");
  return out;
}

function matches(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((e, i) => (e.startsWith("!error") ? actual[i].startsWith(e) : e === actual[i]));
}

const files = findCases(ROOT).filter((f) => !filter || f.includes(filter));
const runtimes = ALL.filter((r) => (!onlyRuntime || r === onlyRuntime) && (r !== "vm" || (vmrun && existsSync(vmrun))));
if (!runtimes.includes("vm") && (!onlyRuntime || onlyRuntime === "vm")) {
  console.log("note: vm runtime skipped (no vmrun binary; set PULSARSCRIPT_VMRUN or --vmrun)\n");
}

const results: Result[] = [];
for (const file of files) {
  const c = await loadCase(file);
  for (const rt of runtimes) {
    if (c.skip.some((d) => d.runtimes.includes(rt))) {
      results.push({ case: c.name, runtime: rt, status: "skip" });
      continue;
    }
    const actual = rt === "interp" ? await runInterp(c) : await runVm(c);
    const ok = matches(c.expected, actual);
    const xf = c.xfail.find((d) => d.runtimes.includes(rt));
    const status: Status = ok ? (xf ? "xpass" : "pass") : xf ? "xfail" : "fail";
    results.push({ case: c.name, runtime: rt, status, actual, expected: c.expected, reason: xf ? `${xf.defect} ${xf.note}`.trim() : undefined });
  }
}

const count = (rt: Runtime, s: Status) => results.filter((r) => r.runtime === rt && r.status === s).length;
const bad = results.filter((r) => r.status === "fail" || r.status === "xpass");

for (const r of results) {
  if (r.status === "pass" && !verbose) continue;
  if (r.status === "skip" && !verbose) continue;
  const tag = { pass: "PASS ", fail: "FAIL ", xfail: "XFAIL", xpass: "XPASS", skip: "SKIP " }[r.status];
  console.log(`${tag} [${r.runtime.padEnd(6)}] ${r.case}${r.reason ? `  (${r.reason})` : ""}`);
  if (r.status === "fail" || (verbose && r.status === "xfail")) {
    console.log(`        expected: ${JSON.stringify(r.expected)}`);
    console.log(`        actual:   ${JSON.stringify(r.actual)}`);
  }
  if (r.status === "xpass") console.log("        now passes: remove its @xfail directive");
}

console.log(`\n${files.length} cases`);
for (const rt of runtimes) {
  console.log(`  ${rt.padEnd(6)} pass ${count(rt, "pass")}  xfail ${count(rt, "xfail")}  fail ${count(rt, "fail")}  xpass ${count(rt, "xpass")}  skip ${count(rt, "skip")}`);
}

if (jsonOut) {
  await Bun.write(jsonOut, JSON.stringify({ cases: files.length, runtimes, results }, null, 2));
}

process.exit(bad.length ? 1 : 0);
