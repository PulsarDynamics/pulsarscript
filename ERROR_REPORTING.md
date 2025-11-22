# Enhanced Error Reporting

## Overview
Implemented comprehensive error reporting with source context, line numbers, and call stack traces for all error types (Parse, Semantic, and Runtime errors).

## Features Implemented

### 1. ErrorReporter Class
- **Location**: `ErrorReporter.ts`
- **Purpose**: Centralized error formatting with source context
- **Capabilities**:
  - Shows the error line with surrounding context (previous and next lines)
  - Displays line numbers with visual indicators
  - Adds caret (^) markers pointing to the exact error location
  - Supports Parse, Semantic, and Runtime error types

### 2. Call Stack Tracking
- **Location**: `Interpreter.ts`
- **Features**:
  - Tracks function call chain during execution
  - `pushCallFrame()` / `popCallFrame()` methods manage the stack
  - `CallFrame` interface stores function name and line number
   - Automatically managed in `PulsarFunction.call()`

### 3. Enhanced Error Classes

#### RuntimeError
- Now includes `callStack: CallFrame[]` field
- Created via `Interpreter.createRuntimeError()` which captures current call stack
- All error sites updated to use `this.createRuntimeError()` instead of `new RuntimeError()`

#### SemanticError
- Already had token information
- Now uses ErrorReporter for better formatting

#### ParseError
- Converted from generic Error to custom class with token field
- Exported from Parser for proper error handling
- Integrated with ErrorReporter

### 4. Environment Integration
- Environment class now holds reference to Interpreter
- Undefined variable and assignment errors include call stack context

## Error Output Format

### Example 1: Runtime Error with Call Stack
```
Runtime Error at line 5:
Division by zero.

     4 | function divide(a, b) {
>    5 |   return a / b;
                   ^
     6 | }


Call stack:
  at divide (line 4)
  in calculate (line 8)
```

### Example 2: Semantic Error
```
Semantic Error at line 4:
Variable is not defined.

     3 | var x = 10;
>    4 | print(y);
              ^
     5 |
```

### Example 3: Parse Error
```
Parse Error at line 5:
Expect ')' after expression.

     4 | function calculate(x, y) {
>    5 |   var result = (x + y * 2;
                                  ^
     6 |   return result;
```

## Files Modified

1. **ErrorReporter.ts** (NEW)
   - ErrorReporter class for formatting errors
   - CallFrame interface
   - formatCallStack() helper function

2. **Interpreter.ts**
   - Added `callStack: CallFrame[]` field
   - Added `pushCallFrame()` and `popCallFrame()` methods
   - Added `createRuntimeError()` method
   - Updated RuntimeError class to include callStack
   - Updated Environment to reference Interpreter for better errors
   - Updated all error throwing sites to use createRuntimeError()

3. **Parser.ts**
   - Enhanced ParseError class with token field
   - Exported ParseError for external use
   - Removed console.error calls from error() method

4. **index.ts**
   - Integrated ErrorReporter
   - Added try-catch for parse errors
   - Enhanced error display for all error types
   - Shows call stacks when available

5. **test-errors.ts** (NEW)
   - Comprehensive test suite for error reporting
   - Tests all error types: Parse, Semantic, Runtime
   - Demonstrates call stack functionality

## Benefits

1. **Developer Experience**
   - Immediately see where errors occur in source code
   - Context lines help understand the error location
   - Visual caret indicators pinpoint exact tokens

2. **Debugging**
   - Call stacks show the execution path leading to errors
   - Function names and line numbers for each stack frame
   - Easier to trace complex nested function calls

3. **Error Recovery**
   - Parser synchronization still works
   - Multiple errors can be reported in sequence
   - Clear distinction between error types

4. **Production Ready**
   - Professional error formatting
   - Consistent error output across all phases
   - Easy to extend for additional error types

## Usage

### In Main Program
```typescript
const errorReporter = new ErrorReporter(source);

try {
  // ... compilation phases ...
} catch (error) {
  if (error instanceof RuntimeError) {
    console.error(errorReporter.formatError(error.token, error.message, 'Runtime'));
    if (error.callStack?.length > 0) {
      console.error(formatCallStack(error.callStack));
    }
  }
}
```

### Testing
Run `bun run test-errors.ts` to see all error types in action.

## Future Enhancements

1. Color-coded error output (red for errors, yellow for warnings)
2. Suggestion system for common mistakes
3. Error recovery suggestions
4. IDE integration with error markers
5. Source maps for transpiled code
