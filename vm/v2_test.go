package vm

import (
	"strings"
	"testing"
)

// Bytecode version 2 (SPEC v0.5): indexing, modulo, function values and for...of support.

func TestLoadModuleAcceptsVersion2(t *testing.T) {
	src := `{"format":"pulsarscript-bytecode","version":2,"compiler":"pulsarscript 0.5.0",` +
		`"constants":[7,3],"code":[0,0,0,1,44,13,24]}`
	mod, err := LoadModule([]byte(src))
	if err != nil {
		t.Fatalf("LoadModule: %v", err)
	}
	var printed []string
	vm := NewVM(mod, HostCallbacks{Print: func(v Value) { printed = append(printed, v.String()) }})
	if err := vm.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(printed) != 1 || printed[0] != "1" {
		t.Fatalf("7 %% 3 printed %v, want [1]", printed)
	}
}

func TestVerifyModuleRejectsFuncWithoutFunction(t *testing.T) {
	mod := Module{Code: []int{int(OpFunc), 3, int(OpHalt)}, Functions: map[int]FunctionInfo{}}
	err := VerifyModule(mod)
	if err == nil || !strings.Contains(err.Error(), "no function at address 3") {
		t.Fatalf("VerifyModule = %v, want a FUNC error", err)
	}
}

func TestVerifyModuleRejectsBadIndexOperand(t *testing.T) {
	mod := Module{Code: []int{int(OpIndexGet), 2, int(OpHalt)}}
	err := VerifyModule(mod)
	if err == nil || !strings.Contains(err.Error(), "operand must be 0 or 1") {
		t.Fatalf("VerifyModule = %v, want an operand error", err)
	}
}

func TestElementHelpers(t *testing.T) {
	arr := Array([]Value{Number(1), Number(2)})

	// Reading.
	if v, err := readElement(arr, Number(1), false); err != nil || v.num != 2 {
		t.Fatalf("arr[1] = %v, %v", v, err)
	}
	if _, err := readElement(arr, Number(2), false); err == nil {
		t.Fatal("arr[2] should be out of bounds")
	}
	if _, err := readElement(arr, Number(0.5), false); err == nil || !strings.Contains(err.Error(), "integer") {
		t.Fatalf("arr[0.5] error = %v", err)
	}
	if _, err := readElement(arr, String("length"), true); err == nil || !strings.Contains(err.Error(), "cannot read property") {
		t.Fatalf("arr.length error = %v", err)
	}
	if v, _ := readElement(String("héllo"), Number(1), false); v.str != "é" {
		t.Fatalf(`"héllo"[1] = %q, want "é"`, v.str)
	}
	obj := Object(map[string]Value{"a": Number(1)})
	if v, _ := readElement(obj, String("missing"), true); v.kind != kindNil {
		t.Fatalf("missing key = %v, want nil", v)
	}

	// Writing copies and leaves the original alone.
	next, err := withElement(arr, Number(2), Number(3), false)
	if err != nil || len(next.arr) != 3 || len(arr.arr) != 2 {
		t.Fatalf("append: next=%v err=%v original=%v", next, err, arr)
	}
	if _, err := withElement(arr, Number(5), Number(3), false); err == nil {
		t.Fatal("writing past len should fail")
	}
	nobj, _ := withElement(obj, String("b"), Number(2), true)
	if len(nobj.obj) != 2 || len(obj.obj) != 1 {
		t.Fatalf("object write: next=%v original=%v", nobj, obj)
	}
	if _, err := withElement(String("abc"), Number(0), String("x"), false); err == nil {
		t.Fatal("strings cannot be assigned into")
	}
}

func TestFunctionValues(t *testing.T) {
	f := Function(10, "double")
	if f.String() != "<fn double>" || typeName(f) != "function" {
		t.Fatalf("function value prints %q, type %q", f.String(), typeName(f))
	}
	if !valuesEqual(f, Function(10, "double")) || valuesEqual(f, Function(12, "other")) {
		t.Fatal("function equality is by address")
	}
}
