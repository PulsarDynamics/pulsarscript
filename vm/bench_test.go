package vm

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func compileSourceForBench(tb testing.TB, src string) Module {
	tb.Helper()
	dir := tb.TempDir()
	inPath := filepath.Join(dir, "bench.puls")
	outPath := filepath.Join(dir, "bench.json")
	if err := os.WriteFile(inPath, []byte(src), 0o644); err != nil {
		tb.Fatalf("write bench source: %v", err)
	}
	cmd := exec.Command("bun", "run", "../compile.ts", "-s", inPath, outPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		tb.Fatalf("compile bench source: %v\n%s", err, string(out))
	}
	raw, err := os.ReadFile(outPath)
	if err != nil {
		tb.Fatalf("read compiled bench: %v", err)
	}
	mod, err := LoadModule(raw)
	if err != nil {
		tb.Fatalf("LoadModule: %v", err)
	}
	return mod
}

func runHandlerCountingSteps(vm *VM, name string, args []Value) (Value, int, error) {
	h, ok := vm.handlers[name]
	if !ok {
		return Value{}, 0, fmt.Errorf("handler not found: %s", name)
	}
	vm.halted = false
	vm.yielded = false
	vm.closeUpvalues(0)
	vm.frames = vm.frames[:0]
	vm.stack = vm.stack[:0]
	vm.rootLocals = 0
	for _, a := range args {
		if err := vm.push(a); err != nil {
			return Value{}, 0, err
		}
	}
	localCount := h.info.Locals
	if localCount < len(args) {
		localCount = len(args)
	}
	if err := vm.ensureStackSize(localCount); err != nil {
		return Value{}, 0, err
	}
	if h.info.SelfSlot != nil && *h.info.SelfSlot >= 0 && *h.info.SelfSlot < len(vm.stack) {
		vm.stack[*h.info.SelfSlot] = h.fn
	}
	vm.frames = append(vm.frames, callFrame{
		returnIP: len(vm.module.Code),
		base:     0,
		locals:   localCount,
		name:     h.info.Name,
		arity:    h.info.Arity,
		cl:       h.fn.cl,
	})
	vm.ip = h.info.Address

	vm.budgetActive = true
	vm.activeSteps = 0
	vm.activeMaxStp = 0
	vm.activeStart = time.Now()
	vm.activeMaxDur = 0
	defer func() { vm.budgetActive = false }()

	for !vm.halted {
		if err := vm.Step(); err != nil {
			if isUncatchable(err) {
				return Value{}, vm.activeSteps, err
			}
			if vm.handleException(err) {
				vm.activeSteps++
				continue
			}
			return Value{}, vm.activeSteps, err
		}
		vm.activeSteps++
	}
	if len(vm.stack) == 0 {
		return Nil(), vm.activeSteps, nil
	}
	return vm.stack[len(vm.stack)-1], vm.activeSteps, nil
}

func TestRPCBudgetBenchmarks(t *testing.T) {
	// 1a. 12,000 array appends inside full RPCVMConfig() (250k steps / 1.5s / 16 MiB)
	arr12Mod := compileSourceForBench(t, `
var a = [];
for (var i = 0; i < 12000; i = i + 1) {
  a[len(a)] = i;
}
print(len(a));
`)
	var out []string
	vmArr12 := NewVMWithConfig(arr12Mod, HostCallbacks{Print: func(v Value) { out = append(out, v.String()) }}, RPCVMConfig())
	start := time.Now()
	if err := vmArr12.Run(); err != nil {
		t.Fatalf("12k array appends exceeded RPC budget: %v", err)
	}
	if len(out) != 1 || out[0] != "12000" {
		t.Fatalf("unexpected array len output: %v", out)
	}
	t.Logf("12k array appends (within 250k steps) took %v", time.Since(start))

	// 1b. 20,000 array appends well inside 1.5s RPC wall-time & 16 MiB memory limits (previously 2.2s O(N^2))
	arr20Mod := compileSourceForBench(t, `
var a = [];
for (var i = 0; i < 20000; i = i + 1) {
  a[len(a)] = i;
}
print(len(a));
`)
	cfgArr20 := RPCVMConfig()
	cfgArr20.MaxSteps = -1 // 20k iterations * 17 ops/iter = ~340k instructions
	out = nil
	vmArr20 := NewVMWithConfig(arr20Mod, HostCallbacks{Print: func(v Value) { out = append(out, v.String()) }}, cfgArr20)
	start = time.Now()
	if err := vmArr20.Run(); err != nil {
		t.Fatalf("20k array appends exceeded RPC time/memory budget: %v", err)
	}
	if len(out) != 1 || out[0] != "20000" {
		t.Fatalf("unexpected 20k array len output: %v", out)
	}
	elapsed20 := time.Since(start)
	if elapsed20 > 300*time.Millisecond {
		t.Fatalf("20k array appends too slow: %v", elapsed20)
	}
	t.Logf("20k array appends took %v", elapsed20)

	// 2. 10,000 object key writes inside full RPCVMConfig() (previously 2.9s O(N^2))
	objMod := compileSourceForBench(t, `
var o = {};
for (var i = 0; i < 10000; i = i + 1) {
  o[string(i)] = i;
}
print(objGet(o, "9999"));
`)
	out = nil
	vmObj := NewVMWithConfig(objMod, HostCallbacks{Print: func(v Value) { out = append(out, v.String()) }}, RPCVMConfig())
	start = time.Now()
	if err := vmObj.Run(); err != nil {
		t.Fatalf("10k object writes exceeded RPC budget: %v", err)
	}
	if len(out) != 1 || out[0] != "9999" {
		t.Fatalf("unexpected obj output: %v", out)
	}
	t.Logf("10k object inserts took %v", time.Since(start))

	// 3. 8,000-character string walk inside full RPC step budget + 51,000-char Unicode walk well under 1.5s
	str8Mod := compileSourceForBench(t, `
var s = repeat("a", 8000);
var count = 0;
var n = len(s);
for (var i = 0; i < n; i = i + 1) {
  if (s[i] == "a") count = count + 1;
}
print(count);
`)
	out = nil
	vmStr8 := NewVMWithConfig(str8Mod, HostCallbacks{Print: func(v Value) { out = append(out, v.String()) }}, RPCVMConfig())
	if err := vmStr8.Run(); err != nil {
		t.Fatalf("8k string walk exceeded RPC budget: %v", err)
	}
	if len(out) != 1 || out[0] != "8000" {
		t.Fatalf("unexpected str8 output: %v", out)
	}

	str50Mod := compileSourceForBench(t, `
var s = repeat("ab😀", 17000);
var n = len(s);
var hits = 0;
for (var i = 0; i < n; i = i + 1) {
  if (s[i] == "😀") hits = hits + 1;
}
print(hits);
`)
	cfg50 := RPCVMConfig()
	cfg50.MaxSteps = -1 // 51k loop iterations > 250k steps, test O(N) wall time inside 1.5s budget!
	out = nil
	vmStr50 := NewVMWithConfig(str50Mod, HostCallbacks{Print: func(v Value) { out = append(out, v.String()) }}, cfg50)
	start = time.Now()
	if err := vmStr50.Run(); err != nil {
		t.Fatalf("51k Unicode string walk failed: %v", err)
	}
	elapsed50 := time.Since(start)
	if len(out) != 1 || out[0] != "17000" {
		t.Fatalf("unexpected str50 output: %v", out)
	}
	if elapsed50 > 500*time.Millisecond {
		t.Fatalf("51k Unicode string walk too slow (O(N^2) regression?): %v", elapsed50)
	}
	t.Logf("51k Unicode string walk took %v", elapsed50)

	// 4. File Manager folder listing sort step budget (< 140 steps per folder entry, LANG-07)
	outJson := filepath.Join(t.TempDir(), "ref.json")
	cmd := exec.Command("bun", "run", "../compile.ts", "-s", "../examples/file-manager-reference.puls", outJson)
	if cOut, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("compile reference: %v\n%s", err, string(cOut))
	}
	refRaw, err := os.ReadFile(outJson)
	if err != nil {
		t.Fatalf("read ref bytecode: %v", err)
	}
	refMod, err := LoadModule(refRaw)
	if err != nil {
		t.Fatalf("LoadModule ref: %v", err)
	}
	entries := make([]Value, 200)
	for i := 0; i < 200; i++ {
		entries[i] = Object(map[string]Value{
			"name": String(fmt.Sprintf("item_%04d.txt", 199-i)),
			"dir":  Bool(i%20 == 0),
			"size": Number(float64(i * 64)),
		})
	}
	refVM := NewVMWithConfig(refMod, HostCallbacks{
		HostCall: func(name string, args []Value) (Value, error) {
			if name == "fsList" {
				return Array(entries), nil
			}
			return Nil(), nil
		},
	}, RPCVMConfig())
	if err := refVM.Run(); err != nil {
		t.Fatalf("refVM init failed: %v", err)
	}
	sortedRes, stepsUsed, err := runHandlerCountingSteps(refVM, "listSorted", []Value{String("/docs"), String("name"), Bool(true)})
	if err != nil {
		t.Fatalf("listSorted failed: %v", err)
	}
	if sortedRes.arrayLen() != 200 {
		t.Fatalf("sorted len = %d, want 200", sortedRes.arrayLen())
	}
	stepsPerEntry := float64(stepsUsed) / 200.0
	t.Logf("File Manager listSorted(200): %d total steps (%.1f steps/entry)", stepsUsed, stepsPerEntry)
	if stepsPerEntry >= 140.0 {
		t.Fatalf("listSorted took %.1f steps/entry, target is < 140 steps/entry", stepsPerEntry)
	}
}

func BenchmarkFib20(b *testing.B) {
	mod := compileSourceForBench(b, `
function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}
print(fib(20));
`)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		vm := NewVMWithConfig(mod, HostCallbacks{Print: func(Value) {}}, VMConfig{MaxSteps: -1, MaxDuration: -1})
		if err := vm.Run(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTightLoop10k(b *testing.B) {
	mod := compileSourceForBench(b, `
var sum = 0;
for (var i = 0; i < 10000; i = i + 1) {
  sum = sum + i;
}
`)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		vm := NewVMWithConfig(mod, HostCallbacks{}, RPCVMConfig())
		if err := vm.Run(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkStringBuild(b *testing.B) {
	mod := compileSourceForBench(b, `
var s = "";
for (var i = 0; i < 1000; i = i + 1) {
  s = s + "a";
}
`)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		vm := NewVMWithConfig(mod, HostCallbacks{}, RPCVMConfig())
		if err := vm.Run(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkStringWalk50k(b *testing.B) {
	mod := compileSourceForBench(b, `
var s = repeat("abcde", 10000);
var n = len(s);
var c = 0;
for (var i = 0; i < n; i = i + 1) {
  if (s[i] == "c") c = c + 1;
}
`)
	cfg := RPCVMConfig()
	cfg.MaxSteps = -1
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		vm := NewVMWithConfig(mod, HostCallbacks{}, cfg)
		if err := vm.Run(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkArrayBuild20k(b *testing.B) {
	mod := compileSourceForBench(b, `
var a = [];
for (var i = 0; i < 20000; i = i + 1) {
  a[len(a)] = i;
}
`)
	cfg := RPCVMConfig()
	cfg.MaxSteps = -1
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		vm := NewVMWithConfig(mod, HostCallbacks{}, cfg)
		if err := vm.Run(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkObjectBuild10k(b *testing.B) {
	mod := compileSourceForBench(b, `
var o = {};
for (var i = 0; i < 10000; i = i + 1) {
  o[string(i)] = i;
}
`)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		vm := NewVMWithConfig(mod, HostCallbacks{}, RPCVMConfig())
		if err := vm.Run(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkHandlerDispatch(b *testing.B) {
	mod := compileSourceForBench(b, `
var acc = 0;
registerHandler("inc", function(d) {
  acc = acc + d;
  return acc;
});
`)
	vm := NewVMWithConfig(mod, HostCallbacks{}, RPCVMConfig())
	if err := vm.Run(); err != nil {
		b.Fatal(err)
	}
	args := []Value{Number(1)}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := vm.DispatchHandler("inc", args); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkFileManagerListSort(b *testing.B) {
	outJson := filepath.Join(b.TempDir(), "ref.json")
	cmd := exec.Command("bun", "run", "../compile.ts", "-s", "../examples/file-manager-reference.puls", outJson)
	if out, err := cmd.CombinedOutput(); err != nil {
		b.Fatalf("compile reference: %v\n%s", err, string(out))
	}
	raw, err := os.ReadFile(outJson)
	if err != nil {
		b.Fatal(err)
	}
	mod, err := LoadModule(raw)
	if err != nil {
		b.Fatal(err)
	}
	entries := make([]Value, 200)
	for i := 0; i < 200; i++ {
		entries[i] = Object(map[string]Value{
			"name": String(fmt.Sprintf("item_%04d.txt", 199-i)),
			"dir":  Bool(i%20 == 0),
			"size": Number(float64(i * 64)),
		})
	}
	vm := NewVMWithConfig(mod, HostCallbacks{
		HostCall: func(name string, _ []Value) (Value, error) {
			if name == "fsList" {
				return Array(entries), nil
			}
			return Nil(), nil
		},
	}, RPCVMConfig())
	if err := vm.Run(); err != nil {
		b.Fatal(err)
	}
	args := []Value{String("/docs"), String("name"), Bool(true)}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := vm.DispatchHandler("listSorted", args); err != nil {
			b.Fatal(err)
		}
	}
}
