package vm

import (
	"strings"
	"testing"
)

const body = `"constants":[1],"code":[0,0,13,24]`

func TestLoadModuleHeader(t *testing.T) {
	m, err := LoadModule([]byte(`{"format":"pulsarscript-bytecode","version":1,"compiler":"pulsarscript 0.4.0","sourceHash":"sha256:ab",` + body + `}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != 1 || m.Compiler != "pulsarscript 0.4.0" || m.SourceHash != "sha256:ab" {
		t.Errorf("header = %d %q %q", m.Version, m.Compiler, m.SourceHash)
	}
}

// Files written before the header existed (version 0) still load.
func TestLoadModuleWithoutHeaderIsVersion0(t *testing.T) {
	m, err := LoadModule([]byte(`{` + body + `}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != 0 {
		t.Errorf("version = %d, want 0", m.Version)
	}
}

func TestLoadModuleRejectsUnknownFormatOrVersion(t *testing.T) {
	cases := map[string]string{
		`{"format":"pulsarscript-bytecode","version":3,` + body + `}`:  "bytecode version 3 is not supported",
		`{"format":"pulsarscript-bytecode","version":-1,` + body + `}`: "bytecode version -1 is not supported",
		`{"format":"pulsarscript-bytecode",` + body + `}`:              "bytecode version 0 is not supported",
		`{"format":"something-else","version":1,` + body + `}`:         "not PulsarScript bytecode",
		`{"version":1,` + body + `}`:                                   "not PulsarScript bytecode",
	}
	for src, want := range cases {
		if _, err := LoadModule([]byte(src)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", src, err, want)
		}
	}
}
