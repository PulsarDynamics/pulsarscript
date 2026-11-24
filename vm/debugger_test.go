package vm

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func compileDebugModule(tb testing.TB, src string) Module {
	tb.Helper()
	dir := tb.TempDir()
	inPath := filepath.Join(dir, "debug_target.puls")
	outPath := filepath.Join(dir, "debug_target.json")
	if err := os.WriteFile(inPath, []byte(src), 0o644); err != nil {
		tb.Fatalf("write source: %v", err)
	}
	cmd := exec.Command("bun", "run", "../compile.ts", "-g", inPath, outPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		tb.Fatalf("compile -g failed: %v\n%s", err, string(out))
	}
	raw, err := os.ReadFile(outPath)
	if err != nil {
		tb.Fatalf("read compiled json: %v", err)
	}
	mod, err := LoadModule(raw)
	if err != nil {
		tb.Fatalf("LoadModule: %v", err)
	}
	return mod
}

func TestDebuggerBreakpointsLocalsAndStepping(t *testing.T) {
	src := strings.Join([]string{
		`var base = 10;`,                   // line 1
		`function addTwice(x, y) {`,        // line 2
		`  var sum = x + y;`,               // line 3
		`  var doubled = sum * 2;`,         // line 4
		`  return doubled;`,                // line 5
		`}`,                                // line 6
		`function main() {`,                // line 7
		`  var localA = 3;`,                // line 8
		`  var out = addTwice(localA, 4);`, // line 9
		`  var done = out + base;`,         // line 10
		`  return done;`,                   // line 11
		`}`,                                // line 12
		`print(main());`,                   // line 13
	}, "\n")

	mod := compileDebugModule(t, src)
	var printed []string
	vm := NewVM(mod, HostCallbacks{
		Print: func(v Value) { printed = append(printed, v.String()) },
	})
	dbg := NewDebugger(vm)

	// 1. Break at line 9 inside main, inspect locals & globals, then StepOver line 9 -> line 10.
	dbg.AddBreakpoint("", 9)
	snap := dbg.Continue()
	if snap.Reason != "breakpoint" || snap.Line != 9 {
		t.Fatalf("expected breakpoint on line 9, got reason=%q line=%d err=%q", snap.Reason, snap.Line, snap.Error)
	}
	if got, ok := snap.Frames[0].LocalValues["localA"]; !ok || got.Number() != 3 {
		t.Fatalf("expected localA=3 at line 9, got %+v", snap.Frames[0].Locals)
	}
	if g, ok := snap.GlobalValues["base"]; !ok || g.Number() != 10 {
		t.Fatalf("expected global base=10, got %+v", snap.Globals)
	}

	// StepOver line 9 executes addTwice(3, 4) completely and lands on line 10 without entering addTwice.
	snap = dbg.StepOver()
	if snap.Reason != "step" || snap.Line != 10 {
		t.Fatalf("expected StepOver to land on line 10, got reason=%q line=%d", snap.Reason, snap.Line)
	}
	if got, ok := snap.Frames[0].LocalValues["out"]; !ok || got.Number() != 14 {
		t.Fatalf("expected out=14 after stepping over addTwice, got %+v", snap.Frames[0].Locals)
	}

	snap = dbg.Continue()
	if !snap.Halted || snap.Reason != "halted" {
		t.Fatalf("expected program to halt cleanly, got reason=%q err=%q", snap.Reason, snap.Error)
	}
	if len(printed) != 1 || printed[0] != "24" {
		t.Fatalf("expected output [24], got %v", printed)
	}

	// 2. Fresh run: StepIn into addTwice at line 9, inspect params/locals at line 4, then StepOut back to main!
	vm2 := NewVM(mod, HostCallbacks{Print: func(v Value) {}})
	dbg2 := NewDebugger(vm2)
	dbg2.AddBreakpoint("", 9)
	snap = dbg2.Continue()
	if snap.Line != 9 {
		t.Fatalf("run 2 expected line 9, got %d", snap.Line)
	}
	snap = dbg2.StepIn()
	if snap.Frames[0].Name != "addTwice" {
		t.Fatalf("expected StepIn to enter addTwice, got frame %q (line %d)", snap.Frames[0].Name, snap.Line)
	}
	dbg2.AddBreakpoint("", 4)
	snap = dbg2.Continue()
	if snap.Line != 4 || snap.Frames[0].Name != "addTwice" {
		t.Fatalf("expected breakpoint at line 4 inside addTwice, got %q:%d", snap.Frames[0].Name, snap.Line)
	}
	if got, ok := snap.Frames[0].LocalValues["sum"]; !ok || got.Number() != 7 {
		t.Fatalf("expected sum=7 at line 4, got %+v", snap.Frames[0].Locals)
	}
	snap = dbg2.StepOut()
	if snap.Frames[0].Name != "main" {
		t.Fatalf("expected StepOut to return to main, got %q (line %d)", snap.Frames[0].Name, snap.Line)
	}
	snap = dbg2.Continue()
	if !snap.Halted {
		t.Fatalf("expected second run to halt cleanly, got %+v", snap)
	}
}

func TestDebuggerPausesTimeBudgetWhileStopped(t *testing.T) {
	src := strings.Join([]string{
		`var a = 1;`,
		`var b = 2;`,
		`var c = a + b;`,
		`print(c);`,
	}, "\n")
	mod := compileDebugModule(t, src)
	cfg := DefaultVMConfig()
	cfg.MaxDuration = 120 * time.Millisecond

	var out []string
	vm := NewVMWithConfig(mod, HostCallbacks{
		Print: func(v Value) { out = append(out, v.String()) },
	}, cfg)
	dbg := NewDebugger(vm)
	dbg.AddBreakpoint("", 3)

	snap := dbg.Continue()
	if snap.Reason != "breakpoint" || snap.Line != 3 {
		t.Fatalf("expected breakpoint on line 3, got %+v", snap)
	}

	// Sleep longer than MaxDuration while paused at the breakpoint.
	time.Sleep(180 * time.Millisecond)

	snap = dbg.Continue()
	if snap.Error != "" || !snap.Halted {
		t.Fatalf("budget timer should pause while stopped at breakpoint; got err=%q halted=%v elapsedMs=%v", snap.Error, snap.Halted, snap.ElapsedMs)
	}
	if len(out) != 1 || out[0] != "3" {
		t.Fatalf("expected [3], got %v", out)
	}
}

func TestDebuggerStepInTryCatchAndUpvalues(t *testing.T) {
	src := strings.Join([]string{
		`function makeCounter(start) {`,
		`  var n = start;`,
		`  return function() {`,
		`    n = n + 1;`,
		`    return n;`,
		`  };`,
		`}`,
		`var inc = makeCounter(5);`,
		`print(inc());`,
		`try {`,
		`  var x = 1 / 0;`,
		`} catch (e) {`,
		`  print(e.kind);`,
		`}`,
	}, "\n")
	mod := compileDebugModule(t, src)
	var out []string
	vm := NewVM(mod, HostCallbacks{Print: func(v Value) { out = append(out, v.String()) }})
	dbg := NewDebugger(vm)
	dbg.AddBreakpoint("", 5)
	snap := dbg.Continue()
	if snap.Line != 5 || len(snap.Frames[0].Upvalues) != 1 || snap.Frames[0].Upvalues[0].Value != "6" {
		t.Fatalf("expected upvalue n=6 at line 5, got line=%d upvalues=%+v", snap.Line, snap.Frames[0].Upvalues)
	}
	dbg.ClearBreakpoints()
	snap = dbg.Continue()
	if !snap.Halted || snap.Error != "" {
		t.Fatalf("expected clean try/catch completion, got %+v", snap)
	}
	if strings.Join(out, ",") != "6,runtime" {
		t.Fatalf("expected [6, runtime], got %v", out)
	}
}
