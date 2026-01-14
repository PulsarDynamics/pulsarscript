#!/usr/bin/env bun
import { Lexer } from "./Lexer";
import { Parser, ParseError } from "./Parser";
import { SemanticAnalyzer, SemanticError } from "./SemanticAnalyzer";
import { Interpreter, RuntimeError } from "./Interpreter";
import { ErrorReporter, formatCallStack } from "./ErrorReporter";

// Check if stdin is a TTY (interactive terminal)
const isInteractive = process.stdin.isTTY;

// ANSI color codes for better UX
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

// Disable colors in non-interactive mode
function c(color: string): string {
  return isInteractive ? color : "";
}

class REPL {
  private interpreter: Interpreter;
  private analyzer: SemanticAnalyzer;
  private multiLineBuffer: string[] = [];
  private inMultiLineMode: boolean = false;
  private history: string[] = [];
  private strictMode: boolean = false;

  constructor() {
    this.interpreter = new Interpreter({ strictTypes: this.strictMode });
    this.analyzer = new SemanticAnalyzer();
  }

  private printWelcome(): void {
    console.log(`${c(colors.bright)}${c(colors.cyan)}╔════════════════════════════════════════════╗${c(colors.reset)}`);
    console.log(`${c(colors.bright)}${c(colors.cyan)}║     PulsarScript REPL v1.0.0                 ║${c(colors.reset)}`);
    console.log(`${c(colors.bright)}${c(colors.cyan)}╚════════════════════════════════════════════╝${c(colors.reset)}`);
    console.log(`${c(colors.dim)}Type ${c(colors.bright)}.help${c(colors.reset)}${c(colors.dim)} for available commands${c(colors.reset)}\n`);
  }

  private printHelp(): void {
    console.log(`${c(colors.bright)}${c(colors.cyan)}Available Commands:${c(colors.reset)}`);
    console.log(`  ${c(colors.green)}.help${c(colors.reset)}           - Show this help message`);
    console.log(`  ${c(colors.green)}.exit${c(colors.reset)}           - Exit the REPL`);
    console.log(`  ${c(colors.green)}.clear${c(colors.reset)}          - Clear the screen`);
    console.log(`  ${c(colors.green)}.reset${c(colors.reset)}          - Reset the interpreter state`);
    console.log(`  ${c(colors.green)}.strict [on|off]${c(colors.reset)} - Toggle strict type mode`);
    console.log(`  ${c(colors.green)}.history${c(colors.reset)}        - Show command history`);
    console.log(`  ${c(colors.green)}.multiline${c(colors.reset)}      - Enter multi-line mode (end with empty line)`);
    console.log(`\n${c(colors.bright)}${c(colors.cyan)}Language Features:${c(colors.reset)}`);
    console.log(`  • Variables: ${c(colors.yellow)}var x = 10;${c(colors.reset)}`);
    console.log(`  • Functions: ${c(colors.yellow)}function add(a, b) { return a + b; }${c(colors.reset)}`);
    console.log(`  • Control flow: ${c(colors.yellow)}if, while, for${c(colors.reset)}`);
    console.log(`  • Built-ins: ${c(colors.yellow)}typeOf, number, string, len, toUpper, substr, abs, floor, etc.${c(colors.reset)}`);
    console.log();
  }

  private processCommand(line: string): boolean {
    const trimmed = line.trim().toLowerCase();

    switch (trimmed) {
      case ".help":
        this.printHelp();
        return true;

      case ".exit":
      case ".quit":
        console.log(`${c(colors.cyan)}Goodbye!${c(colors.reset)}`);
        process.exit(0);

      case ".clear":
        console.clear();
        this.printWelcome();
        return true;

      case ".reset":
        this.interpreter = new Interpreter({ strictTypes: this.strictMode });
        this.analyzer = new SemanticAnalyzer();
        console.log(`${c(colors.green)}✓ Interpreter reset${c(colors.reset)}`);
        return true;

      case ".history":
        if (this.history.length === 0) {
          console.log(`${c(colors.dim)}No history yet${c(colors.reset)}`);
        } else {
          console.log(`${c(colors.cyan)}History:${c(colors.reset)}`);
          this.history.forEach((cmd, i) => {
            console.log(`  ${c(colors.dim)}${i + 1}.${c(colors.reset)} ${cmd}`);
          });
        }
        return true;

      case ".multiline":
        this.inMultiLineMode = true;
        console.log(`${c(colors.yellow)}Entering multi-line mode. Enter an empty line to execute.${c(colors.reset)}`);
        return true;

      default:
        if (trimmed.startsWith(".strict")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length === 1) {
            console.log(`${c(colors.cyan)}Strict mode: ${this.strictMode ? "ON" : "OFF"}${c(colors.reset)}`);
          } else if (parts[1].toLowerCase() === "on") {
            this.strictMode = true;
            this.interpreter = new Interpreter({ strictTypes: true });
            console.log(`${c(colors.green)}✓ Strict mode enabled${c(colors.reset)}`);
          } else if (parts[1].toLowerCase() === "off") {
            this.strictMode = false;
            this.interpreter = new Interpreter({ strictTypes: false });
            console.log(`${c(colors.green)}✓ Strict mode disabled${c(colors.reset)}`);
          } else {
            console.log(`${c(colors.red)}Usage: .strict [on|off]${c(colors.reset)}`);
          }
          return true;
        }
        return false;
    }
  }

  private executeCode(source: string): void {
    // Create error reporter for this source
    const errorReporter = new ErrorReporter(source);

    try {
      // Lexical Analysis
      const lexer = new Lexer(source);
      const tokens = lexer.scanTokens();

      // Parsing
      const parser = new Parser(tokens);
      let statements;
      try {
        statements = parser.parse();
      } catch (error) {
        if (error instanceof ParseError) {
          console.error(errorReporter.formatError(error.token, error.message, 'Parse'));
          return;
        }
        throw error;
      }

      // Semantic Analysis
      try {
        this.analyzer.analyze(statements);
      } catch (error) {
        if (error instanceof SemanticError) {
          console.error(errorReporter.formatError(error.token, error.message, 'Semantic'));
          return;
        }
        throw error;
      }

      // Interpretation
      try {
        this.interpreter.interpret(statements);
      } catch (error) {
        if (error instanceof RuntimeError) {
          console.error(errorReporter.formatError(error.token, error.message, 'Runtime'));
          if (error.callStack && error.callStack.length > 0) {
            console.error(formatCallStack(error.callStack));
          }
          return;
        }
        throw error;
      }
    } catch (error) {
      console.error(`${c(colors.red)}Unexpected error:${c(colors.reset)}`, error);
    }
  }

  private getPrompt(): string {
    if (this.inMultiLineMode) {
      return `${c(colors.yellow)}...${c(colors.reset)} `;
    }
    return `${c(colors.bright)}${c(colors.cyan)}»${c(colors.reset)} `;
  }

  async start(): Promise<void> {
    this.printWelcome();

    if (isInteractive) {
      // Interactive mode - use readline
      await this.runInteractive();
    } else {
      // Non-interactive mode - read from stdin
      await this.runNonInteractive();
    }
  }

  private async runInteractive(): Promise<void> {
    // For interactive mode, we'll use a simple line-by-line approach
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.getPrompt()
    });

    rl.prompt();

    rl.on('line', (line: string) => {
      const trimmed = line.trim();

      // Handle multi-line mode
      if (this.inMultiLineMode) {
        if (trimmed === "") {
          // Execute accumulated multi-line code
          const code = this.multiLineBuffer.join('\n');
          this.multiLineBuffer = [];
          this.inMultiLineMode = false;

          if (code.trim()) {
            this.history.push(code);
            this.executeCode(code);
          }
        } else {
          this.multiLineBuffer.push(line);
        }
        rl.setPrompt(this.getPrompt());
        rl.prompt();
        return;
      }

      // Skip empty lines
      if (trimmed === "") {
        rl.prompt();
        return;
      }

      // Check for commands
      if (trimmed.startsWith(".")) {
        if (this.processCommand(trimmed)) {
          rl.setPrompt(this.getPrompt());
          rl.prompt();
          return;
        }
      }

      // Add to history
      this.history.push(trimmed);

      // Execute code
      this.executeCode(trimmed);

      // Show next prompt
      rl.setPrompt(this.getPrompt());
      rl.prompt();
    });

    rl.on('close', () => {
      console.log(`\n${c(colors.cyan)}Goodbye!${c(colors.reset)}`);
      process.exit(0);
    });
  }

  private async runNonInteractive(): Promise<void> {
    const stdin = Bun.stdin.stream();
    const reader = stdin.getReader();
    const chunks: string[] = [];

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      const chunk = new TextDecoder().decode(value);
      chunks.push(chunk);
    }
    const buffer = chunks.join('');

    // Execute all accumulated input
    const lines = buffer.split('\n').filter(line => line.trim() !== "");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith(".")) {
        this.executeCode(trimmed);
      }
    }
  }
}

// Start the REPL
const repl = new REPL();
repl.start().catch((error) => {
  console.error("REPL error:", error);
  process.exit(1);
});
