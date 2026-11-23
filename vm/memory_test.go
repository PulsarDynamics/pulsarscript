package vm

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestMemoryLimitConfigDefaultsAndPresets(t *testing.T) {
	def := DefaultVMConfig()
	if def.MaxStringBytes != DefaultMaxStringBytes || def.MaxCollectionLen != DefaultMaxCollectionLen || def.MaxMemoryBytes != DefaultMaxMemoryBytes || def.MaxHeapCount != DefaultMaxHeapCount {
		t.Fatalf("unexpected DefaultVMConfig: %+v", def)
	}
	rpc := RPCVMConfig()
	if rpc.MaxSteps != 250_000 || rpc.MaxDuration != 1500*time.Millisecond || rpc.MaxStringBytes != 1<<20 || rpc.MaxCollectionLen != 100_000 || rpc.MaxMemoryBytes != 16<<20 {
		t.Fatalf("unexpected RPCVMConfig: %+v", rpc)
	}
	svc := ServiceVMConfig()
	if svc.MaxStringBytes != 4<<20 || svc.MaxCollectionLen != 100_000 || svc.MaxMemoryBytes != 64<<20 {
		t.Fatalf("unexpected ServiceVMConfig: %+v", svc)
	}
}

func TestMemoryLimitStringDoublingUncatchable(t *testing.T) {
	// try { s = "a"; loop { s = s + s } } catch (e) { print("caught") }
	// Local slot 0 holds s.
	code := []int{
		int(OpTryPush), 11, // catch at 2+11=13
		int(OpConst), 0, // "a"
		int(OpSetLocal), 0,
		int(OpPop),
		int(OpGetLocal), 0, // loop start at index 7
		int(OpGetLocal), 0,
		int(OpAdd),
		int(OpSetLocal), 0,
		int(OpJump), -10, // wait: jump target below
	}
	// Let's write explicit clean IP offsets:
	// 0: CONST 0 ("a")
	// 2: SET_LOCAL 0
	// 4: POP
	// 5: TRY_PUSH <to 19>  (operand at 6; after read ip=7 -> offset=12)
	// loopStart = 7:
	// 7: GET_LOCAL 0
	// 9: GET_LOCAL 0
	// 11: ADD
	// 12: SET_LOCAL 0
	// 14: POP
	// 15: JUMP <to 7> (after read ip=17 -> offset=-10)
	// 17: TRY_POP
	// 18: HALT
	// catchEntry = 19:
	// 19: POP (err)
	// 20: CONST 1 ("caught")
	// 22: PRINT
	// 23: HALT
	code = []int{
		int(OpConst), 0,
		int(OpSetLocal), 0,
		int(OpPop),
		int(OpTryPush), 12,
		int(OpGetLocal), 0,
		int(OpGetLocal), 0,
		int(OpAdd),
		int(OpSetLocal), 0,
		int(OpPop),
		int(OpJump), -10,
		int(OpTryPop),
		int(OpHalt),
		int(OpPop),
		int(OpConst), 1,
		int(OpPrint),
		int(OpHalt),
	}
	lineMap := make([]int, len(code))
	for i := range lineMap {
		lineMap[i] = 4
	}
	mod := Module{
		Constants: []Value{String("a"), String("caught")},
		Code:      code,
		LineMap:   lineMap,
	}
	var printed []string
	cfg := DefaultVMConfig()
	cfg.MaxStringBytes = 1024 // 1 KiB
	vm := NewVMWithConfig(mod, HostCallbacks{Print: func(v Value) { printed = append(printed, v.String()) }}, cfg)
	err := vm.Run()
	if !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("expected ErrMemoryLimit, got %v", err)
	}
	var mle *MemoryLimitError
	if !errors.As(err, &mle) || mle.Line != 4 {
		t.Fatalf("expected MemoryLimitError at line 4, got %T %v", err, err)
	}
	if len(printed) != 0 {
		t.Fatalf("MemoryLimit must not be caught; printed=%v", printed)
	}
}

func TestMemoryLimitCollectionElementCap(t *testing.T) {
	// NEW_ARRAY with 5 elements under MaxCollectionLen=3
	code := []int{
		int(OpConst), 0,
		int(OpConst), 0,
		int(OpConst), 0,
		int(OpConst), 0,
		int(OpConst), 0,
		int(OpNewArray), 5,
		int(OpHalt),
	}
	cfg := DefaultVMConfig()
	cfg.MaxCollectionLen = 3
	vm := NewVMWithConfig(Module{Constants: []Value{Number(1)}, Code: code}, HostCallbacks{}, cfg)
	if err := vm.Run(); !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("expected ErrMemoryLimit for NEW_ARRAY over cap, got %v", err)
	}

	// arrayPush exceeding cap
	pushCode := []int{
		int(OpConst), 0, // array [1, 2, 3]
		int(OpConst), 1, // 4
		int(OpHostCall), 2, 2, // arrayPush
		int(OpHalt),
	}
	vm2 := NewVMWithConfig(Module{
		Constants: []Value{Array([]Value{Number(1), Number(2), Number(3)}), Number(4), String("arrayPush")},
		Code:      pushCode,
	}, HostCallbacks{}, cfg)
	if err := vm2.Run(); !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("expected ErrMemoryLimit for arrayPush over cap, got %v", err)
	}
}

func TestMemoryLimitLiveMemoryAndTransientGC(t *testing.T) {
	// Overwriting the same local with a 500B string 200 times stays within a 32 KiB live limit
	// because old strings become unreachable and recomputeLiveMemory drops them.
	// 0: CONST 0 (300B string)
	// 2: CONST 1 (300B string)
	// 4: ADD (600B string, < MaxStringBytes 1024)
	// 6: SET_LOCAL 0
	// 8: POP
	// 9: CONST 2 (counter) -> use GET_LOCAL 1 + 1 ... actually simpler: run 200 iterations
	code := []int{
		int(OpConst), 0, // count = 0
		int(OpSetLocal), 1,
		int(OpPop),
		// loop at 5: GET_LOCAL 1; CONST 1 (200); LESS; JUMP_IF_FALSE -> end
		int(OpGetLocal), 1,
		int(OpConst), 1,
		int(OpLess),
		int(OpJumpIfFalse), 19, // target = 11+19 = 30
		// 11: CONCAT two 250B strings -> local 0
		int(OpConst), 2,
		int(OpConst), 2,
		int(OpAdd),
		int(OpSetLocal), 0,
		int(OpPop),
		// 19: local 1 = local 1 + 1
		int(OpGetLocal), 1,
		int(OpConst), 3,
		int(OpAdd),
		int(OpSetLocal), 1,
		int(OpPop),
		// 27: JUMP -> 5 (after reading offset at 28, ip=29 -> offset = 5-29 = -24)
		int(OpJump), -24,
		// 29?? Wait let's count carefully!
	}
	_ = code
	// Count exact indices cleanly:
	var c []int
	emit := func(vals ...int) int { pos := len(c); c = append(c, vals...); return pos }
	emit(int(OpConst), 0, int(OpSetLocal), 1, int(OpPop))
	loop := len(c)
	emit(int(OpGetLocal), 1, int(OpConst), 1, int(OpLess))
	jif := emit(int(OpJumpIfFalse), 0)
	emit(int(OpConst), 2, int(OpConst), 2, int(OpAdd), int(OpSetLocal), 0, int(OpPop))
	emit(int(OpGetLocal), 1, int(OpConst), 3, int(OpAdd), int(OpSetLocal), 1, int(OpPop))
	jmp := emit(int(OpJump), 0)
	c[jmp+1] = loop - (jmp + 2)
	end := len(c)
	c[jif+1] = end - (jif + 2)
	emit(int(OpHalt))

	chunk250 := strings.Repeat("a", 250)
	cfg := DefaultVMConfig()
	cfg.MaxStringBytes = 1024
	cfg.MaxMemoryBytes = 16 * 1024 // cumulative = 200*516 = 103 KiB > 16 KiB, but live ~516 B!
	vm := NewVMWithConfig(Module{
		Constants: []Value{Number(0), Number(200), String(chunk250), Number(1)},
		Code:      c,
	}, HostCallbacks{}, cfg)
	if err := vm.Run(); err != nil {
		t.Fatalf("transient allocations in loop should not fail live limit: %v", err)
	}
}

func TestMemoryLimitHostCallReturnCounted(t *testing.T) {
	code := []int{
		int(OpConst), 1, // "file.txt"
		int(OpHostCall), 0, 1,
		int(OpHalt),
	}
	cfg := DefaultVMConfig()
	cfg.MaxStringBytes = 100
	vm := NewVMWithConfig(Module{
		Constants: []Value{String("fsRead"), String("file.txt")},
		Code:      code,
	}, HostCallbacks{
		HostCall: func(name string, args []Value) (Value, error) {
			return String(strings.Repeat("x", 150)), nil
		},
	}, cfg)
	if err := vm.Run(); !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("expected ErrMemoryLimit on oversized host call return, got %v", err)
	}
}
