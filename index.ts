import { Lexer } from "./Lexer";
import { Parser, ParseError } from "./Parser";
import { SemanticAnalyzer, SemanticError } from "./SemanticAnalyzer";
import { Interpreter, RuntimeError } from "./Interpreter";
import { ErrorReporter, formatCallStack } from "./ErrorReporter";

const source = `
print("=== Strict Mode Tests ===");
// Mixed type plus should fail in strict mode
print("About to evaluate number + string (should error in strict mode)");
// print(1 + "2"); // Uncomment to see strict-mode error
// Use concat() instead for explicit string building under strict mode
print(concat(1, "2", 3, " apples"));
// toUpper strict mode example (commented)
print("Calling toUpper with a string:");
print(toUpper("hello"));
// print(toUpper(123)); // Uncomment to see strict-mode error
// parseInt strict success & failure
print(parseInt("42", 10));
print(parseInt("42px", 10)); // should be nil
print(parseFloat("3.14"));
print(parseFloat("3.14pi")); // should be nil
print(toNumberOr("bad", 99));
print(isInteger(10));
print(isInteger(10.5));
print(isFinite(999)); // finite check

print("=== Standard Library Demo ===");
print(typeOf(123));
print(typeOf("hello"));
print(typeOf(true));
print(typeOf(nil));

print(number("42"));
print(number("not-a-number"));
print(string(55));
print(len("PulsarScript"));
print(toUpper("mixedCase"));
print(substr("hamburger", 3, 5));
print(indexOf("hello world", "world"));

print(abs(-9));
print(floor(3.9));
print(ceil(3.1));
print(round(3.5));
print(sqrt(81));
print(pow(2, 10));
print(min(10, 3));
print(max(10, 3));
print(clamp(150, 0, 100));
print(random());
print(randomInt(1, 6));

var x = 5;
print(x);

function add(a, b) {
  return a + b;
}

var result = add(10, 20);
print(result);

print("For loop test:");
for (var i = 0; i < 5; i = i + 1) {
  print(i);
}

print("Fibonacci of 10:");
function fibonacci(n) {
  if (n <= 1) {
    return n;
  }
  return fibonacci(n - 1) + fibonacci(n - 2);
}
print(fibonacci(10));
`

console.log("=== PulsarScript Interpreter ===\n");

// Create error reporter
const errorReporter = new ErrorReporter(source);

// Phase 1: Lexical Analysis
console.log("Phase 1: Lexical Analysis...");
const lexer = new Lexer(source);
const tokens = lexer.scanTokens();
if (process.env.PULSARSCRIPT_DUMP) await Bun.write("./tokens.json", JSON.stringify(tokens, null, 2));
console.log(`✓ Generated ${tokens.length} tokens\n`);

// Phase 2: Parsing
console.log("Phase 2: Parsing...");
const parser = new Parser(tokens);
let statements;
try {
    statements = parser.parse();
    if (process.env.PULSARSCRIPT_DUMP) await Bun.write("./statements.json", JSON.stringify(statements, null, 2));
    console.log(`✓ Generated ${statements.length} statements\n`);
} catch (error) {
    if (error instanceof ParseError) {
      console.error(errorReporter.formatError(error.token, error.message, 'Parse'));
      process.exit(1);
    } else {
      console.error("✗ An unexpected error occurred during parsing:", error);
      process.exit(1);
    }
}

// Phase 3: Semantic Analysis
console.log("Phase 3: Semantic Analysis...");
const analyzer = new SemanticAnalyzer();
try {
    analyzer.analyze(statements);
    console.log("✓ Semantic analysis completed successfully\n");
} catch (error) {
    if (error instanceof SemanticError) {
      console.error(errorReporter.formatError(error.token, error.message, 'Semantic'));
      process.exit(1);
    } else {
      console.error("✗ An unexpected error occurred during semantic analysis:", error);
      process.exit(1);
    }
}

// Phase 4: Interpretation (Execution)
console.log("Phase 4: Interpretation...");
console.log("=== Program Output ===\n");
// Enable strict type mode
const interpreter = new Interpreter({ strictTypes: true });
try {
    interpreter.interpret(statements);
    console.log("\n✓ Program executed successfully");
} catch (error) {
    if (error instanceof RuntimeError) {
      console.error(errorReporter.formatError(error.token, error.message, 'Runtime'));
      if (error.callStack && error.callStack.length > 0) {
        console.error(formatCallStack(error.callStack));
      }
      process.exit(1);
    } else {
      console.error("\n✗ An unexpected error occurred during execution:", error);
      process.exit(1);
    }
}