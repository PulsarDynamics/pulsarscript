import { Lexer } from "./Lexer";
import { Parser, ParseError } from "./Parser";
import { SemanticAnalyzer, SemanticError } from "./SemanticAnalyzer";
import { BytecodeCompiler } from "./BytecodeCompiler";
import { ErrorReporter } from "./ErrorReporter";
import { linkModule } from "./Linker";
import { ImportStmt } from "./classes/ImportStmt";
import { ExportStmt } from "./classes/ExportStmt";
import { withHeader } from "./Bytecode";
import pkg from "./package.json";

// Parse command line arguments
const args = process.argv.slice(2);
const flags = {
  check: false,
  emitSourcemap: false,
  help: false,
};
const positionalArgs: string[] = [];

for (const arg of args) {
  if (arg === "--check" || arg === "-c") {
    flags.check = true;
  } else if (arg === "--emit-sourcemap" || arg === "-s") {
    flags.emitSourcemap = true;
  } else if (arg === "--help" || arg === "-h") {
    flags.help = true;
  } else if (!arg.startsWith("-")) {
    positionalArgs.push(arg);
  }
}

if (flags.help || positionalArgs.length === 0) {
  console.log(`PulsarScript Compiler

Usage: bun run compile.ts [options] <input.puls> [output.json]

Options:
  --check, -c          Check syntax and semantics only, don't emit bytecode
  --emit-sourcemap, -s Include line mapping in output
  --help, -h           Show this help message

Examples:
  bun run compile.ts script.puls                 # Compile and output
  bun run compile.ts -c script.puls              # Check syntax and semantics only
  bun run compile.ts -s script.puls out.json     # Include source map
`);
  process.exit(flags.help ? 0 : 1);
}

const inputPath = positionalArgs[0];
// PulsarScript source files end in .puls (SPEC §1). .poo was the old extension: still
// compiled, with a warning, so existing files keep working while they are renamed.
if (/\.poo$/.test(inputPath)) {
  console.warn(`warning: ${inputPath}: the .poo extension is deprecated; rename the file to .puls`);
}
const outputPath = positionalArgs[1] || inputPath.replace(/\.(puls|poo)$/, ".json") || "out.bytecode.json";

const source = await Bun.file(inputPath).text();
const reporter = new ErrorReporter(source);

try {
  const lexer = new Lexer(source);
  const tokens = lexer.scanTokens();
  const parser = new Parser(tokens);
  let stmts = parser.parse();
  let sources: string[] | undefined;
  if (stmts.some((s) => s instanceof ImportStmt || s instanceof ExportStmt)) {
    const linked = linkModule(inputPath, { entrySource: source });
    stmts = linked.statements;
    sources = linked.sources;
  }
  // Same front end as the interpreter: scoping, unknown names and call arity are checked
  // against the source before any bytecode exists (SPEC 7).
  const analyzer = new SemanticAnalyzer();
  analyzer.analyze(stmts);
  for (const w of analyzer.warnings) {
    console.warn(`warning: line ${w.line}: ${w.message}`);
  }

  if (flags.check) {
    console.log(`✓ Valid: ${inputPath}`);
    process.exit(0);
  }

  // Compile to bytecode
  const chunk = BytecodeCompiler.compile(stmts, sources);

  // Optionally strip sourcemap for smaller output
  if (!flags.emitSourcemap) {
    delete (chunk as any).lineMap;
    delete (chunk as any).fileMap;
    delete (chunk as any).sources;
  }

  // Versioned header first (SPEC §10, A5): the VM rejects formats it does not know.
  await Bun.write(outputPath, JSON.stringify(withHeader(chunk, source, pkg.version), null, 2));
  console.log(`✓ Compiled to ${outputPath}`);
  if (flags.emitSourcemap) {
    console.log(`  (includes source map with ${chunk.lineMap?.length || 0} entries)`);
  }
} catch (err: any) {
  if (err instanceof ParseError || err instanceof SemanticError) {
    const errorType = err instanceof ParseError ? "Parse" : "Semantic";
    console.error(reporter.formatError(err.token, err.message, errorType));
    process.exit(1);
  }
  console.error("Compilation error:", err.message ?? err);
  process.exit(1);
}
