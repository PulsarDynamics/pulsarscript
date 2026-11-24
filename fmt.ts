import { readFileSync, writeFileSync } from "node:fs";
import { ParseError } from "./Parser";
import { ErrorReporter } from "./ErrorReporter";
import { formatPulsarScript } from "./tools/formatter";

const args = process.argv.slice(2);
const check = args.includes("--check") || args.includes("-c");
const write = args.includes("--write") || args.includes("-w");
const useStdin = args.includes("--stdin");
const help = args.includes("--help") || args.includes("-h");
const files = args.filter((a) => !a.startsWith("-"));

if (help || (!useStdin && files.length === 0)) {
  console.log(`PulsarScript Formatter (fruit fmt)

Usage: bun run fmt.ts [options] <file.puls...>

Options:
  --check, -c   Exit 1 if any file is not canonically formatted
  --write, -w   Rewrite files in place
  --stdin       Read source from stdin and write formatted output to stdout
  --help, -h    Show this help message`);
  process.exit(help ? 0 : 1);
}

if (useStdin) {
  const src = await new Response(Bun.stdin.stream()).text();
  try {
    const out = formatPulsarScript(src);
    if (check) {
      process.exit(out === src ? 0 : 1);
    }
    process.stdout.write(out);
    process.exit(0);
  } catch (err: unknown) {
    if (err instanceof ParseError) {
      console.error(new ErrorReporter(src).formatError(err.token, err.message, "Parse"));
      process.exit(1);
    }
    throw err;
  }
}

let unformattedCount = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  let formatted: string;
  try {
    formatted = formatPulsarScript(src);
  } catch (err: unknown) {
    if (err instanceof ParseError) {
      console.error(`${file}: ${new ErrorReporter(src).formatError(err.token, err.message, "Parse")}`);
      process.exit(1);
    }
    throw err;
  }

  if (check) {
    if (formatted !== src) {
      console.log(file);
      unformattedCount++;
    }
  } else if (write) {
    if (formatted !== src) {
      writeFileSync(file, formatted, "utf8");
    }
  } else {
    process.stdout.write(formatted);
  }
}

if (check && unformattedCount > 0) {
  process.exit(1);
}
