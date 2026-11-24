package vm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var validHostCapabilities = map[string]bool{
	"fs.read":  true,
	"fs.write": true,
	"kv":       true,
	"events":   true,
	"window":   true,
	"ipc":      true,
}

var validManifestScopes = map[string]bool{
	"fs.read":  true,
	"fs.write": true,
	"fs.user":  true,
	"kv":       true,
	"events":   true,
	"window":   true,
	"ipc":      true,
}

var (
	manifestIDRe     = regexp.MustCompile(`^[a-z0-9]+([.-][a-z0-9]+)+$`)
	manifestSemverRe = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)
	manifestIdentRe  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	manifestRelRe    = regexp.MustCompile(`^[^/].*$`)
	manifestExtRe    = regexp.MustCompile(`^\.[a-z0-9]+$`)
)

func TestHostAPIContracts(t *testing.T) {
	if len(hostAPI) == 0 {
		t.Fatal("hostapi.json loaded zero functions")
	}
	for name, fn := range hostAPI {
		if fn.Doc == "" {
			t.Errorf("hostapi entry %s has empty doc", name)
		}
		if fn.Returns == "" {
			t.Errorf("hostapi entry %s has empty returns", name)
		}
		if fn.Provider == ProviderCore {
			if coreBuiltins[name] == nil {
				t.Errorf("core entry %s missing from coreBuiltins", name)
			}
			if fn.Capability != "" {
				t.Errorf("core entry %s should not declare capability %q", name, fn.Capability)
			}
		} else if fn.Provider == ProviderHost {
			if !validHostCapabilities[fn.Capability] {
				t.Errorf("host entry %s has invalid capability %q", name, fn.Capability)
			}
		}
	}
}

func validateManifestBytes(data []byte) []string {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return []string{"invalid JSON: " + err.Error()}
	}
	var errs []string
	allowedRoot := map[string]bool{
		"$schema": true, "id": true, "name": true, "version": true, "description": true,
		"author": true, "icon": true, "sdkVersion": true, "ui": true, "script": true,
		"permissions": true, "fileTypes": true,
	}
	for k := range raw {
		if !allowedRoot[k] {
			errs = append(errs, "unexpected root key "+k)
		}
	}

	var doc struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Version    string `json:"version"`
		SDKVersion string `json:"sdkVersion"`
		UI         *struct {
			Entry string `json:"entry"`
		} `json:"ui"`
		Script *struct {
			Bundle   string `json:"bundle"`
			Source   string `json:"source"`
			Handlers []struct {
				Name string `json:"name"`
				Mode string `json:"mode"`
			} `json:"handlers"`
			Exports json.RawMessage `json:"exports"`
		} `json:"script"`
		Permissions *struct {
			Scopes []string `json:"scopes"`
		} `json:"permissions"`
		FileTypes []struct {
			Extensions []string `json:"extensions"`
			Role       string   `json:"role"`
		} `json:"fileTypes"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return append(errs, "schema type error: "+err.Error())
	}
	if !manifestIDRe.MatchString(doc.ID) || len(doc.ID) < 3 || len(doc.ID) > 128 {
		errs = append(errs, "invalid id")
	}
	if doc.Name == "" || len(doc.Name) > 80 {
		errs = append(errs, "invalid name")
	}
	if !manifestSemverRe.MatchString(doc.Version) {
		errs = append(errs, "invalid version")
	}
	if doc.SDKVersion != "" && !manifestSemverRe.MatchString(doc.SDKVersion) {
		errs = append(errs, "invalid sdkVersion")
	}
	if doc.UI == nil || doc.UI.Entry == "" || !manifestRelRe.MatchString(doc.UI.Entry) || strings.Contains(doc.UI.Entry, "..") {
		errs = append(errs, "invalid ui.entry")
	}
	if doc.Script != nil {
		if len(doc.Script.Exports) > 0 {
			errs = append(errs, "legacy script.exports is not allowed")
		}
		if doc.Script.Bundle == "" || !manifestRelRe.MatchString(doc.Script.Bundle) || strings.Contains(doc.Script.Bundle, "..") {
			errs = append(errs, "invalid script.bundle")
		}
		if len(doc.Script.Handlers) == 0 {
			errs = append(errs, "script.handlers must be non-empty")
		}
		for _, h := range doc.Script.Handlers {
			if !manifestIdentRe.MatchString(h.Name) {
				errs = append(errs, "invalid handler name "+h.Name)
			}
			if h.Mode != "rpc" && h.Mode != "service" {
				errs = append(errs, "invalid handler mode "+h.Mode)
			}
		}
	}
	if doc.Permissions == nil || doc.Permissions.Scopes == nil {
		errs = append(errs, "missing permissions.scopes")
	} else {
		seen := make(map[string]bool)
		for _, s := range doc.Permissions.Scopes {
			if !validManifestScopes[s] {
				errs = append(errs, "unknown scope "+s)
			}
			if seen[s] {
				errs = append(errs, "duplicate scope "+s)
			}
			seen[s] = true
		}
	}
	for _, ft := range doc.FileTypes {
		if len(ft.Extensions) == 0 {
			errs = append(errs, "fileTypes.extensions must be non-empty")
		}
		for _, ext := range ft.Extensions {
			if !manifestExtRe.MatchString(ext) {
				errs = append(errs, "invalid fileTypes extension "+ext)
			}
		}
		if ft.Role != "" && ft.Role != "viewer" && ft.Role != "editor" {
			errs = append(errs, "invalid fileTypes role "+ft.Role)
		}
	}
	return errs
}

func TestManifestFixturesContract(t *testing.T) {
	fixturesDir := filepath.Join("..", "contracts", "fixtures", "manifest")
	entries, err := os.ReadDir(fixturesDir)
	if err != nil {
		t.Fatalf("read fixtures dir: %v", err)
	}
	if len(entries) < 6 {
		t.Fatalf("expected at least 6 manifest fixtures, got %d", len(entries))
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(fixturesDir, entry.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", entry.Name(), err)
		}
		errs := validateManifestBytes(raw)
		wantValid := strings.HasPrefix(entry.Name(), "valid-")
		if wantValid && len(errs) > 0 {
			t.Errorf("%s expected valid, got errors: %v", entry.Name(), errs)
		}
		if !wantValid && len(errs) == 0 {
			t.Errorf("%s expected invalid, got no errors", entry.Name())
		}
	}

	vaultManifest := filepath.Join("..", "examples", "apps", "pulsar-vault", "AppManifest.json")
	if raw, err := os.ReadFile(vaultManifest); err == nil {
		if errs := validateManifestBytes(raw); len(errs) > 0 {
			t.Errorf("pulsar-vault AppManifest.json invalid: %v", errs)
		}
	}
}
