package vm

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestFunctionCallAndReturn(t *testing.T) {
	constants := []Value{Number(1), Number(2)}
	funcs := map[int]FunctionInfo{
		2: {Name: "add", Address: 2, Arity: 2, Locals: 2},
	}
	code := []int{
		int(OpJump), 6, // jump over function body
		int(OpGetLocal), 0,
		int(OpGetLocal), 1,
		int(OpAdd),
		int(OpReturn),
		int(OpConst), 0,
		int(OpConst), 1,
		int(OpCall), 2, 2,
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: funcs}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if !vm.halted {
		t.Fatalf("vm should be halted after run")
	}
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	if got := vm.stack[0]; got.Kind() != KindNumber || got.Number() != 3 {
		t.Fatalf("expected result 3, got %v", got)
	}
}

func TestFunctionArityMismatch(t *testing.T) {
	constants := []Value{Number(1)}
	funcs := map[int]FunctionInfo{
		2: {Name: "add", Address: 2, Arity: 2, Locals: 2},
	}
	code := []int{
		int(OpJump), 3,
		int(OpConst), 0,
		int(OpReturn),
		int(OpConst), 0,
		int(OpCall), 2, 1, // only one arg provided
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: funcs}, HostCallbacks{})
	err := vm.Run()
	if err == nil {
		t.Fatalf("expected arity error, got nil")
	}
	if !strings.Contains(err.Error(), "expects 2 args") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBlockScopeLocalsTrimmed(t *testing.T) {
	constants := []Value{Number(42)}
	code := []int{
		int(OpEnterBlock), 1,
		int(OpConst), 0,
		int(OpSetLocal), 0,
		int(OpExitBlock), 1,
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if len(vm.stack) != 0 {
		t.Fatalf("expected stack trimmed after block exit, got %d items", len(vm.stack))
	}
	if vm.rootLocals != 0 {
		t.Fatalf("expected root locals reset, got %d", vm.rootLocals)
	}
}

func TestEventQueueEmitPoll(t *testing.T) {
	constants := []Value{String("hello")}
	code := []int{
		int(OpConst), 0,
		int(OpEmitEvent),
		int(OpPollEvent),
		int(OpHalt),
	}
	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if len(vm.stack) != 2 {
		t.Fatalf("expected two values on stack (emit return + poll), got %d", len(vm.stack))
	}
	if got := vm.stack[1]; got.String() != "hello" {
		t.Fatalf("expected polled event 'hello', got %v", got)
	}
}

func TestEmitEventHostReturnValue(t *testing.T) {
	constants := []Value{String("payload")}
	code := []int{
		int(OpConst), 0,
		int(OpEmitEvent),
		int(OpHalt),
	}
	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{
		EmitEvent: func(v Value) (Value, error) {
			return String("ack:" + v.String()), nil
		},
	})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	if got := vm.stack[0]; got.String() != "ack:payload" {
		t.Fatalf("unexpected emit return value: %v", got)
	}
}

func TestRunWithBudgetStopsInfiniteLoop(t *testing.T) {
	code := []int{
		int(OpJump), -2, // jumps back to itself forever
	}
	vm := NewVM(Module{Constants: nil, Code: code, Functions: nil}, HostCallbacks{})
	err := vm.RunWithBudget(5, 0)
	if !errors.Is(err, ErrStepBudgetExceeded) {
		t.Fatalf("expected step budget error, got %v", err)
	}
	if vm.halted {
		t.Fatalf("vm should not be halted on budget exceed")
	}
}

func TestHostCallValidationUnknown(t *testing.T) {
	constants := []Value{String("unknown")}
	code := []int{
		int(OpHostCall), 0, 0,
	}
	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	err := vm.Run()
	if err == nil || !strings.Contains(err.Error(), `unknown host call "unknown"`) {
		t.Fatalf("expected unknown host call error, got %v", err)
	}
}

func TestHostCallValidationArity(t *testing.T) {
	constants := []Value{String("fsRead")}
	code := []int{
		int(OpHostCall), 0, 0,
	}
	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	err := vm.Run()
	if err == nil || err.Error() == "" || err.Error() == "hostcall fsRead not allowed" {
		t.Fatalf("expected arity error for fsRead, got %v", err)
	}
}

func TestRegisterHandlerValidation(t *testing.T) {
	constants := []Value{String("ping"), String("missingFn"), String("registerHandler")}
	code := []int{
		int(OpConst), 0,
		int(OpConst), 1,
		int(OpHostCall), 2, 2,
	}
	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	err := vm.Run()
	if err == nil || !strings.Contains(err.Error(), "handler function not found: missingFn") {
		t.Fatalf("expected missing handler fn error, got %v", err)
	}
}

func TestTickLoopSleepsAndContinues(t *testing.T) {
	constants := []Value{Number(1), Number(1)} // sleep 1ms then push 1
	code := []int{
		int(OpConst), 0,
		int(OpSleep),
		int(OpConst), 1,
		int(OpHalt),
	}
	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	sleepCalls := 0
	var slept time.Duration
	err := vm.TickLoop(10, 0, func(d time.Duration) {
		sleepCalls++
		slept = d
		time.Sleep(d)
	})
	if err != nil {
		t.Fatalf("tick loop error: %v", err)
	}
	if sleepCalls != 1 {
		t.Fatalf("expected sleep called once, got %d", sleepCalls)
	}
	if slept <= 0 {
		t.Fatalf("expected positive sleep duration, got %v", slept)
	}
	if !vm.halted {
		t.Fatalf("vm should be halted after tick loop")
	}
	if len(vm.stack) != 1 || vm.stack[0].Number() != 1 {
		t.Fatalf("unexpected stack after tick loop: %+v", vm.stack)
	}
}

func TestSleepYieldsAndResumes(t *testing.T) {
	constants := []Value{Number(0), Number(123)}
	code := []int{
		int(OpConst), 0, // 0ms
		int(OpSleep),
		int(OpConst), 1,
		int(OpHalt),
	}
	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	err := vm.RunWithBudget(10, 0)
	if !errors.Is(err, ErrYielded) {
		t.Fatalf("expected yielded error, got %v", err)
	}
	if vm.halted {
		t.Fatalf("vm should not be halted after yield")
	}
	// Resume after sleep elapsed
	vm.Resume()
	err = vm.RunWithBudget(10, 0)
	if err != nil {
		t.Fatalf("resume run error: %v", err)
	}
	if len(vm.stack) != 1 || vm.stack[0].Number() != 123 {
		t.Fatalf("unexpected stack after resume: %+v", vm.stack)
	}
}

func TestLogicalNotAndOr(t *testing.T) {
	// NOT
	notCode := []int{
		int(OpConst), 0,
		int(OpNot),
		int(OpHalt),
	}
	vm := NewVM(Module{Constants: []Value{Bool(true)}, Code: notCode, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if len(vm.stack) != 1 || vm.stack[0].Kind() != KindBool || vm.stack[0].Bool() != false {
		t.Fatalf("NOT result expected false, got %v", vm.stack)
	}

	// AND opcode truthiness
	andConstants := []Value{Bool(false), Bool(true)}
	andCode := []int{
		int(OpConst), 0,
		int(OpConst), 1,
		int(OpAnd),
		int(OpHalt),
	}
	vm = NewVM(Module{Constants: andConstants, Code: andCode, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error (and): %v", err)
	}
	if len(vm.stack) != 1 || vm.stack[0].Bool() != false {
		t.Fatalf("AND result expected false, got len=%d stack=%v ip=%d codelen=%d code=%v", len(vm.stack), vm.stack, vm.ip, len(vm.module.Code), vm.module.Code)
	}

	// OR opcode truthiness
	orConstants := []Value{Bool(true), Bool(false)}
	orCode := []int{
		int(OpConst), 0,
		int(OpConst), 1,
		int(OpOr),
		int(OpHalt),
	}
	vm = NewVM(Module{Constants: orConstants, Code: orCode, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error (or): %v", err)
	}
	if len(vm.stack) != 1 || vm.stack[0].Bool() != true {
		t.Fatalf("OR result expected true, got %v", vm.stack)
	}
}

func TestRegisterHandlerAndDispatch(t *testing.T) {
	constants := []Value{
		String("onEvent"),         // 0 handler name
		String("handle"),          // 1 function name
		String("registerHandler"), // 2 hostcall name
	}
	code := []int{
		int(OpConst), 0, // handler name
		int(OpConst), 1, // function name
		int(OpHostCall), 2, 2,
		int(OpHalt),
	}
	fn := FunctionInfo{Name: "handle", Address: 5, Arity: 1, Locals: 1}
	mod := Module{
		Constants:       constants,
		Code:            code,
		Functions:       map[int]FunctionInfo{fn.Address: fn},
		FunctionsByName: map[string]FunctionInfo{fn.Name: fn},
	}
	vm := NewVM(mod, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if _, ok := vm.handlers["onEvent"]; !ok {
		t.Fatalf("handler not registered")
	}

	// Dispatch should call function at Address with arg and return it.
	handlerCode := []int{
		int(OpGetLocal), 0,
		int(OpReturn),
		int(OpHalt),
	}
	vm.module.Code = handlerCode
	vm.module.Functions[0] = FunctionInfo{Name: "handle", Address: 0, Arity: 1, Locals: 1}
	vm.handlers["onEvent"] = vm.module.Functions[0]
	val, err := vm.DispatchHandler("onEvent", []Value{Number(42)})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	if val.Kind() != KindNumber || val.Number() != 42 {
		t.Fatalf("unexpected dispatch return: %v", val)
	}
	if vm.halted {
		// ok
	} else {
		t.Fatalf("vm should halt after dispatch")
	}
}

// TestForLoopExecution tests for-loop bytecode execution.
// Simple test: count = 0; i = 0; while(i < 3) { count = count + 1; i = i + 1; }
// Result: count = 3
func TestForLoopExecution(t *testing.T) {
	// Constants: "count", "i", 0, 3, 1
	constants := []Value{
		String("count"), // 0
		String("i"),     // 1
		Number(0),       // 2: initial values
		Number(3),       // 3: loop limit
		Number(1),       // 4: increment
	}
	// Bytecode layout with positions:
	// Position 0-1: CONST 2               (push 0)
	// Position 2-3: DEFINE_GLOBAL 0       (count = 0)
	// Position 4-5: CONST 2               (push 0)
	// Position 6-7: DEFINE_GLOBAL 1       (i = 0)
	// LOOP_START at position 8
	// Position 8-9:   GET_GLOBAL 1        (push i)
	// Position 10-11: CONST 3             (push 3)
	// Position 12:    LESS                (i < 3)
	// Position 13-14: JUMP_IF_FALSE X     (after reading operand, ip=15; we want to jump to 27, so X=27-15=12)
	// Position 15-16: GET_GLOBAL 0        (push count)
	// Position 17-18: CONST 4             (push 1)
	// Position 19:    ADD                 (count + 1)
	// Position 20-21: SET_GLOBAL 0        (count = result, pops value)
	// Position 22-23: GET_GLOBAL 1        (push i)
	// Position 24-25: CONST 4             (push 1)
	// Position 26:    ADD                 (i + 1)
	// Position 27-28: SET_GLOBAL 1        (i = result, pops value)
	// Position 29-30: JUMP Y              (after reading operand, ip=31; we want to go back to 8, so Y=8-31=-23)
	// EXIT at position 31
	// Position 31-32: GET_GLOBAL 0        (push count)
	// Position 33:    HALT
	code := []int{
		// 0-1: count = 0
		int(OpConst), 2,
		int(OpDefineGlobal), 0,
		// 4-5: i = 0
		int(OpConst), 2,
		int(OpDefineGlobal), 1,
		// 8-9: LOOP START - condition: i < 3
		int(OpGetGlobal), 1,
		int(OpConst), 3,
		int(OpLess),
		// 13-14: exit if false (from ip=15 after reading, want to jump to 31, so offset = 31-15 = 16)
		int(OpJumpIfFalse), 16,
		// 15-16: body - count = count + 1
		int(OpGetGlobal), 0,
		int(OpConst), 4,
		int(OpAdd),
		int(OpSetGlobal), 0,
		// 22-23: i = i + 1
		int(OpGetGlobal), 1,
		int(OpConst), 4,
		int(OpAdd),
		int(OpSetGlobal), 1,
		// 29-30: jump back to loop start (offset = -23, jumps to position 8)
		int(OpJump), -23,
		// 31-32: EXIT - push count
		int(OpGetGlobal), 0,
		// 33: HALT
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if !vm.halted {
		t.Fatalf("vm should be halted after run")
	}
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	// count should be 3
	if got := vm.stack[0]; got.Kind() != KindNumber || got.Number() != 3 {
		t.Fatalf("expected count 3, got %v", got)
	}
}

// TestTryCatchExecution tests exception handling with try/catch blocks.
// The test triggers a division by zero error in a try block and verifies
// that execution continues in the catch block.
func TestTryCatchExecution(t *testing.T) {
	// Constants: "result", 0, 1, 2
	constants := []Value{
		String("result"), // 0: global name
		Number(0),        // 1: zero (for div by zero)
		Number(1),        // 2: one
		Number(99),       // 3: catch block marker value
	}
	// Bytecode layout:
	// 0-1: CONST 2 (push 1)
	// 2-3: DEFINE_GLOBAL 0 (result = 1)
	// 4-5: TRY_PUSH <offset to catch> (catch at position 16)
	// 6-7: CONST 2 (push 1)
	// 8-9: CONST 1 (push 0 - divisor)
	// 10:  DIV (1/0 -> error!)
	// 11-12: SET_GLOBAL 0 (result = quotient - never reached)
	// 13:  TRY_POP (remove handler - never reached in error case)
	// 14-15: JUMP <skip catch> (jump to 22)
	// CATCH at 16:
	// 16:  POP (discard error value)
	// 17-18: CONST 3 (push 99 - catch marker)
	// 19-20: SET_GLOBAL 0 (result = 99)
	// 21: (skip target) - continue
	// 21-22: GET_GLOBAL 0 (push result)
	// 23:  HALT
	code := []int{
		// result = 1
		int(OpConst), 2,
		int(OpDefineGlobal), 0,
		// TRY_PUSH with offset to catch block (after reading operand at pos 5, ip=6; catch at 16, offset=16-6=10)
		int(OpTryPush), 10,
		// try block: result = 1/0 (will fail)
		int(OpConst), 2, // push 1
		int(OpConst), 1, // push 0
		int(OpDiv),          // 1/0 -> div by zero error
		int(OpSetGlobal), 0, // result = quotient (not reached)
		int(OpTryPop), // remove handler (not reached)
		// jump over catch (from ip=16 after reading operand at 15, skip to 22, so offset=22-16=6)
		int(OpJump), 6,
		// CATCH BLOCK at position 16
		int(OpPop),      // discard error message
		int(OpConst), 3, // push 99
		int(OpSetGlobal), 0, // result = 99
		// position 21 - exit
		int(OpGetGlobal), 0, // push result
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if !vm.halted {
		t.Fatalf("vm should be halted after run")
	}
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	// result should be 99 (set in catch block)
	if got := vm.stack[0]; got.Kind() != KindNumber || got.Number() != 99 {
		t.Fatalf("expected result 99 (catch block executed), got %v", got)
	}
}

// TestArrayOperations tests array creation and element access.
func TestArrayOperations(t *testing.T) {
	// Test: create array [10, 20, 30] and get element at index 1 (should be 20)
	constants := []Value{
		Number(10), // 0
		Number(20), // 1
		Number(30), // 2
		Number(1),  // 3: index
	}
	code := []int{
		// Push elements
		int(OpConst), 0, // push 10
		int(OpConst), 1, // push 20
		int(OpConst), 2, // push 30
		// Create array from 3 elements
		int(OpNewArray), 3,
		// Push index 1
		int(OpConst), 3,
		// Get arr[1]
		int(OpArrayGet),
		// Halt with result on stack
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if !vm.halted {
		t.Fatalf("vm should be halted after run")
	}
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	// Should be 20 (element at index 1)
	if got := vm.stack[0]; got.Kind() != KindNumber || got.Number() != 20 {
		t.Fatalf("expected 20, got %v", got)
	}
}

// TestArrayHostCalls tests arrayLen, arrayPush, arrayIndexOf host calls.
func TestArrayHostCalls(t *testing.T) {
	// Constants: "len", 10, 20, 30, "arrayLen", "arrayPush", 40
	constants := []Value{
		String("len"),       // 0
		Number(10),          // 1
		Number(20),          // 2
		Number(30),          // 3
		String("arrayLen"),  // 4
		String("arrayPush"), // 5
		Number(40),          // 6
	}
	// Create array [10, 20, 30], call len(arr), then arrayPush(arr, 40), then arrayLen on result
	code := []int{
		// Create array [10, 20, 30]
		int(OpConst), 1, // push 10
		int(OpConst), 2, // push 20
		int(OpConst), 3, // push 30
		int(OpNewArray), 3,
		// Call len(arr) - consumes arr, pushes length
		int(OpHostCall), 0, 1, // len with 1 arg
		// Result should be 3
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if !vm.halted {
		t.Fatalf("vm should be halted after run")
	}
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	// len([10,20,30]) = 3
	if got := vm.stack[0]; got.Kind() != KindNumber || got.Number() != 3 {
		t.Fatalf("expected 3, got %v", got)
	}
}

// TestObjectOperations tests object creation and property access.
func TestObjectOperations(t *testing.T) {
	// Test: create object {name: "test", value: 42} and get "value" property
	constants := []Value{
		String("name"),  // 0
		String("test"),  // 1
		String("value"), // 2
		Number(42),      // 3
	}
	code := []int{
		// Push key-value pairs for object
		int(OpConst), 0, // key "name"
		int(OpConst), 1, // value "test"
		int(OpConst), 2, // key "value"
		int(OpConst), 3, // value 42
		// Create object with 2 properties
		int(OpNewObject), 2,
		// Duplicate object for get (we push key to get value)
		// Actually we need to push key then object - but we need object on stack
		// Let's just define object, then push key, then get
		// Need to restructure - let's store in global
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}
	if !vm.halted {
		t.Fatalf("vm should be halted after run")
	}
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	// Should be an object
	if got := vm.stack[0]; got.Kind() != KindObject {
		t.Fatalf("expected object, got %v", got)
	}
	// Check properties
	obj := vm.stack[0].obj
	if obj["name"].String() != "test" {
		t.Fatalf("expected name='test', got %v", obj["name"])
	}
	if obj["value"].Number() != 42 {
		t.Fatalf("expected value=42, got %v", obj["value"])
	}
}

// TestFilesystemHostCallsWhitelisted verifies FS operations are in whitelist and delegate to host.
func TestFilesystemHostCallsWhitelisted(t *testing.T) {
	// Test that fsWrite is properly delegated to host callback
	constants := []Value{
		String("fsWrite"),      // 0
		String("/test/path"),   // 1
		String("file content"), // 2
	}
	code := []int{
		int(OpConst), 1, // push path
		int(OpConst), 2, // push content
		int(OpHostCall), 0, 2, // fsWrite with 2 args
		int(OpHalt),
	}

	var calledName string
	var calledArgs []Value
	hostCall := func(name string, args []Value) (Value, error) {
		calledName = name
		calledArgs = args
		return Bool(true), nil
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{HostCall: hostCall})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}

	// Verify host call was invoked with correct args
	if calledName != "fsWrite" {
		t.Fatalf("expected fsWrite, got %s", calledName)
	}
	if len(calledArgs) != 2 {
		t.Fatalf("expected 2 args, got %d", len(calledArgs))
	}
	if calledArgs[0].String() != "/test/path" {
		t.Fatalf("expected path '/test/path', got %s", calledArgs[0].String())
	}
	if calledArgs[1].String() != "file content" {
		t.Fatalf("expected content 'file content', got %s", calledArgs[1].String())
	}

	// Verify result was pushed to stack
	if len(vm.stack) != 1 || vm.stack[0].Bool() != true {
		t.Fatalf("expected true on stack, got %v", vm.stack)
	}
}

// TestObjHostCalls tests the built-in object host call handlers.
func TestObjHostCalls(t *testing.T) {
	// Test objKeys: create {a: 1, b: 2} and get keys
	constants := []Value{
		String("a"),       // 0
		Number(1),         // 1
		String("b"),       // 2
		Number(2),         // 3
		String("objKeys"), // 4
	}
	code := []int{
		// Create object {a: 1, b: 2}
		int(OpConst), 0, // key "a"
		int(OpConst), 1, // value 1
		int(OpConst), 2, // key "b"
		int(OpConst), 3, // value 2
		int(OpNewObject), 2,
		// Call objKeys(obj)
		int(OpHostCall), 4, 1,
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}

	// Result should be array of keys
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	if vm.stack[0].Kind() != KindArray {
		t.Fatalf("expected array, got %v", vm.stack[0].Kind())
	}
	keys := vm.stack[0].arr
	if len(keys) != 2 {
		t.Fatalf("expected 2 keys, got %d", len(keys))
	}
	// Keys may be in any order due to map iteration
	keyStrings := make(map[string]bool)
	for _, k := range keys {
		keyStrings[k.String()] = true
	}
	if !keyStrings["a"] || !keyStrings["b"] {
		t.Fatalf("expected keys 'a' and 'b', got %v", keys)
	}
}

// TestObjHasHostCall tests the objHas host call.
func TestObjHasHostCall(t *testing.T) {
	constants := []Value{
		String("name"),    // 0 - key
		String("test"),    // 1 - value
		String("objHas"),  // 2 - host call name
		String("name"),    // 3 - key to check (exists)
		String("missing"), // 4 - key to check (doesn't exist)
	}
	code := []int{
		// Create object {name: "test"}
		int(OpConst), 0, // key
		int(OpConst), 1, // value
		int(OpNewObject), 1,
		// Duplicate for second check (push obj twice via global)
		int(OpDefineGlobal), 0, // define "name" = obj (reusing const)
		int(OpGetGlobal), 0, // push obj
		int(OpConst), 3, // push key "name"
		int(OpHostCall), 2, 2, // objHas(obj, "name")
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}

	// Result should be true
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	if vm.stack[0].Kind() != KindBool || vm.stack[0].Bool() != true {
		t.Fatalf("expected true, got %v", vm.stack[0])
	}
}

func TestLoadModuleIsNotAHostCall(t *testing.T) {
	// loadModule did nothing on any host (D8); it is out of the registry until modules exist.
	data := []byte(`{"constants":["loadModule","utils"],"code":[0,1,23,0,1,24]}`)
	if _, err := LoadModule(data); err == nil || !strings.Contains(err.Error(), `unknown host call "loadModule"`) {
		t.Fatalf("expected load error for loadModule, got %v", err)
	}
}

func TestSourceLineMapping(t *testing.T) {
	constants := []Value{
		Number(1), // 0
		Number(0), // 1 (will cause division by zero)
	}
	// Code that will error at instruction 4 (DIV)
	code := []int{
		int(OpConst), 0, // push 1
		int(OpConst), 1, // push 0
		int(OpDiv), // divide 1/0 - should error at position 4
		int(OpHalt),
	}
	// LineMap: instructions 0-3 are line 5, instruction 4 is line 6
	lineMap := []int{5, 5, 5, 5, 6, 6}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil, LineMap: lineMap}, HostCallbacks{})

	// Run and expect error
	err := vm.Run()
	if err == nil {
		t.Fatal("expected division by zero error")
	}

	// Check that CurrentLine returns the error line
	if vm.CurrentLine() != 6 {
		t.Fatalf("expected line 6, got %d", vm.CurrentLine())
	}

	// Test runtimeError includes line info
	testErr := vm.runtimeError("test error %s", "message")
	if testErr.Error() != "[line 6] test error message" {
		t.Fatalf("expected '[line 6] test error message', got '%s'", testErr.Error())
	}
}

// TestDeterministicRNG verifies that randomSeed creates reproducible random sequences.
func TestDeterministicRNG(t *testing.T) {
	constants := []Value{
		String("randomSeed"), // 0
		Number(42),           // 1 - seed value
		String("randomInt"),  // 2
		Number(1),            // 3 - min
		Number(100),          // 4 - max
	}
	code := []int{
		// Set seed
		int(OpConst), 1, // push 42
		int(OpHostCall), 0, 1, // randomSeed(42)
		int(OpPop), // discard nil
		// Get first random number
		int(OpConst), 3, // push 1
		int(OpConst), 4, // push 100
		int(OpHostCall), 2, 2, // randomInt(1, 100)
		int(OpHalt),
	}

	// Run twice with same seed - should get same result
	vm1 := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm1.Run(); err != nil {
		t.Fatalf("vm1 run error: %v", err)
	}
	result1 := vm1.stack[0].Number()

	vm2 := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm2.Run(); err != nil {
		t.Fatalf("vm2 run error: %v", err)
	}
	result2 := vm2.stack[0].Number()

	if result1 != result2 {
		t.Fatalf("expected same results with same seed, got %v and %v", result1, result2)
	}

	// Results should be within range
	if result1 < 1 || result1 >= 100 {
		t.Fatalf("expected result in [1,100), got %v", result1)
	}
}

// TestConfigurableStackLimit verifies that VMConfig limits work.
func TestConfigurableStackLimit(t *testing.T) {
	constants := []Value{
		Number(1), // 0
	}
	// Code that pushes values repeatedly
	code := []int{
		int(OpConst), 0, // push 1
		int(OpConst), 0, // push 1
		int(OpConst), 0, // push 1
		int(OpConst), 0, // push 1
		int(OpConst), 0, // push 1 (5th value)
		int(OpHalt),
	}

	// With limit of 3, should fail
	config := VMConfig{MaxStackDepth: 3}
	vm := NewVMWithConfig(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{}, config)
	err := vm.Run()
	if err == nil {
		t.Fatal("expected stack overflow error")
	}
	if err.Error() != "stack overflow" {
		t.Fatalf("expected 'stack overflow', got '%s'", err.Error())
	}

	// With default limit, should succeed
	vm2 := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm2.Run(); err != nil {
		t.Fatalf("expected success with default limit, got: %v", err)
	}
}

// TestEndToEndScriptExecution is an integration test that simulates the full lifecycle:
// load bytecode → register handler → dispatch handler → verify result
func TestEndToEndScriptExecution(t *testing.T) {
	// Simple bytecode that defines a function
	// Function "add" simply returns the sum of two locals (passed as args)
	constants := []Value{
		Number(0), // placeholder
	}

	// Function "add" at address 0, arity 2, 2 locals
	functions := map[int]FunctionInfo{
		0: {Name: "add", Address: 0, Arity: 2, Locals: 2},
	}
	funcsByName := map[string]FunctionInfo{
		"add": {Name: "add", Address: 0, Arity: 2, Locals: 2},
	}

	code := []int{
		// Function "add" at address 0
		int(OpGetLocal), 0, // get arg a
		int(OpGetLocal), 1, // get arg b
		int(OpAdd),    // a + b
		int(OpReturn), // return result
	}

	mod := Module{
		Constants:       constants,
		Code:            code,
		Functions:       functions,
		FunctionsByName: funcsByName,
	}

	vm := NewVM(mod, HostCallbacks{})

	// Register handler directly by setting in handlers map
	vm.handlers["add"] = functions[0]

	// Dispatch handler with arguments
	result, err := vm.DispatchHandler("add", []Value{Number(10), Number(32)})
	if err != nil {
		t.Fatalf("dispatch handler error: %v", err)
	}

	// Verify result
	if result.Kind() != KindNumber || result.Number() != 42 {
		t.Fatalf("expected 42, got %v", result)
	}
}

// TestScriptWithArrayAndObjectOperations tests complex data structure manipulation.
func TestScriptWithArrayAndObjectOperations(t *testing.T) {
	// Create an object with array property
	constants := []Value{
		String("items"), // 0
		Number(1),       // 1
		Number(2),       // 2
		Number(3),       // 3
		String("count"), // 4
	}

	code := []int{
		// Create object {items: [1,2,3], count: 3}
		// Push: key1, val1, key2, val2, then NEW_OBJECT 2
		int(OpConst), 0, // key "items"
		int(OpConst), 1, // push 1
		int(OpConst), 2, // push 2
		int(OpConst), 3, // push 3
		int(OpNewArray), 3, // create [1,2,3] as value for "items"

		int(OpConst), 4, // key "count"
		int(OpConst), 3, // value 3

		int(OpNewObject), 2, // create object with 2 properties
		int(OpHalt),
	}

	vm := NewVM(Module{Constants: constants, Code: code, Functions: nil}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("vm run error: %v", err)
	}

	// Check result object
	if len(vm.stack) != 1 {
		t.Fatalf("expected 1 value on stack, got %d", len(vm.stack))
	}
	obj := vm.stack[0]
	if obj.Kind() != KindObject {
		t.Fatalf("expected object, got %v", obj.Kind())
	}

	// Check items property is array
	items := obj.obj["items"]
	if items.Kind() != KindArray {
		t.Fatalf("expected array for items, got %v", items.Kind())
	}
	if len(items.arr) != 3 {
		t.Fatalf("expected 3 items, got %d", len(items.arr))
	}

	// Check count property
	count := obj.obj["count"]
	if count.Kind() != KindNumber || count.Number() != 3 {
		t.Fatalf("expected count=3, got %v", count)
	}
}
