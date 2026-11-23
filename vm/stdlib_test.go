package vm

import (
	"errors"
	"testing"
)

func TestCallbackCountsTowardStepBudget(t *testing.T) {
	// main (0):
	// 0: CONST 0 (1)
	// 2: NEW_ARRAY 1
	// 4: CLOSURE 11
	// 6: HOST_CALL 1 ("arrayMap"), 2
	// 9: PRINT
	// 10: HALT
	// 11: JUMP -2 (infinite loop inside callback)
	code := []int{
		int(OpConst), 0,
		int(OpNewArray), 1,
		int(OpClosure), 11,
		int(OpHostCall), 1, 2,
		int(OpPrint),
		int(OpHalt),
		int(OpJump), -2,
	}
	funcs := map[int]FunctionInfo{
		11: {Name: "spin", Address: 11, Arity: 1, Locals: 1},
	}
	mod := Module{
		Version:         BytecodeVersion,
		Constants:       []Value{Number(1), String("arrayMap")},
		Code:            code,
		Functions:       funcs,
		FunctionsByName: map[string]FunctionInfo{"spin": funcs[11]},
	}

	vm := NewVM(mod, HostCallbacks{})
	err := vm.RunWithBudget(200, 0)
	if !errors.Is(err, ErrStepBudgetExceeded) {
		t.Fatalf("expected ErrStepBudgetExceeded from infinite callback loop, got %v", err)
	}
}

func TestStdlibRepeatAndJSONMemoryLimits(t *testing.T) {
	// repeat("abcdefghij", 1000) wrapped in try/catch with MaxStringBytes=1024 -> uncatchable ErrMemoryLimit.
	codeRepeat := []int{
		int(OpTryPush), 9, // catch at 11 (2+9=11)
		int(OpConst), 0, // "abcdefghij"
		int(OpConst), 1, // 1000
		int(OpHostCall), 2, 2, // "repeat"
		int(OpTryPop),
		int(OpJump), 2, // to 13
		int(OpPrint),
		int(OpHalt),
	}
	cfg := DefaultVMConfig()
	cfg.MaxStringBytes = 1024
	vm1 := NewVMWithConfig(Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("abcdefghij"), Number(1000), String("repeat")},
		Code:      codeRepeat,
		Functions: map[int]FunctionInfo{},
	}, HostCallbacks{}, cfg)
	if err := vm1.Run(); !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("expected uncatchable ErrMemoryLimit from repeat, got %v", err)
	}

	// jsonParse("[1,2,3,4,5]") with MaxCollectionLen=3 -> uncatchable ErrMemoryLimit.
	codeJSON := []int{
		int(OpTryPush), 7, // catch at 9 (2+7=9)
		int(OpConst), 0,
		int(OpHostCall), 1, 1,
		int(OpTryPop),
		int(OpJump), 2,
		int(OpPrint),
		int(OpHalt),
	}
	cfg2 := DefaultVMConfig()
	cfg2.MaxCollectionLen = 3
	vm2 := NewVMWithConfig(Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("[1,2,3,4,5]"), String("jsonParse")},
		Code:      codeJSON,
		Functions: map[int]FunctionInfo{},
	}, HostCallbacks{}, cfg2)
	if err := vm2.Run(); !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("expected uncatchable ErrMemoryLimit from jsonParse, got %v", err)
	}
}
