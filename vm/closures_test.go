package vm

import (
	"errors"
	"strings"
	"testing"
)

func TestClosureOpcodesAndUpvalueClosing(t *testing.T) {
	// Clean explicit address layout:
	// 0: CALL makeAcc 0
	// 3: DEFINE_GLOBAL "f"
	// 5: GET_GLOBAL "f"
	// 7: CONST 1 (5)
	// 9: CALL_VALUE 1
	// 11: PRINT
	// 12: GET_GLOBAL "f"
	// 14: CONST 2 (7)
	// 16: CALL_VALUE 1
	// 18: PRINT
	// 19: HALT
	// makeAcc (addr 20): arity 0, locals 1
	// 20: CONST 3 (10)
	// 22: SET_LOCAL 0
	// 24: POP
	// 25: CLOSURE innerAddr (30)
	// 27: CLOSE_UPVALUE 0
	// 29: RETURN
	// inc (addr 30): arity 1, locals 1, upvalues: [{IsLocal: true, Index: 0}]
	// 30: GET_UPVALUE 0
	// 32: GET_LOCAL 0
	// 34: ADD
	// 35: SET_UPVALUE 0
	// 37: RETURN
	fullCode := []int{
		int(OpCall), 20, 0,
		int(OpDefineGlobal), 0,
		int(OpGetGlobal), 0,
		int(OpConst), 1,
		int(OpCallValue), 1,
		int(OpPrint),
		int(OpGetGlobal), 0,
		int(OpConst), 2,
		int(OpCallValue), 1,
		int(OpPrint),
		int(OpHalt),

		// 20: makeAcc
		int(OpConst), 3,
		int(OpSetLocal), 0,
		int(OpPop),
		int(OpClosure), 30,
		int(OpCloseUpvalue), 0,
		int(OpReturn),

		// 30: inc(x)
		int(OpGetUpvalue), 0,
		int(OpGetLocal), 0,
		int(OpAdd),
		int(OpSetUpvalue), 0,
		int(OpReturn),
	}

	funcs := map[int]FunctionInfo{
		20: {Name: "makeAcc", Address: 20, Arity: 0, Locals: 1},
		30: {Name: "inc", Address: 30, Arity: 1, Locals: 1, Upvalues: []UpvalueDesc{{IsLocal: true, Index: 0}}},
	}

	mod := Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("f"), Number(5), Number(7), Number(10)},
		Code:      fullCode,
		Functions: funcs,
		FunctionsByName: map[string]FunctionInfo{
			"makeAcc": funcs[20],
			"inc":     funcs[30],
		},
	}

	if err := VerifyModule(mod); err != nil {
		t.Fatalf("VerifyModule failed: %v", err)
	}

	var out []string
	vm := NewVM(mod, HostCallbacks{
		Print: func(v Value) { out = append(out, v.String()) },
	})
	if err := vm.Run(); err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(out) != 2 || out[0] != "15" || out[1] != "22" {
		t.Fatalf("got output %v, want [15 22]", out)
	}
}

func TestClosureCapturedStateAcrossDispatchHandler(t *testing.T) {
	// main (0):
	// 0: CALL setup 0
	// 3: POP
	// 4: HALT
	// setup (5): local 0 = 0; registerHandler("tick", closure(tick))
	// 5: CONST 1 (0)
	// 7: SET_LOCAL 0
	// 9: POP
	// 10: CONST 0 ("tick")
	// 12: CLOSURE 21
	// 14: HOST_CALL 2 ("registerHandler"), 2
	// 17: POP
	// 18: CLOSE_UPVALUE 0
	// 20: RETURN
	// tick (21): upvalue0 = upvalue0 + 1; return upvalue0
	// 21: GET_UPVALUE 0
	// 23: CONST 3 (1)
	// 25: ADD
	// 26: SET_UPVALUE 0
	// 28: RETURN
	code := []int{
		int(OpCall), 5, 0,
		int(OpPop),
		int(OpHalt),

		// 5: setup
		int(OpConst), 1,
		int(OpSetLocal), 0,
		int(OpPop),
		int(OpConst), 0,
		int(OpClosure), 21,
		int(OpHostCall), 2, 2,
		int(OpPop),
		int(OpCloseUpvalue), 0,
		int(OpReturn),

		// 21: tick
		int(OpGetUpvalue), 0,
		int(OpConst), 3,
		int(OpAdd),
		int(OpSetUpvalue), 0,
		int(OpReturn),
	}

	funcs := map[int]FunctionInfo{
		5:  {Name: "setup", Address: 5, Arity: 0, Locals: 1},
		21: {Name: "tick", Address: 21, Arity: 0, Locals: 0, Upvalues: []UpvalueDesc{{IsLocal: true, Index: 0}}},
	}

	mod := Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("tick"), Number(0), String("registerHandler"), Number(1)},
		Code:      code,
		Functions: funcs,
		FunctionsByName: map[string]FunctionInfo{
			"setup": funcs[5],
			"tick":  funcs[21],
		},
	}

	vm := NewVM(mod, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	for want := 1.0; want <= 3.0; want++ {
		res, err := vm.DispatchHandler("tick", nil)
		if err != nil {
			t.Fatalf("DispatchHandler(%v) error: %v", want, err)
		}
		if res.Kind() != KindNumber || res.Number() != want {
			t.Fatalf("DispatchHandler call %v = %v, want %v", want, res, want)
		}
	}
}

func TestClosureMemoryLimitEnforced(t *testing.T) {
	// Loop creating closures wrapped in try/catch -> uncatchable ErrMemoryLimit.
	// 0: TRY_PUSH 16
	// 2: CONST 0 ("sink")
	// 4: CLOSURE 20
	// 6: SET_GLOBAL 0 (actually DEFINE_GLOBAL pops, let's just PUSH and POP in loop? No, keep an array to retain or hit MaxHeapCount via OpClosure)
	// Wait: MaxHeapCount counts total objects or live objects? Wait: let's build an array and append closures into it so live memory & heap objects grow!
	// Simpler: loop calling makeAndDiscard inside try/catch? Let's allocate an array, then in a loop grow or store closures:
	// Actually in vm.go, OpClosure calls accountAlloc(estCollectionHeader + ..., 1+len(uvs)).
	// Wait: let's verify heap cap triggers inside try/catch when closures are kept in array.
	// 0: TRY_PUSH -> catch at 27
	// 2: NEW_ARRAY 0
	// 4: SET_GLOBAL? Let's use main -> call loopTest(arr):
	// Even simpler: top-level loop without array retention only adds live mem if kept or heap count if counted! Let's keep via local array:
	// Call runner (addr 4):
	// 0: CALL 4 0
	// 3: HALT
	// runner (addr 4): arity 0, locals 1 (local 0 = cap val = 1, local 1? Need locals: 2)
	// 4: TRY_PUSH -> catch at 25
	// 6: CLOSURE 30
	// 8: POP
	// 9: GET_LOCAL 0
	// 11: CONST 0 (1)
	// 13: ADD
	// 14: SET_LOCAL 0
	// 16: POP
	// 17: CONST 1 (1000)
	// 19: LESS
	// Wait: stack has NOTHING below! Let's re-push local 0 for comparison:
	// Let's write clean indices:
	// 0: CALL 4 0
	// 3: HALT
	// 4: TRY_PUSH 35 (catch catches and prints, shouldn't run!)
	// 6: CONST 0 (1)  ; i = 1 (actually local 0 initialized nil, set local 0 = 0)
	// Let's use constants [0]=0, [1]=1, [2]=500
	// 4: TRY_PUSH 35
	// 6: CONST 0 (0)
	// 8: SET_LOCAL 0
	// 10: POP
	// loop (11):
	// 11: GET_LOCAL 0
	// 13: CONST 2 (500)
	// 15: LESS
	// 16: JUMP_IF_FALSE 33
	// 18: POP
	// 19: NEW_ARRAY 0 -> wait, let's do CLOSURE 40, SET_LOCAL 1, POP (holds 1? No, we want retention or MaxMemoryBytes? Wait: accountAlloc adds to heapObjects & memBytes until recompute or GC).
	// Wait: look at OpClosure in vm.go: accountAlloc charges permanently unless recomputeLiveMemory shrinks it at intervals, so let's keep all closures in a local array (local 1) with ARRAY_SET!
	// Actually we can test a recursive function creating arrays + closures, OR simply local 1 = array, ARRAY_SET!
	//Wait: ArraySet pops value, index, array -> pushes array? No, check OpArraySet! Simpler: push closures onto stack? `maxStackDepth` would trigger first.
	// Let's check OpClosure allocating closure with 1 upvalue, called 50 times cleanly pushing via local array? No, even easier: use OpNewArray(1) wrapping previous array `[arr, closure]` -> 4 instructions!
	// 4: TRY_PUSH 35
	// 6: CONST 0 (0)       ; local 0 = 0 (captured by closure)
	// 8: SET_LOCAL 0
	// 10: POP
	// 11: CONST 0 (0)      ; local 1 = count (Wait: let's keep linked-list node in local 1!)
	// 13: SET_LOCAL 1
	// 15: POP
	// loop (16):
	// 16: GET_LOCAL 1
	// 18: CLOSURE 40       ; captures local 0
	// 20: NEW_ARRAY 2      ; [prev, cl] -> keeps every closure reachable in local 1!
	// 22: SET_LOCAL 1
	// 24: POP
	// 25: JUMP 16
	// catch (27):
	// 27: PRINT
	// 28: HALT
	// target 40: inner fn returning upvalue 0:
	// 40: GET_UPVALUE 0
	// 42: RETURN
	code := []int{
		int(OpCall), 4, 0,
		int(OpHalt),

		// 4: runner
		int(OpTryPush), 21, // catchIP = 6 + 21 = 27
		int(OpConst), 0,
		int(OpSetLocal), 0,
		int(OpPop),
		int(OpConst), 0,
		int(OpSetLocal), 1,
		int(OpPop),

		// 16: loop
		int(OpGetLocal), 1,
		int(OpClosure), 30,
		int(OpNewArray), 2,
		int(OpSetLocal), 1,
		int(OpPop),
		int(OpJump), -11, // target = 27 - 11 = 16

		// 27: catch (error value already pushed)
		int(OpPrint),
		int(OpPop),
		int(OpReturn),

		// 30: inner
		int(OpGetUpvalue), 0,
		int(OpReturn),
	}

	funcs := map[int]FunctionInfo{
		4:  {Name: "runner", Address: 4, Arity: 0, Locals: 2},
		30: {Name: "inner", Address: 30, Arity: 0, Locals: 0, Upvalues: []UpvalueDesc{{IsLocal: true, Index: 0}}},
	}

	mod := Module{
		Version:   BytecodeVersion,
		Constants: []Value{Number(0)},
		Code:      code,
		Functions: funcs,
		FunctionsByName: map[string]FunctionInfo{
			"runner": funcs[4],
			"inner":  funcs[30],
		},
	}

	cfg := DefaultVMConfig()
	cfg.MaxMemoryBytes = 16 * 1024 // tight 16 KiB limit
	vm := NewVMWithConfig(mod, HostCallbacks{}, cfg)
	err := vm.Run()
	if err == nil {
		t.Fatalf("expected ErrMemoryLimit, got nil")
	}
	if !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("expected ErrMemoryLimit (uncatchable by try/catch), got: %v", err)
	}
}

func TestCaughtErrorStackTrace(t *testing.T) {
	// Nested call stack inside try/catch captures error object with stack array:
	// top-level -> outer() -> closure inner() -> divide by zero
	// main (0):
	// 0: TRY_PUSH 7
	// 2: CALL 18 0       ; outer()
	// 5: POP
	// 6: TRY_POP
	// 7: HALT            ; actually jump over catch! Wait: put JUMP at 7 and catch at 9:
	// Let's lay out explicitly:
	// 0: TRY_PUSH 10
	// 2: CALL 18 0
	// 5: POP
	// 6: TRY_POP
	// 7: JUMP 17
	// 9: HALT (unused padding)
	// catch (10): error object on stack
	// 10: CONST 0 ("stack")
	// 12: OBJ_GET
	// 13: HOST_CALL 1 ("string"), 1
	// 16: PRINT
	// 17: HALT
	// outer (18): arity 0, locals 0
	// 18: CLOSURE 23
	// 20: CALL_VALUE 0
	// 22: RETURN
	// inner (23): arity 0, locals 0 -> 1 / 0
	// 23: CONST 2 (1)
	// 25: CONST 3 (0)
	// 27: DIV
	// 28: RETURN
	code := []int{
		int(OpTryPush), 8, // catchIP = 2 + 8 = 10
		int(OpCall), 18, 0,
		int(OpPop),
		int(OpTryPop),
		int(OpJump), 8, // target = 9 + 8 = 17
		int(OpHalt),

		// 10: catch
		int(OpConst), 0,
		int(OpObjGet),
		int(OpHostCall), 1, 1,
		int(OpPrint),
		int(OpHalt),

		// 18: outer
		int(OpClosure), 23,
		int(OpCallValue), 0,
		int(OpReturn),

		// 23: inner
		int(OpConst), 2,
		int(OpConst), 3,
		int(OpDiv),
		int(OpReturn),
	}

	lineMap := make([]int, len(code))
	for i := range lineMap {
		lineMap[i] = 1
	}
	lineMap[2] = 2  // outer() called at line 2
	lineMap[20] = 5 // inner() called at line 5
	lineMap[27] = 8 // 1/0 at line 8

	funcs := map[int]FunctionInfo{
		18: {Name: "outer", Address: 18, Arity: 0, Locals: 0},
		23: {Name: "<fn inner>", Address: 23, Arity: 0, Locals: 0},
	}

	mod := Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("stack"), String("string"), Number(1), Number(0)},
		Code:      code,
		LineMap:   lineMap,
		Functions: funcs,
		FunctionsByName: map[string]FunctionInfo{
			"outer":      funcs[18],
			"<fn inner>": funcs[23],
		},
	}

	var out []string
	vm := NewVM(mod, HostCallbacks{
		Print: func(v Value) { out = append(out, v.String()) },
	})
	if err := vm.Run(); err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 print output, got %v", out)
	}
	if !strings.Contains(out[0], "<fn inner>") || !strings.Contains(out[0], "outer") || !strings.Contains(out[0], "<script>") {
		t.Fatalf("unexpected stack output: %s", out[0])
	}
}
