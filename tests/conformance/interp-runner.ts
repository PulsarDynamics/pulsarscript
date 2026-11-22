// Runs one .poo file through the TypeScript tree-walking interpreter and prints
// program output in the conformance format:
//   - every print() line as-is
//   - on failure, a final line "!error: <kind>: <message>" where kind is
//     parse | semantic | runtime | internal
// Usage: bun tests/conformance/interp-runner.ts <file.poo>
import { Lexer } from "../../Lexer";
import { Parser, ParseError } from "../../Parser";
import { SemanticAnalyzer, SemanticError } from "../../SemanticAnalyzer";
import { Interpreter, RuntimeError } from "../../Interpreter";

const file = process.argv[2];
if (!file) {
  console.error("usage: interp-runner.ts <file.poo>");
  process.exit(2);
}

const source = await Bun.file(file).text();
const oneLine = (s: unknown) => String(s).split("\n")[0];

try {
  const tokens = new Lexer(source).scanTokens();
  const statements = new Parser(tokens).parse();
  new SemanticAnalyzer().analyze(statements);
  new Interpreter().interpret(statements);
} catch (err: any) {
  const kind =
    err instanceof ParseError
      ? "parse"
      : err instanceof SemanticError
        ? "semantic"
        : err instanceof RuntimeError
          ? "runtime"
          : "internal";
  console.log(`!error: ${kind}: ${oneLine(err?.message ?? err)}`);
}
