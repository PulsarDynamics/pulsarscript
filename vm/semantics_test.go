package vm

import (
	"math"
	"testing"
)

// These tests pin language rules from pulsarscript/SPEC.md that the VM implements.

func TestFormatNumberMatchesJavaScript(t *testing.T) {
	// Runtime values: Go folds constant expressions like 0.1 + 0.2 exactly at compile time.
	tenth, fifth, three := 0.1, 0.2, 3.0
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{math.Copysign(0, -1), "0"},
		{42, "42"},
		{-7, "-7"},
		{3.25, "3.25"},
		{tenth + fifth, "0.30000000000000004"},
		{1 / three, "0.3333333333333333"},
		{3628800, "3628800"},
		{1e20, "100000000000000000000"},
		{1e21, "1e+21"},
		{1.5e22, "1.5e+22"},
		{0.000001, "0.000001"},
		{1e-7, "1e-7"},
		{1.5e-7, "1.5e-7"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},
		{math.NaN(), "NaN"},
	}
	for _, c := range cases {
		if got := FormatNumber(c.in); got != c.want {
			t.Errorf("FormatNumber(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestValueStringContainers(t *testing.T) {
	arr := Array([]Value{Number(1), String("a\"b"), Bool(true), Nil(), Array(nil)})
	if got, want := arr.String(), `[1, "a\"b", true, nil, []]`; got != want {
		t.Errorf("array: got %s, want %s", got, want)
	}
	obj := Object(map[string]Value{"b": Number(2), "a": String("x"), "with space": Object(nil), "<tag>": Number(1)})
	if got, want := obj.String(), `{"<tag>": 1, a: "x", b: 2, "with space": {}}`; got != want {
		t.Errorf("object: got %s, want %s", got, want)
	}
}

func run(t *testing.T, constants []Value, code []int) *VM {
	t.Helper()
	vm := NewVM(Module{Constants: constants, Code: code}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("run: %v", err)
	}
	return vm
}

func TestAddConcatenatesWhenEitherSideIsString(t *testing.T) {
	cases := []struct {
		a, b Value
		want string
	}{
		{String("foo"), String("bar"), "foobar"},
		{String("a"), Number(1), "a1"},
		{Number(1), String("b"), "1b"},
		{String("n="), Nil(), "n=nil"},
		{String("big "), Number(3628800), "big 3628800"},
	}
	for _, c := range cases {
		vm := run(t, []Value{c.a, c.b}, []int{int(OpConst), 0, int(OpConst), 1, int(OpAdd), int(OpHalt)})
		if got := vm.stack[len(vm.stack)-1]; got.kind != kindString || got.str != c.want {
			t.Errorf("%v + %v = %v, want %q", c.a, c.b, got, c.want)
		}
	}
	// Arithmetic on other non-numbers is still an error.
	vm := NewVM(Module{Constants: []Value{Bool(true), Number(1)}, Code: []int{int(OpConst), 0, int(OpConst), 1, int(OpAdd), int(OpHalt)}}, HostCallbacks{})
	if err := vm.Run(); err == nil {
		t.Error("true + 1 should be a runtime error")
	}
}

func TestCatchReceivesErrorObject(t *testing.T) {
	// try { 1 / 0 } catch -> leave the caught value on the stack
	code := []int{
		int(OpTryPush), 7, // catch at 2+7 = 9
		int(OpConst), 0,
		int(OpConst), 1,
		int(OpDiv),
		int(OpTryPop),
		int(OpHalt),
		int(OpHalt), // catch entry: error value is on the stack
	}
	vm := NewVM(Module{Constants: []Value{Number(1), Number(0)}, Code: code, LineMap: []int{1, 1, 2, 2, 2, 2, 2, 3, 3, 4}}, HostCallbacks{})
	if err := vm.Run(); err != nil {
		t.Fatalf("run: %v", err)
	}
	e := vm.stack[len(vm.stack)-1]
	if e.kind != kindObject {
		t.Fatalf("caught value kind = %v, want object", e.kind)
	}
	if e.obj["kind"].str != "runtime" || e.obj["message"].str != "division by zero" {
		t.Errorf("caught value = %s", e.String())
	}
	if e.obj["line"].kind != kindNumber || e.obj["line"].num != 2 {
		t.Errorf("line = %s, want 2", e.obj["line"].String())
	}
}

func TestErrorValueStripsLinePrefix(t *testing.T) {
	v := errorValue(&RuntimeError{Line: 5, Msg: "boom"}, 0)
	if v.obj["message"].str != "boom" || v.obj["line"].num != 5 {
		t.Errorf("got %s", v.String())
	}
	if v := errorValue(errString("plain"), 0); v.obj["line"].kind != kindNil {
		t.Errorf("unknown line should be nil, got %s", v.obj["line"].String())
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func TestSetOpcodesCopyOnWrite(t *testing.T) {
	orig := Array([]Value{Number(1), Number(2)})
	vm := run(t, []Value{orig, Number(0), Number(9)}, []int{
		int(OpConst), 0, int(OpConst), 1, int(OpConst), 2, int(OpArraySet), int(OpHalt),
	})
	got := vm.stack[len(vm.stack)-1]
	if got.String() != "[9, 2]" || orig.String() != "[1, 2]" {
		t.Errorf("ARRAY_SET: new %s, original %s (original must not change)", got, orig)
	}

	o := Object(map[string]Value{"a": Number(1)})
	vm = run(t, []Value{o, String("a"), Number(5)}, []int{
		int(OpConst), 0, int(OpConst), 1, int(OpConst), 2, int(OpObjSet), int(OpHalt),
	})
	got = vm.stack[len(vm.stack)-1]
	if got.String() != "{a: 5}" || o.String() != "{a: 1}" {
		t.Errorf("OBJ_SET: new %s, original %s (original must not change)", got, o)
	}
}

func TestCoreBuiltinsNeedNoHost(t *testing.T) {
	call := func(name string, args ...Value) Value {
		t.Helper()
		consts := append([]Value{String(name)}, args...)
		code := []int{}
		for i := range args {
			code = append(code, int(OpConst), i+1)
		}
		code = append(code, int(OpHostCall), 0, len(args), int(OpHalt))
		return run(t, consts, code).stack[0]
	}
	checks := []struct {
		got  Value
		want string
	}{
		{call("typeOf", Array(nil)), "array"},
		{call("typeOf", Object(nil)), "object"},
		{call("string", Number(1e21)), "1e+21"},
		{call("concat", String("a"), Number(1), Bool(true)), "a1true"},
		{call("number", String(" 42 ")), "42"},
		{call("number", String("1e3")), "1000"},
		{call("number", String("abc")), "nil"},
		{call("number", String("")), "nil"},
		{call("abs", Number(-5)), "5"},
		{call("clamp", Number(150), Number(0), Number(100)), "100"},
		{call("len", String("héllo")), "5"},
	}
	for i, c := range checks {
		if c.got.String() != c.want {
			t.Errorf("check %d: got %s, want %s", i, c.got.String(), c.want)
		}
	}
}

func TestEqualityComparesContents(t *testing.T) {
	a := Array([]Value{Number(1), Object(map[string]Value{"k": String("v")})})
	b := Array([]Value{Number(1), Object(map[string]Value{"k": String("v")})})
	c := Array([]Value{Number(1), Object(map[string]Value{"k": String("w")})})
	if !valuesEqual(a, b) || valuesEqual(a, c) || valuesEqual(a, Array(nil)) {
		t.Error("arrays and objects must compare by contents")
	}
}
