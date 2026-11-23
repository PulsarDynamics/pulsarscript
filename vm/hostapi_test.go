package vm

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// Every "core" registry entry is implemented by the VM, and nothing else is (D5).
func TestCoreBuiltinsMatchRegistry(t *testing.T) {
	for name, fn := range hostAPI {
		_, implemented := coreBuiltins[name]
		if fn.Provider == ProviderCore && !implemented {
			t.Errorf("core entry %s has no VM implementation", name)
		}
		if fn.Provider == ProviderHost && implemented {
			t.Errorf("host entry %s must not be implemented by the VM", name)
		}
	}
	for name := range coreBuiltins {
		if fn, ok := hostAPI[name]; !ok || fn.Provider != ProviderCore {
			t.Errorf("VM implements %s, which is not a core entry in hostapi.json", name)
		}
	}
}

func TestVerifyModuleRejectsUnknownHostCall(t *testing.T) {
	cases := map[string]string{
		`{"constants":["notAFunction"],"code":[23,0,0,24]}`: `unknown host call "notAFunction"`,
		`{"constants":["len"],"code":[23,0,2,24]}`:          `passes 2 arguments`,
		`{"constants":[1],"code":[23,0,0,24]}`:              "not a string",
		`{"constants":[],"code":[99]}`:                      "unknown opcode 99",
		`{"constants":[],"code":[21,0]}`:                    "missing operands",
	}
	for src, want := range cases {
		if _, err := LoadModule([]byte(src)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want error containing %q", src, err, want)
		}
	}
	// CALL has two operands; a valid module decodes past it.
	ok := `{"constants":["len"],"code":[21,0,1,23,0,1,24],"functions":[]}`
	if _, err := LoadModule([]byte(ok)); err != nil {
		t.Errorf("valid module rejected: %v", err)
	}
}

func TestHostCallArgumentChecks(t *testing.T) {
	cases := []struct {
		name string
		args []Value
		want string
	}{
		{"len", []Value{Number(1)}, "len: argument 1 (value) must be string or array, got number"},
		{"abs", []Value{String("x")}, "abs: argument 1 (n) must be number, got string"},
		{"arrayPush", []Value{Array(nil)}, "arrayPush: expected at least 2 arguments but got 1."},
		{"emitEvent", []Value{Nil(), Nil()}, "emitEvent: expected 0 to 1 argument"},
	}
	for _, c := range cases {
		err := hostAPI[c.name].checkCall(c.args)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want %q", c.name, err, c.want)
		}
	}
}

func callCore(t *testing.T, name string, args ...Value) Value {
	t.Helper()
	vm := NewVM(Module{}, HostCallbacks{})
	if err := hostAPI[name].checkCall(args); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	v, err := coreBuiltins[name](vm, args)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}

func TestNewCoreBuiltins(t *testing.T) {
	cases := []struct {
		got  Value
		want string
	}{
		{callCore(t, "floor", Number(-2.5)), "-3"},
		{callCore(t, "round", Number(-2.5)), "-2"},
		{callCore(t, "round", Number(2.5)), "3"},
		{callCore(t, "round", Number(0.49999999999999994)), "0"},
		{callCore(t, "pow", Number(2), Number(10)), "1024"},
		{callCore(t, "min", Number(3), Number(-1)), "-1"},
		{callCore(t, "toUpper", String("héllo")), "HÉLLO"},
		{callCore(t, "trim", String("  a b \n")), "a b"},
		{callCore(t, "indexOf", String("héllo"), String("l")), "2"},
		{callCore(t, "substr", String("héllo"), Number(1), Number(3)), "éll"},
		{callCore(t, "substr", String("abc"), Number(5), Number(1)), ""},
		{callCore(t, "parseInt", String("ff"), Number(16)), "255"},
		{callCore(t, "parseInt", String("19"), Number(8)), "nil"},
		{callCore(t, "parseInt", String(" -42 "), Number(10)), "-42"},
		{callCore(t, "parseFloat", String("3.5")), "3.5"},
		{callCore(t, "parseFloat", String("1e3")), "1000"},
		{callCore(t, "toNumberOr", String(""), Number(5)), "5"},
		{callCore(t, "isInteger", Number(3)), "true"},
		{callCore(t, "isFinite", String("1")), "false"},
	}
	for i, c := range cases {
		if c.got.String() != c.want {
			t.Errorf("case %d: got %s, want %s", i, c.got.String(), c.want)
		}
	}
}

func TestRandomIntIsInclusiveAndSeeded(t *testing.T) {
	vm := NewVM(Module{}, HostCallbacks{})
	vm.SetSeed(42)
	seen := map[float64]bool{}
	for i := 0; i < 200; i++ {
		v, _ := coreBuiltins["randomInt"](vm, []Value{Number(1), Number(3)})
		if v.num < 1 || v.num > 3 {
			t.Fatalf("randomInt(1, 3) = %v", v.num)
		}
		seen[v.num] = true
	}
	if len(seen) != 3 {
		t.Errorf("randomInt(1, 3) never produced all of 1, 2, 3: %v", seen)
	}
	a, b := NewVM(Module{}, HostCallbacks{}), NewVM(Module{}, HostCallbacks{})
	a.SetSeed(7)
	b.SetSeed(7)
	if a.random() != b.random() {
		t.Error("same seed gave different sequences")
	}
}

// An infinite loop stops with a budget error by default, and try/catch cannot catch it (D10).
func TestRunHasDefaultBudget(t *testing.T) {
	// try { while (true) {} } catch (e) {}  ==  TRY_PUSH (catch at HALT); JUMP -2 (to itself)
	code := []int{int(OpTryPush), 2, int(OpJump), -2, int(OpHalt)}
	vm := NewVMWithConfig(Module{Code: code}, HostCallbacks{}, VMConfig{MaxSteps: 1000})
	if err := vm.Run(); !errors.Is(err, ErrStepBudgetExceeded) {
		t.Fatalf("want step budget error, got %v", err)
	}
	vm = NewVMWithConfig(Module{Code: code}, HostCallbacks{}, VMConfig{MaxSteps: -1, MaxDuration: 20 * time.Millisecond})
	if err := vm.Run(); !errors.Is(err, ErrTimeBudgetExceeded) {
		t.Fatalf("want time budget error, got %v", err)
	}
	if d := DefaultVMConfig(); d.MaxSteps != DefaultMaxSteps || d.MaxDuration != DefaultMaxDuration {
		t.Errorf("unexpected defaults %+v", d)
	}
}
