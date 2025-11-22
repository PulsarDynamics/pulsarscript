import { Lexer } from "./Lexer";
import { Parser, ParseError } from "./Parser";
import { SemanticAnalyzer, SemanticError } from "./SemanticAnalyzer";
import { Interpreter, RuntimeError } from "./Interpreter";
import { ErrorReporter, formatCallStack } from "./ErrorReporter";

// Test 1: Division by zero with call stack
const test1 = `
print("=== Test 1: Division by Zero ===");

function divide(a, b) {
  return a / b;
}

function calculate(x, y) {
  var result = divide(x, y);
  return result;
}

print(calculate(10, 0));
`;

// Test 2: Undefined variable (semantic error)
const test2 = `
print("=== Test 2: Undefined Variable ===");
var x = 10;
print(y);
`;

// Test 3: Type error in strict mode
const test3 = `
print("=== Test 3: Strict Mode Type Error ===");
var result = 1 + "hello";
print(result);
`;

// Test 4: Wrong number of arguments with call stack
const test4 = `
print("=== Test 4: Arity Error ===");

function greet(name, age) {
  print("Hello " + name);
  print("Age: " + age);
}

function processUser(username) {
  greet(username);
}

processUser("Alice");
`;

// Test 5: Parse error - missing closing parenthesis
const test5 = `
print("=== Test 5: Parse Error ===");

function calculate(x, y) {
  var result = (x + y * 2;
  return result;
}

print(calculate(5, 3));
`;

function runTest(name: string, source: string, strictMode: boolean = false) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running: ${name}`);
  console.log("=".repeat(60));
  
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
    const analyzer = new SemanticAnalyzer();
    try {
      analyzer.analyze(statements);
    } catch (error) {
      if (error instanceof SemanticError) {
        console.error(errorReporter.formatError(error.token, error.message, 'Semantic'));
        return;
      }
      throw error;
    }
    
    // Interpretation
    const interpreter = new Interpreter({ strictTypes: strictMode });
    try {
      interpreter.interpret(statements);
      console.log("\n✓ Test completed successfully");
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
    console.error("Unexpected error:", error);
  }
}

// Run all tests
runTest("Division by Zero with Call Stack", test1, true);
runTest("Undefined Variable (Semantic Error)", test2, false);
runTest("Strict Mode Type Error", test3, true);
runTest("Wrong Number of Arguments", test4, false);
runTest("Parse Error - Missing Parenthesis", test5, false);

console.log(`\n${"=".repeat(60)}`);
console.log("All error reporting tests completed!");
console.log("=".repeat(60));
