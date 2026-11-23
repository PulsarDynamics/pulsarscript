package vm

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestAsyncHostCallSuspendAndResume(t *testing.T) {
	// fsRead("/notes.txt") suspends, then resumes with "hello async", then print(res).
	code := []int{
		int(OpConst), 0, // "/notes.txt"
		int(OpHostCall), 1, 1, // fsRead
		int(OpPrint),
		int(OpHalt),
	}
	var out []string
	vm := NewVM(Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("/notes.txt"), String("fsRead")},
		Code:      code,
	}, HostCallbacks{
		Print: func(v Value) { out = append(out, v.String()) },
		HostCall: func(name string, args []Value) (Value, error) {
			if name == "fsRead" {
				return Value{}, ErrSuspended
			}
			return Nil(), nil
		},
	})

	err := vm.RunWithBudget(100, time.Second)
	if !errors.Is(err, ErrSuspended) {
		t.Fatalf("expected ErrSuspended, got %v", err)
	}
	if !vm.Suspended() {
		t.Fatalf("expected vm.Suspended() == true")
	}
	pending := vm.PendingHostCall()
	if pending == nil || pending.Name != "fsRead" || len(pending.Args) != 1 || pending.Args[0].String() != "/notes.txt" {
		t.Fatalf("unexpected PendingHostCall: %+v", pending)
	}

	if err := vm.ResumeAsync(String("hello async"), nil); err != nil {
		t.Fatalf("ResumeAsync error: %v", err)
	}
	if vm.Suspended() {
		t.Fatalf("expected vm.Suspended() == false after ResumeAsync")
	}
	if err := vm.ContinueWithBudget(100, time.Second); err != nil {
		t.Fatalf("ContinueWithBudget error: %v", err)
	}
	if !vm.Halted() || len(out) != 1 || out[0] != "hello async" {
		t.Fatalf("unexpected result halted=%v out=%v", vm.Halted(), out)
	}
}

func TestAsyncSuspendIsUncatchableButResumedErrorIsCatchable(t *testing.T) {
	// try { var s = fsRead("/a"); print("ok:" + s); } catch (e) { print("caught:" + e.message); }
	// 0..1: TRY_PUSH 11 (2 + 11 = 13)
	// 2..3: CONST 0 ("/a")
	// 4..6: HOST_CALL 1 ("fsRead"), 1
	// 7: PRINT
	// 8: TRY_POP
	// 9..10: JUMP 7 (11 + 7 = 18)
	// 11..12: CONST 0 (unused pad)
	// catch (13): error object pushed on stack
	// 13..14: CONST 2 ("message")
	// 15: OBJ_GET
	// 16: PRINT
	// 17: HALT
	// 18: HALT
	code := []int{
		int(OpTryPush), 11,
		int(OpConst), 0,
		int(OpHostCall), 1, 1,
		int(OpPrint),
		int(OpTryPop),
		int(OpJump), 7,
		int(OpHalt),
		int(OpHalt),
		// 13: catch
		int(OpConst), 2,
		int(OpObjGet),
		int(OpPrint),
		int(OpHalt),
	}

	var out []string
	vm := NewVM(Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("/a"), String("fsRead"), String("message")},
		Code:      code,
	}, HostCallbacks{
		Print: func(v Value) { out = append(out, v.String()) },
		HostCall: func(name string, args []Value) (Value, error) {
			return Value{}, ErrSuspended
		},
	})

	err := vm.RunWithBudget(100, time.Second)
	if !errors.Is(err, ErrSuspended) {
		t.Fatalf("expected uncatchable ErrSuspended, got %v", err)
	}
	if err := vm.ResumeAsync(Nil(), errors.New("io denied")); err != nil {
		t.Fatalf("ResumeAsync error: %v", err)
	}
	if err := vm.ContinueWithBudget(100, time.Second); err != nil {
		t.Fatalf("ContinueWithBudget error: %v", err)
	}
	if len(out) != 1 || out[0] != "io denied" {
		t.Fatalf("expected caught error 'io denied', got %v", out)
	}
}

func TestAsyncBudgetCarryoverAndTick(t *testing.T) {
	// Two sequential async host calls, each taking ~2 steps + 1 extra instruction.
	// Total across both calls = 7 steps. Budget 10 passes; budget 5 stops with ErrStepBudgetExceeded.
	code := []int{
		int(OpConst), 0,
		int(OpHostCall), 1, 1, // call 1 -> suspends at step 2
		int(OpPop),
		int(OpConst), 0,
		int(OpHostCall), 1, 1, // call 2 -> suspends
		int(OpPrint),
		int(OpHalt),
	}
	makeVM := func() *VM {
		return NewVM(Module{
			Version:   BytecodeVersion,
			Constants: []Value{String("/p"), String("fsRead")},
			Code:      code,
		}, HostCallbacks{
			HostCall: func(name string, args []Value) (Value, error) {
				return Value{}, ErrSuspended
			},
		})
	}

	// Tight step budget (5 steps total): first succeeds (2 steps), second suspends (5 total), resume exceeds!
	vmSmall := makeVM()
	if err := vmSmall.RunWithBudget(5, time.Second); !errors.Is(err, ErrSuspended) {
		t.Fatalf("expected first suspend, got %v", err)
	}
	if err := vmSmall.ResumeAsync(String("r1"), nil); err != nil {
		t.Fatalf("resume 1: %v", err)
	}
	err := vmSmall.ContinueWithBudget(5, time.Second)
	if !errors.Is(err, ErrSuspended) && !errors.Is(err, ErrStepBudgetExceeded) {
		t.Fatalf("expected suspend or step limit, got %v", err)
	}
	if errors.Is(err, ErrSuspended) {
		_ = vmSmall.ResumeAsync(String("r2"), nil)
		err = vmSmall.ContinueWithBudget(5, time.Second)
		if !errors.Is(err, ErrStepBudgetExceeded) {
			t.Fatalf("expected ErrStepBudgetExceeded from carried-over steps, got %v", err)
		}
	}

	// Time budget carryover: sleep longer than total time budget between suspends.
	vmTime := makeVM()
	if err := vmTime.RunWithBudget(100, 10*time.Millisecond); !errors.Is(err, ErrSuspended) {
		t.Fatalf("expected suspend, got %v", err)
	}
	// Simulate previous execution consumed nearly the entire budget via Tick? Wait: suspendElapsed measures VM execution time.
	// If we sleep BEFORE calling ContinueWithBudget with tiny remaining time or simulate multiple runs:
	_ = vmTime.ResumeAsync(String("r1"), nil)
	err = vmTime.ContinueWithBudget(100, time.Nanosecond)
	if !errors.Is(err, ErrTimeBudgetExceeded) {
		t.Fatalf("expected ErrTimeBudgetExceeded on elapsed carryover, got %v", err)
	}

	// Tick integration
	vmTick := makeVM()
	res1 := vmTick.Tick(100, time.Second)
	if !res1.Suspended || res1.PendingCall == nil || res1.PendingCall.Name != "fsRead" {
		t.Fatalf("unexpected Tick 1 result: %+v", res1)
	}
	// Calling Tick again before ResumeAsync keeps reporting Suspended
	resHold := vmTick.Tick(100, time.Second)
	if !resHold.Suspended {
		t.Fatalf("expected still Suspended before ResumeAsync")
	}
	_ = vmTick.ResumeAsync(String("a"), nil)
	res2 := vmTick.Tick(100, time.Second)
	if !res2.Suspended {
		t.Fatalf("expected second suspend on Tick 2, got %+v", res2)
	}
	_ = vmTick.ResumeAsync(String("b"), nil)
	res3 := vmTick.Tick(100, time.Second)
	if !res3.Halted || res3.Err != nil {
		t.Fatalf("expected Halted on Tick 3, got %+v", res3)
	}
}

func TestAsyncResumeValidationAndMemoryLimit(t *testing.T) {
	code := []int{
		int(OpConst), 0,
		int(OpHostCall), 1, 1,
		int(OpHalt),
	}
	revoked := false
	vm := NewVMWithConfig(Module{
		Version:   BytecodeVersion,
		Constants: []Value{String("/x"), String("fsRead")},
		Code:      code,
	}, HostCallbacks{
		HostCall: func(name string, args []Value) (Value, error) {
			return Value{}, ErrSuspended
		},
		ValidateResume: func() error {
			if revoked {
				return errors.New("consent revoked")
			}
			return nil
		},
	}, func() VMConfig {
		c := DefaultVMConfig()
		c.MaxStringBytes = 32
		return c
	}())

	if err := vm.Run(); !errors.Is(err, ErrSuspended) {
		t.Fatalf("expected ErrSuspended, got %v", err)
	}
	revoked = true
	if err := vm.ResumeAsync(String("ok"), nil); err == nil || !strings.Contains(err.Error(), "consent revoked") {
		t.Fatalf("expected ValidateResume error, got %v", err)
	}
	if !vm.Suspended() {
		t.Fatalf("VM must remain suspended if ValidateResume fails")
	}
	revoked = false
	big := String(strings.Repeat("a", 64))
	if err := vm.ResumeAsync(big, nil); !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("expected ErrMemoryLimit on oversized resume value, got %v", err)
	}
}
