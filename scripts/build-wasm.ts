// Builds the Go VM as a WebAssembly binary (site/pulsarvm.wasm), pre-compresses .br/.gz,
// and copies Go's wasm_exec.js. Run: bun run build:wasm
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const REPO = resolve(import.meta.dir, "..");
const VM_DIR = join(REPO, "vm");
const SITE_DIR = join(REPO, "site");

mkdirSync(SITE_DIR, { recursive: true });

const goRootRes = Bun.spawnSync(["go", "env", "GOROOT"], { stdout: "pipe", stderr: "pipe" });
if (goRootRes.exitCode !== 0) {
  throw new Error(`go env GOROOT failed: ${goRootRes.stderr.toString()}`);
}
const goRoot = goRootRes.stdout.toString().trim();

const candidates = [
  join(goRoot, "lib", "wasm", "wasm_exec.js"),
  join(goRoot, "misc", "wasm", "wasm_exec.js"),
];
const wasmExecSrc = candidates.find((p) => existsSync(p));
if (!wasmExecSrc) {
  throw new Error(`Could not locate wasm_exec.js under GOROOT (${goRoot})`);
}

const wasmOut = join(SITE_DIR, "pulsarvm.wasm");
const buildRes = Bun.spawnSync(
  ["go", "build", "-trimpath", "-ldflags=-s -w", "-o", wasmOut, "./cmd/vmwasm"],
  {
    cwd: VM_DIR,
    env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
    stdout: "inherit",
    stderr: "inherit",
  }
);
if (buildRes.exitCode !== 0) {
  throw new Error(`GOOS=js GOARCH=wasm go build ./cmd/vmwasm failed with exit ${buildRes.exitCode}`);
}

const wasmBytes = readFileSync(wasmOut);
const brBytes = brotliCompressSync(wasmBytes, {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
});
const gzBytes = gzipSync(wasmBytes, { level: 9 });
writeFileSync(`${wasmOut}.br`, brBytes);
writeFileSync(`${wasmOut}.gz`, gzBytes);

const wasmExecDst = join(SITE_DIR, "wasm_exec.js");
copyFileSync(wasmExecSrc, wasmExecDst);

const sizeMb = (statSync(wasmOut).size / (1024 * 1024)).toFixed(2);
const gzKb = (gzBytes.byteLength / 1024).toFixed(1);
const brKb = (brBytes.byteLength / 1024).toFixed(1);
console.log(
  `Built ${wasmOut} (${sizeMb} MB raw, ${gzKb} KB gzip, ${brKb} KB brotli) and copied ${wasmExecDst}`
);
