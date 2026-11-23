package vm

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func FuzzLoadModuleAndRun(f *testing.F) {
	// Seed with valid stored fixtures and minimal valid chunks across bytecode versions.
	seeds := [][]byte{
		[]byte(`{"constants":[1,2],"code":[0,0,0,1,1,13,24]}`),
		[]byte(`{"format":"pulsarscript-bytecode","version":1,"compiler":"pulsarscript 0.4.0","sourceHash":"sha256:00","constants":[1],"code":[0,0,13,24]}`),
		[]byte(`{"format":"pulsarscript-bytecode","version":2,"compiler":"pulsarscript 0.5.0","sourceHash":"sha256:00","constants":[7,3],"code":[0,0,0,1,44,13,24]}`),
	}
	if matches, err := filepath.Glob("testdata/*.json"); err == nil {
		for _, p := range matches {
			if data, err := os.ReadFile(p); err == nil {
				seeds = append(seeds, data)
			}
		}
	}
	for _, s := range seeds {
		f.Add(s)
	}

	cfg := VMConfig{
		MaxStackDepth:    256,
		MaxCallDepth:     64,
		MaxHeapCount:     5000,
		MaxStringBytes:   64 << 10,
		MaxCollectionLen: 1000,
		MaxMemoryBytes:   1 << 20,
		MaxSteps:         10_000,
		MaxDuration:      50 * time.Millisecond,
	}
	host := HostCallbacks{
		Print: func(Value) {},
		HostCall: func(name string, args []Value) (Value, error) {
			return Nil(), nil
		},
		EmitEvent: func(Value) (Value, error) {
			return Nil(), nil
		},
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		mod, err := LoadModule(data)
		if err != nil {
			return
		}
		if err := VerifyModule(mod); err != nil {
			t.Fatalf("LoadModule accepted module that VerifyModule rejects: %v", err)
		}
		vm := NewVMWithConfig(mod, host, cfg)
		_ = vm.Run()
	})
}
