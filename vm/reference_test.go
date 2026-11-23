package vm

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestReferenceScriptWithinRPCAndServiceBudgets(t *testing.T) {
	outPath := filepath.Join(t.TempDir(), "file-manager-reference.json")
	cmd := exec.Command("bun", "run", "../compile.ts", "-s", "../examples/file-manager-reference.puls", outPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("compile reference script: %v\n%s", err, string(out))
	}
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("read compiled reference: %v", err)
	}
	mod, err := LoadModule(raw)
	if err != nil {
		t.Fatalf("LoadModule failed: %v", err)
	}

	// Build 500 synthetic folder entries to stress-test RPC sorting, batch rename planning,
	// and cursor-paged rename execution inside RPCVMConfig().
	entries := make([]Value, 500)
	for i := 0; i < 500; i++ {
		entries[i] = Object(map[string]Value{
			"name":     String(fmt.Sprintf("file_%04d.txt", 499-i)),
			"dir":      Bool(i%25 == 0),
			"size":     Number(float64(i * 128)),
			"modified": Number(float64(1700000000000 + i)),
		})
	}
	renames := 0
	var emitted []Value

	callbacks := HostCallbacks{
		HostCall: func(name string, args []Value) (Value, error) {
			switch name {
			case "fsList":
				return Array(entries), nil
			case "fsRename":
				renames++
				return Bool(true), nil
			default:
				return Nil(), fmt.Errorf("unexpected host call %s", name)
			}
		},
		EmitEvent: func(v Value) (Value, error) {
			emitted = append(emitted, v)
			return Nil(), nil
		},
	}

	// 1. RPC mode budget (250,000 steps / 1.5s / 16 MiB)
	rpcVM := NewVMWithConfig(mod, callbacks, RPCVMConfig())
	if err := rpcVM.Run(); err != nil {
		t.Fatalf("RPC init Run failed: %v", err)
	}

	sortedRes, err := rpcVM.DispatchHandler("listSorted", []Value{String("/docs"), String("name"), Bool(true)})
	if err != nil {
		t.Fatalf("listSorted(500) exceeded RPC budget or failed: %v", err)
	}
	if sortedRes.arrayLen() != 500 {
		t.Fatalf("sorted length = %d, want 500", sortedRes.arrayLen())
	}

	planRes, err := rpcVM.DispatchHandler("planRename", []Value{String("/docs"), String(".txt"), String(".md"), String("new_")})
	if err != nil {
		t.Fatalf("planRename(500) exceeded RPC budget or failed: %v", err)
	}
	if planRes.arrayLen() != 480 {
		t.Fatalf("expected 480 file rename plans (20 dirs excluded), got %d", planRes.arrayLen())
	}

	pageRes, err := rpcVM.DispatchHandler("applyRenamePage", []Value{planRes, Number(0), Number(200)})
	if err != nil {
		t.Fatalf("applyRenamePage failed: %v", err)
	}
	doneVal, _ := pageRes.objectGet("done")
	if doneVal.Bool() {
		t.Fatalf("expected page 1 done=false")
	}
	if renames != 200 {
		t.Fatalf("renames = %d, want 200", renames)
	}

	// 2. Service mode budget: event watcher handles batched fs.change events and emits summary
	svcVM := NewVMWithConfig(mod, callbacks, ServiceVMConfig())
	if err := svcVM.Run(); err != nil {
		t.Fatalf("Service init Run failed: %v", err)
	}
	for i := 0; i < 4; i++ {
		evt := Object(map[string]Value{
			"name":  String(fmt.Sprintf("doc_%d.md", i)),
			"size":  Number(1024),
			"flush": Bool(false),
		})
		if err := svcVM.DispatchEvent("fs.change", evt); err != nil {
			t.Fatalf("DispatchEvent(%d) failed: %v", i, err)
		}
	}
	if len(emitted) != 1 {
		t.Fatalf("expected 1 emitted watcher.summary event, got %d", len(emitted))
	}
	evtName, _ := emitted[0].objectGet("name")
	if evtName.String() != "watcher.summary" {
		t.Fatalf("unexpected emitted event name: %v", evtName)
	}
}
