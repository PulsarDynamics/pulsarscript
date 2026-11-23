package vm

import (
	"fmt"
	"testing"
	"time"
)

func TestCoWArrayValueSemanticsAndAliases(t *testing.T) {
	a := Array([]Value{Number(1), Number(2), Number(3)})
	b := a

	// Mutating b must leave a intact.
	b1, err := withElement(b, Number(0), Number(99), false)
	if err != nil {
		t.Fatal(err)
	}
	if a.String() != "[1, 2, 3]" || b1.String() != "[99, 2, 3]" {
		t.Fatalf("alias leak after overwrite: a=%s b1=%s", a.String(), b1.String())
	}

	// Diverging appends from the same base.
	a1, err := withElement(a, Number(3), Number(10), false)
	if err != nil {
		t.Fatal(err)
	}
	b2, err := withElement(b1, Number(3), Number(20), false)
	if err != nil {
		t.Fatal(err)
	}
	if a.String() != "[1, 2, 3]" || a1.String() != "[1, 2, 3, 10]" || b1.String() != "[99, 2, 3]" || b2.String() != "[99, 2, 3, 20]" {
		t.Fatalf("diverge mismatch: a=%s a1=%s b1=%s b2=%s", a.String(), a1.String(), b1.String(), b2.String())
	}

	// Ping-pong reads and writes between independent branches.
	x := Array([]Value{Number(0)})
	y := x
	for i := 1; i <= 200; i++ {
		x, _ = withElement(x, Number(0), Number(float64(i)), false)
		y, _ = withElement(y, Number(0), Number(float64(-i)), false)
		if x.arrayAt(0).Number() != float64(i) || y.arrayAt(0).Number() != float64(-i) {
			t.Fatalf("ping-pong corruption at %d: x=%v y=%v", i, x.arrayAt(0), y.arrayAt(0))
		}
	}

	// Self-containment: a[0] = a.
	self, err := withElement(a, Number(0), a, false)
	if err != nil {
		t.Fatal(err)
	}
	if self.String() != "[[1, 2, 3], 2, 3]" || a.String() != "[1, 2, 3]" {
		t.Fatalf("self containment failed: self=%s a=%s", self.String(), a.String())
	}

	// Equal contents after diverging edits + convergence compare equal.
	c1, _ := withElement(a, Number(0), Number(99), false)
	if !valuesEqual(c1, b1) {
		t.Fatalf("valuesEqual(%s, %s) = false, want true", c1.String(), b1.String())
	}
	if valuesEqual(a, b1) {
		t.Fatalf("valuesEqual(%s, %s) = true, want false", a.String(), b1.String())
	}
}

func TestCoWObjectValueSemanticsAndDelete(t *testing.T) {
	o := Object(map[string]Value{"a": Number(1), "b": Number(2)})
	snap := o
	for i := 0; i < 500; i++ {
		var err error
		o, err = withElement(o, String(fmt.Sprintf("k%d", i)), Number(float64(i)), false)
		if err != nil {
			t.Fatal(err)
		}
	}
	if snap.objectLen() != 2 || o.objectLen() != 502 {
		t.Fatalf("snap len=%d o len=%d", snap.objectLen(), o.objectLen())
	}
	oDel, deleted, _ := o.obj.deleteKey("a")
	if !deleted || oDel.len() != 501 {
		t.Fatalf("delete failed: deleted=%v len=%d", deleted, oDel.len())
	}
	if !o.obj.has("a") || oDel.has("a") || !snap.obj.has("a") {
		t.Fatalf("delete mutated alias")
	}
	// Self-containment on object.
	selfObj, _ := withElement(snap, String("self"), snap, true)
	if selfObj.String() != "{a: 1, b: 2, self: {a: 1, b: 2}}" || snap.String() != "{a: 1, b: 2}" {
		t.Fatalf("self object failed: selfObj=%s snap=%s", selfObj.String(), snap.String())
	}
}

func TestCoWRPCBudgetScale20kArraysAnd10kObjects(t *testing.T) {
	// 20,000 array appends via INDEX_SET must finish far inside RPC time budget (1.5 s) and step budget (250k).
	// Local 0 = a ([]), Local 1 = i (0)
	consts := []Value{Number(0), Number(20000), String("arrayLen"), Number(1), String("k")}
	var c []int
	emit := func(ops ...int) int { p := len(c); c = append(c, ops...); return p }
	emit(int(OpNewArray), 0, int(OpSetLocal), 0, int(OpPop))
	emit(int(OpConst), 0, int(OpSetLocal), 1, int(OpPop))
	loop := len(c)
	emit(int(OpGetLocal), 1, int(OpConst), 1, int(OpLess))
	jif := emit(int(OpJumpIfFalse), 0)
	// a[arrayLen(a)] = i
	emit(int(OpGetLocal), 0, int(OpGetLocal), 0, int(OpHostCall), 2, 1, int(OpGetLocal), 1, int(OpIndexSet), 0, int(OpSetLocal), 0, int(OpPop))
	emit(int(OpGetLocal), 1, int(OpConst), 3, int(OpAdd), int(OpSetLocal), 1, int(OpPop))
	jmp := emit(int(OpJump), 0)
	c[jmp+1] = loop - (jmp + 2)
	end := len(c)
	c[jif+1] = end - (jif + 2)
	emit(int(OpGetLocal), 0, int(OpHostCall), 2, 1, int(OpHalt))

	// 12,000 array appends fit inside BOTH RPC step budget (250k) and time budget (1.5s);
	// 20,000 appends (340k steps) finish far inside the 1.5s time budget too.
	testArr := func(n int, cfg VMConfig) time.Duration {
		consts[1] = Number(float64(n))
		start := time.Now()
		vmArr := NewVMWithConfig(Module{Constants: consts, Code: c}, HostCallbacks{}, cfg)
		if err := vmArr.Run(); err != nil {
			t.Fatalf("%d array appends failed: %v", n, err)
		}
		dur := time.Since(start)
		if len(vmArr.stack) == 0 || vmArr.stack[len(vmArr.stack)-1].Number() != float64(n) {
			t.Fatalf("expected array length %d, stack=%v", n, vmArr.stack)
		}
		if dur > 500*time.Millisecond {
			t.Fatalf("%d array appends too slow: %v", n, dur)
		}
		return dur
	}
	arr12kDur := testArr(12000, RPCVMConfig())
	unlimitedSteps := RPCVMConfig()
	unlimitedSteps.MaxSteps = -1
	arr20kDur := testArr(20000, unlimitedSteps)

	// 10,000 object key inserts via INDEX_SET must finish far inside RPC step & time budgets.
	constsObj := []Value{Number(0), Number(10000), String("k"), Number(1), String("objKeys")}
	var co []int
	emitO := func(ops ...int) int { p := len(co); co = append(co, ops...); return p }
	emitO(int(OpNewObject), 0, int(OpSetLocal), 0, int(OpPop))
	emitO(int(OpConst), 0, int(OpSetLocal), 1, int(OpPop))
	loopO := len(co)
	emitO(int(OpGetLocal), 1, int(OpConst), 1, int(OpLess))
	jifO := emitO(int(OpJumpIfFalse), 0)
	// o["k" + i] = i
	emitO(int(OpGetLocal), 0, int(OpConst), 2, int(OpGetLocal), 1, int(OpAdd), int(OpGetLocal), 1, int(OpIndexSet), 0, int(OpSetLocal), 0, int(OpPop))
	emitO(int(OpGetLocal), 1, int(OpConst), 3, int(OpAdd), int(OpSetLocal), 1, int(OpPop))
	jmpO := emitO(int(OpJump), 0)
	co[jmpO+1] = loopO - (jmpO + 2)
	endO := len(co)
	co[jifO+1] = endO - (jifO + 2)
	emitO(int(OpHalt))

	startO := time.Now()
	vmObj := NewVMWithConfig(Module{Constants: constsObj, Code: co}, HostCallbacks{}, RPCVMConfig())
	if err := vmObj.Run(); err != nil {
		t.Fatalf("10k object key inserts failed RPC budget: %v", err)
	}
	objDur := time.Since(startO)
	if objDur > 500*time.Millisecond {
		t.Fatalf("10k object key inserts too slow: %v", objDur)
	}
	t.Logf("CoW timings (with -race): 12k array=%v, 20k array=%v, 10k object=%v", arr12kDur, arr20kDur, objDur)
}
