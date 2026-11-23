package vm

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestEventsOnAndDispatchOrderWithClosures(t *testing.T) {
	// main (0):
	// 0: CONST 0 (0)
	// 2: SET_LOCAL? Wait: top-level main local 0 = 0
	// Wait: let's put setup() at addr 6:
	// 0: CALL 6 0
	// 3: POP
	// 4: HALT
	// setup (6): arity 0, locals 1 (count = 0)
	// 6: CONST 0 (0)
	// 8: SET_LOCAL 0
	// 10: POP
	// 11: CONST 1 ("tick")
	// 13: CLOSURE 30
	// 15: HOST_CALL 2 ("on"), 2
	// 18: POP
	// 19: CONST 1 ("tick")
	// 21: CLOSURE 39
	// 23: HOST_CALL 2 ("on"), 2
	// 26: POP
	// 27: CLOSE_UPVALUE 0
	// 29: RETURN
	// listener1 (30, arity 1, locals 1, upvalue local 0): count = count + payload.step; print(count)
	// Actually simpler: add 1 to upvalue0, print "first:" + string(upvalue0) + ":" + string(payload)
	// Wait: string(payload) -> HOST_CALL "string", 1! Even simpler: add 10 + arg0 -> set upvalue0 -> print(upvalue0)!
	// Let's do: listener1 (30): upvalue0 = upvalue0 + arg0; print(upvalue0); return nil
	// 30: GET_UPVALUE 0
	// 32: GET_LOCAL 0
	// 34: ADD
	// 35: SET_UPVALUE 0
	// 37: PRINT
	// 38: RETURN  (Wait: SET_UPVALUE leaves value on stack, PRINT pops it! So push CONST nil before RETURN!)
	// 38: CONST 3 (nil)
	// 40: RETURN
	// listener2 (41, arity 0, locals 0, upvalue local 0): upvalue0 = upvalue0 * 2; print(upvalue0); return nil
	// 41: GET_UPVALUE 0
	// 43: CONST 4 (2)
	// 45: MUL
	// 46: SET_UPVALUE 0
	// 48: PRINT
	// 49: CONST 3 (nil)
	// 51: RETURN
	code := []int{
		int(OpCall), 5, 0,
		int(OpPop),
		int(OpHalt),

		// 5: setup
		int(OpConst), 0,
		int(OpSetLocal), 0,
		int(OpPop),
		int(OpConst), 1,
		int(OpClosure), 29,
		int(OpHostCall), 2, 2,
		int(OpPop),
		int(OpConst), 1,
		int(OpClosure), 40,
		int(OpHostCall), 2, 2,
		int(OpPop),
		int(OpCloseUpvalue), 0,
		int(OpReturn),

		// 29: listener1(n)
		int(OpGetUpvalue), 0,
		int(OpGetLocal), 0,
		int(OpAdd),
		int(OpSetUpvalue), 0,
		int(OpPrint),
		int(OpConst), 3,
		int(OpReturn),

		// 40: listener2()
		int(OpGetUpvalue), 0,
		int(OpConst), 4,
		int(OpMul),
		int(OpSetUpvalue), 0,
		int(OpPrint),
		int(OpConst), 3,
		int(OpReturn),
	}

	funcs := map[int]FunctionInfo{
		5:  {Name: "setup", Address: 5, Arity: 0, Locals: 1},
		29: {Name: "l1", Address: 29, Arity: 1, Locals: 1, Upvalues: []UpvalueDesc{{IsLocal: true, Index: 0}}},
		40: {Name: "l2", Address: 40, Arity: 0, Locals: 0, Upvalues: []UpvalueDesc{{IsLocal: true, Index: 0}}},
	}

	var out []string
	vm := NewVM(Module{
		Version:         BytecodeVersion,
		Constants:       []Value{Number(0), String("tick"), String("on"), Nil(), Number(2)},
		Code:            code,
		Functions:       funcs,
		FunctionsByName: map[string]FunctionInfo{"setup": funcs[5], "l1": funcs[29], "l2": funcs[40]},
	}, HostCallbacks{
		Print: func(v Value) { out = append(out, v.String()) },
	})

	if err := vm.Run(); err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	names := vm.EventListenerNames()
	if len(names) != 1 || names[0] != "tick" {
		t.Fatalf("EventListenerNames = %v, want [tick]", names)
	}
	if err := vm.DispatchEvent("tick", Number(5)); err != nil {
		t.Fatalf("DispatchEvent error: %v", err)
	}
	if err := vm.DispatchEvent("tick", Number(3)); err != nil {
		t.Fatalf("DispatchEvent 2 error: %v", err)
	}
	// Dispatch unknown event is a no-op
	if err := vm.DispatchEvent("unused", Nil()); err != nil {
		t.Fatalf("DispatchEvent unused error: %v", err)
	}
	want := []string{"5", "10", "13", "26"}
	if strings.Join(out, ",") != strings.Join(want, ",") {
		t.Fatalf("got output %v, want %v", out, want)
	}
}

func TestEmitDrainYieldAndSleepNegative(t *testing.T) {
	// Test emit -> DrainEvents and yield/resume.
	var hostEvents []Value
	code := []int{
		int(OpConst), 0, // "name"
		int(OpConst), 1, // "done"
		int(OpConst), 2, // "payload"
		int(OpConst), 3, // 42
		int(OpNewObject), 2,
		int(OpEmitEvent),
		int(OpPop),
		int(OpYield),
		int(OpConst), 4, // 5 (sleep ms)
		int(OpSleep),
		int(OpHalt),
	}

	// Case 1: HostCallbacks.EmitEvent unset -> DrainEvents collects it
	vmQueue := NewVM(Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("name"), String("done"), String("payload"), Number(42), Number(5)},
		Code:      code,
	}, HostCallbacks{})
	err := vmQueue.RunWithBudget(100, 0)
	if !errors.Is(err, ErrYielded) {
		t.Fatalf("expected ErrYielded from OpYield, got %v", err)
	}
	evts := vmQueue.DrainEvents()
	if len(evts) != 1 {
		t.Fatalf("expected 1 drained event, got %d", len(evts))
	}
	nVal, ok := evts[0].objectGet("name")
	if !ok || nVal.String() != "done" {
		t.Fatalf("unexpected event name: %v", nVal)
	}
	pVal, ok := evts[0].objectGet("payload")
	if !ok || pVal.Number() != 42 {
		t.Fatalf("unexpected event payload: %v", pVal)
	}
	if len(vmQueue.DrainEvents()) != 0 {
		t.Fatalf("DrainEvents should clear queue")
	}

	vmQueue.Resume()
	err = vmQueue.RunWithBudget(100, 0)
	if !errors.Is(err, ErrYielded) {
		t.Fatalf("expected ErrYielded from OpSleep(5), got %v", err)
	}
	if rem := vmQueue.SleepRemaining(); rem <= 0 || rem > 50*time.Millisecond {
		t.Fatalf("unexpected SleepRemaining: %v", rem)
	}
	time.Sleep(8 * time.Millisecond)
	vmQueue.Resume()
	if err := vmQueue.RunWithBudget(100, 0); err != nil {
		t.Fatalf("final resume error: %v", err)
	}

	// Case 2: HostCallbacks.EmitEvent receives object directly
	vmHost := NewVM(Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("name"), String("done"), String("payload"), Number(42), Number(0)},
		Code:      code,
	}, HostCallbacks{
		EmitEvent: func(v Value) (Value, error) {
			hostEvents = append(hostEvents, v)
			return Nil(), nil
		},
	})
	_ = vmHost.RunWithBudget(100, 0)
	if len(hostEvents) != 1 {
		t.Fatalf("expected 1 HostCallbacks.EmitEvent call, got %d", len(hostEvents))
	}

	// Case 3: sleep(-1) is catchable runtime error
	vmNeg := NewVM(Module{
		Version:   BytecodeVersion,
		Constants: []Value{Number(-1)},
		Code:      []int{int(OpConst), 0, int(OpSleep), int(OpHalt)},
	}, HostCallbacks{})
	err = vmNeg.Run()
	if err == nil || !strings.Contains(err.Error(), "non-negative") {
		t.Fatalf("expected non-negative sleep error, got %v", err)
	}
}

func TestDispatchEventSharesBudget(t *testing.T) {
	// Register an infinite-loop listener on "loop"; DispatchEventWithBudget should fail with ErrStepBudgetExceeded.
	code := []int{
		int(OpConst), 0, // "loop"
		int(OpClosure), 9,
		int(OpHostCall), 1, 2, // "on"
		int(OpPop),
		int(OpHalt),
		// 9: spin(p)
		int(OpJump), -2,
	}
	funcs := map[int]FunctionInfo{
		9: {Name: "spin", Address: 9, Arity: 1, Locals: 1},
	}
	vm := NewVM(Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("loop"), String("on")},
		Code:      code,
		Functions: funcs,
	}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("Run setup failed: %v", err)
	}
	err := vm.DispatchEventWithBudget("loop", Nil(), 25, 0)
	if !errors.Is(err, ErrStepBudgetExceeded) {
		t.Fatalf("expected ErrStepBudgetExceeded, got %v", err)
	}
}
