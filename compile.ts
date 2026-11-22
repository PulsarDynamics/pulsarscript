import { Lexer } from "./Lexer";
import { Parser, ParseError } from "./Parser";
import { SemanticAnalyzer, SemanticError } from "./SemanticAnalyzer";
import { BytecodeCompiler } from "./BytecodeCompiler";
import { ErrorReporter } from "./ErrorReporter";
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

Usage: bun run compile.ts [options] <input.poo> [output.json]

Options:
  --check, -c          Check syntax and semantics only, don't emit bytecode
  --emit-sourcemap, -s Include line mapping in output
  --help, -h           Show this help message

Examples:
  bun run compile.ts script.poo                  # Compile and output
  bun run compile.ts -c script.poo               # Check syntax only
  bun run compile.ts -s script.poo out.json      # Include source map
`);
  process.exit(flags.help ? 0 : 1);
}

const inputPath = positionalArgs[0];
const outputPath = positionalArgs[1] || inputPath.replace(/\.poo$/, ".json").replace(/\.ps$/, ".json") || "out.bytecode.json";

const source = await Bun.file(inputPath).text();
const reporter = new ErrorReporter(source);

try {
  const lexer = new Lexer(source);
  const tokens = lexer.scanTokens();
  const parser = new Parser(tokens);
  const stmts = parser.parse();
  // Same front end as the interpreter: scoping, unknown names and call arity are checked
  // against the source before any bytecode exists (SPEC 7).
  new SemanticAnalyzer().analyze(stmts);

  if (flags.check) {
    console.log(`✓ Valid: ${inputPath}`);
    process.exit(0);
  }

  // Compile to bytecode
  const chunk = BytecodeCompiler.compile(stmts);

  // Optionally strip sourcemap for smaller output
  if (!flags.emitSourcemap) {
    delete (chunk as any).lineMap;
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
