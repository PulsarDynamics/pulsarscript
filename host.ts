import { Lexer } from "./Lexer";
import { Parser, ParseError } from "./Parser";
import { SemanticAnalyzer, SemanticError } from "./SemanticAnalyzer";
import { Interpreter, RuntimeError } from "./Interpreter";
import { ErrorReporter, formatCallStack } from "./ErrorReporter";
import type { InterpreterOptions } from "./Interpreter";

export interface RunResult {
  success: boolean;
  interpreter?: Interpreter;
  error?: string;
}

/**
 * createInterpreter creates an Interpreter configured with host-provided bridges (ipc/io/modules).
 */
export function createInterpreter(options?: InterpreterOptions): Interpreter {
  return new Interpreter(options);
}

/**
 * runSource compiles and executes PulsarScript source with optional host bridges.
 * Returns success/error; does not throw on parse/semantic/runtime errors.
 */
export function runSource(source: string, options?: InterpreterOptions): RunResult {
  const reporter = new ErrorReporter(source);
  try {
    const lexer = new Lexer(source);
    const tokens = lexer.scanTokens();
    const parser = new Parser(tokens);
    const statements = parser.parse();
    const analyzer = new SemanticAnalyzer();
    analyzer.analyze(statements);
    const interpreter = new Interpreter(options);
    interpreter.interpret(statements);
    return { success: true, interpreter };
  } catch (err: any) {
    if (err instanceof ParseError || err instanceof SemanticError) {
      return { success: false, error: reporter.formatError(err.token, err.message, err instanceof ParseError ? "Parse" : "Semantic") };
    }
    if (err instanceof RuntimeError) {
      let msg = reporter.formatError(err.token, err.message, "Runtime");
      if (err.callStack && err.callStack.length > 0) {
        msg += "\n" + formatCallStack(err.callStack);
      }
      return { success: false, error: msg };
    }
    return { success: false, error: err?.message ?? String(err) };
  }
}
