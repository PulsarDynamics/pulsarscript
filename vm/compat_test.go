package vm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBytecodeVersionCompatibilityFixtures(t *testing.T) {
	cases := []struct {
		file    string
		version int
		wantOut []string
	}{
		{"v0_compat.json", 0, []string{"compat-v0", "42"}},
		{"v1_compat.json", 1, []string{"compat-v1", "42"}},
		{"v2_compat.json", 2, []string{"7", "1"}},
		{"v3_compat.json", 3, []string{"15"}},
	}

	for _, tc := range cases {
		t.Run(tc.file, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata", tc.file))
			if err != nil {
				t.Fatalf("read %s: %v", tc.file, err)
			}
			mod, err := LoadModule(data)
			if err != nil {
				t.Fatalf("LoadModule(%s) failed: %v", tc.file, err)
			}
			if mod.Version != tc.version {
				t.Fatalf("got version %d, want %d", mod.Version, tc.version)
			}
			if err := VerifyModule(mod); err != nil {
				t.Fatalf("VerifyModule(%s) failed: %v", tc.file, err)
			}
			var out []string
			vm := NewVM(mod, HostCallbacks{
				Print: func(v Value) { out = append(out, v.String()) },
			})
			if err := vm.Run(); err != nil {
				t.Fatalf("Run(%s) failed: %v", tc.file, err)
			}
			if strings.Join(out, ",") != strings.Join(tc.wantOut, ",") {
				t.Fatalf("got output %v, want %v", out, tc.wantOut)
			}
		})
	}
}

func TestRejectsUnsupportedFutureVersion(t *testing.T) {
	bad := []byte(`{"format":"pulsarscript-bytecode","version":4,"compiler":"pulsarscript 9.9.9","sourceHash":"sha256:0","constants":[],"code":[24],"functions":[]}`)
	if _, err := LoadModule(bad); err == nil {
		t.Fatalf("expected error loading version 4 bytecode")
	}
}
