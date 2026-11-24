import { readFileSync } from "node:fs";
import { lintPulsarScript, type LintDiagnostic } from "./tools/linter";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const help = args.includes("--help") || args.includes("-h");

let manifestPath: string | undefined;
let maxWarnings = Infinity;
const files: string[] = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--manifest" || a === "-m") {
    manifestPath = args[++i];
  } else if (a === "--max-warnings") {
    maxWarnings = Number(args[++i] ?? "0");
  } else if (!a.startsWith("-")) {
    files.push(a);
  }
}

if (help || files.length === 0) {
  console.log(`PulsarScript Linter (fruit lint)

Usage: bun run lint.ts [options] <file.puls...>

Options:
  --manifest, -m <path>   Path to AppManifest.json (auto-discovered by default)
  --json                  Print diagnostics as JSON
  --max-warnings <n>      Fail if warning count exceeds <n>
  --help, -h              Show this help message`);
  process.exit(help ? 0 : 1);
}

const allDiags: LintDiagnostic[] = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  allDiags.push(...lintPulsarScript(source, { filePath: file, manifestPath }));
}

const errorCount = allDiags.filter((d) => d.severity === "error").length;
const warningCount = allDiags.filter((d) => d.severity === "warning").length;

if (jsonOut) {
  console.log(JSON.stringify({ diagnostics: allDiags, errors: errorCount, warnings: warningCount }, null, 2));
} else {
  for (const d of allDiags) {
    const loc = `${d.file ?? "<input>"}:${d.line}:${d.column}`;
    console.log(`${loc}: ${d.severity} [${d.rule}] ${d.message}`);
  }
  if (allDiags.length > 0) {
    console.log(`\n${errorCount} error(s), ${warningCount} warning(s).`);
  }
}

if (errorCount > 0 || warningCount > maxWarnings) {
  process.exit(1);
}
