package vm

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"sort"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

type sandboxFile struct {
	data     []byte
	modified float64
}

type vaultSandboxHost struct {
	files        map[string]*sandboxFile
	dirs         map[string]bool
	kv           map[string]Value
	quotaMax     int
	emitted      []Value
	windowEvents []Value
}

func newVaultSandboxHost() *vaultSandboxHost {
	return &vaultSandboxHost{
		files:    map[string]*sandboxFile{},
		dirs:     map[string]bool{"": true},
		kv:       map[string]Value{},
		quotaMax: 1024 * 1024,
	}
}

func (h *vaultSandboxHost) normalizePath(raw string) (string, error) {
	cleaned := strings.Trim(strings.ReplaceAll(raw, "\\", "/"), "/")
	if cleaned == "" || cleaned == "." {
		return "", nil
	}
	for _, seg := range strings.Split(cleaned, "/") {
		if seg == ".." {
			return "", fmt.Errorf("path traversal blocked: %s", raw)
		}
	}
	p := path.Clean(cleaned)
	if p == "." {
		return "", nil
	}
	return p, nil
}

func (h *vaultSandboxHost) ensureParents(filePath string) {
	dir := path.Dir(filePath)
	for dir != "." && dir != "" {
		h.dirs[dir] = true
		dir = path.Dir(dir)
	}
}

func (h *vaultSandboxHost) usedBytes() int {
	total := 0
	for _, f := range h.files {
		total += len(f.data)
	}
	return total
}

func (h *vaultSandboxHost) callbacks() HostCallbacks {
	nowMs := func() float64 { return float64(time.Now().UnixMilli()) }

	return HostCallbacks{
		HostCall: func(name string, args []Value) (Value, error) {
			switch name {
			case "fsRead":
				p, err := h.normalizePath(args[0].String())
				if err != nil {
					return Nil(), err
				}
				f, ok := h.files[p]
				if !ok {
					return Nil(), nil
				}
				return String(string(f.data)), nil

			case "fsWrite":
				p, err := h.normalizePath(args[0].String())
				if err != nil {
					return Bool(false), err
				}
				h.ensureParents(p)
				h.files[p] = &sandboxFile{
					data:     []byte(args[1].String()),
					modified: nowMs(),
				}
				return Bool(true), nil

			case "fsList":
				dir, err := h.normalizePath(args[0].String())
				if err != nil {
					return Nil(), err
				}
				prefix := ""
				if dir != "" {
					prefix = dir + "/"
				}
				entriesMap := map[string]Value{}
				for d := range h.dirs {
					if d == "" || d == dir || !strings.HasPrefix(d, prefix) {
						continue
					}
					rest := strings.TrimPrefix(d, prefix)
					if rest == "" || strings.Contains(rest, "/") {
						continue
					}
					entriesMap[rest] = Object(map[string]Value{
						"name":     String(rest),
						"dir":      Bool(true),
						"size":     Number(0),
						"modified": Number(nowMs()),
					})
				}
				for fp, f := range h.files {
					if !strings.HasPrefix(fp, prefix) {
						continue
					}
					rest := strings.TrimPrefix(fp, prefix)
					if rest == "" || strings.Contains(rest, "/") {
						continue
					}
					entriesMap[rest] = Object(map[string]Value{
						"name":     String(rest),
						"dir":      Bool(false),
						"size":     Number(float64(len(f.data))),
						"modified": Number(f.modified),
					})
				}
				names := make([]string, 0, len(entriesMap))
				for k := range entriesMap {
					names = append(names, k)
				}
				sort.Strings(names)
				out := make([]Value, 0, len(names))
				for _, k := range names {
					out = append(out, entriesMap[k])
				}
				return Array(out), nil

			case "fsStat":
				p, err := h.normalizePath(args[0].String())
				if err != nil {
					return Nil(), err
				}
				if f, ok := h.files[p]; ok {
					return Object(map[string]Value{
						"name":     String(path.Base(p)),
						"dir":      Bool(false),
						"size":     Number(float64(len(f.data))),
						"modified": Number(f.modified),
					}), nil
				}
				if h.dirs[p] {
					return Object(map[string]Value{
						"name":     String(path.Base(p)),
						"dir":      Bool(true),
						"size":     Number(0),
						"modified": Number(nowMs()),
					}), nil
				}
				return Nil(), nil

			case "fsExists":
				p, err := h.normalizePath(args[0].String())
				if err != nil {
					return Bool(false), err
				}
				_, isFile := h.files[p]
				return Bool(isFile || h.dirs[p]), nil

			case "fsMkdir":
				p, err := h.normalizePath(args[0].String())
				if err != nil {
					return Bool(false), err
				}
				if p != "" {
					h.dirs[p] = true
					h.ensureParents(p)
				}
				return Bool(true), nil

			case "fsDelete":
				p, err := h.normalizePath(args[0].String())
				if err != nil {
					return Bool(false), err
				}
				deleted := false
				if _, ok := h.files[p]; ok {
					delete(h.files, p)
					deleted = true
				}
				prefix := p + "/"
				for fp := range h.files {
					if strings.HasPrefix(fp, prefix) {
						delete(h.files, fp)
						deleted = true
					}
				}
				for d := range h.dirs {
					if d == p || strings.HasPrefix(d, prefix) {
						delete(h.dirs, d)
						deleted = true
					}
				}
				return Bool(deleted), nil

			case "fsRename":
				from, err := h.normalizePath(args[0].String())
				if err != nil {
					return Bool(false), err
				}
				to, err := h.normalizePath(args[1].String())
				if err != nil {
					return Bool(false), err
				}
				if f, ok := h.files[from]; ok {
					h.ensureParents(to)
					delete(h.files, from)
					h.files[to] = &sandboxFile{data: f.data, modified: nowMs()}
					return Bool(true), nil
				}
				return Bool(false), nil

			case "fsCopy":
				from, err := h.normalizePath(args[0].String())
				if err != nil {
					return Bool(false), err
				}
				to, err := h.normalizePath(args[1].String())
				if err != nil {
					return Bool(false), err
				}
				if f, ok := h.files[from]; ok {
					cp := append([]byte(nil), f.data...)
					h.ensureParents(to)
					h.files[to] = &sandboxFile{data: cp, modified: nowMs()}
					return Bool(true), nil
				}
				return Bool(false), nil

			case "fsQuota":
				return Object(map[string]Value{
					"used": Number(float64(h.usedBytes())),
					"max":  Number(float64(h.quotaMax)),
				}), nil

			case "fsWriteBase64":
				p, err := h.normalizePath(args[0].String())
				if err != nil {
					return Bool(false), err
				}
				rawBytes, err := base64.StdEncoding.DecodeString(args[1].String())
				if err != nil {
					return Bool(false), err
				}
				h.ensureParents(p)
				h.files[p] = &sandboxFile{data: rawBytes, modified: nowMs()}
				return Bool(true), nil

			case "fsReadBase64":
				p, err := h.normalizePath(args[0].String())
				if err != nil {
					return Nil(), err
				}
				f, ok := h.files[p]
				if !ok {
					return Nil(), nil
				}
				return String(base64.StdEncoding.EncodeToString(f.data)), nil

			case "kvGet":
				if v, ok := h.kv[args[0].String()]; ok {
					return v, nil
				}
				return Nil(), nil

			case "kvSet":
				h.kv[args[0].String()] = args[1]
				return Bool(true), nil

			case "kvDelete":
				_, existed := h.kv[args[0].String()]
				delete(h.kv, args[0].String())
				return Bool(existed), nil

			case "notifyWindow":
				h.windowEvents = append(h.windowEvents, args[0])
				return Nil(), nil

			default:
				return Nil(), fmt.Errorf("unexpected host call %s", name)
			}
		},
		EmitEvent: func(v Value) (Value, error) {
			h.emitted = append(h.emitted, v)
			return Nil(), nil
		},
	}
}

func assertOkResult(t *testing.T, res Value, label string) {
	t.Helper()
	okVal, has := res.objectGet("ok")
	if !has || !okVal.Bool() {
		t.Fatalf("%s did not return ok=true: %v", label, res.repr())
	}
}

func TestPulsarVaultBundleAndGoVME2E(t *testing.T) {
	rawBundle, err := os.ReadFile("../examples/apps/pulsar-vault/scripts/main.json")
	if err != nil {
		t.Fatalf("read compiled vault bundle: %v", err)
	}
	mod, err := LoadModule(rawBundle)
	if err != nil {
		t.Fatalf("LoadModule failed: %v", err)
	}

	rawManifest, err := os.ReadFile("../examples/apps/pulsar-vault/AppManifest.json")
	if err != nil {
		t.Fatalf("read AppManifest.json: %v", err)
	}
	var manifest struct {
		ID     string `json:"id"`
		Script struct {
			Handlers []struct {
				Name string `json:"name"`
				Mode string `json:"mode"`
			} `json:"handlers"`
		} `json:"script"`
	}
	if err := json.Unmarshal(rawManifest, &manifest); err != nil {
		t.Fatalf("unmarshal AppManifest.json: %v", err)
	}
	if manifest.ID != "com.pulsaros.pulsar-vault" {
		t.Fatalf("manifest.id = %q", manifest.ID)
	}

	host := newVaultSandboxHost()
	rpcCfg := RPCVMConfig()
	rpcVM := NewVMWithConfig(mod, host.callbacks(), rpcCfg)
	if err := rpcVM.Run(); err != nil {
		t.Fatalf("RPCVM Run failed: %v", err)
	}

	// Ensure every declared handler in AppManifest.json exists on the VM.
	for _, h := range manifest.Script.Handlers {
		if _, ok := rpcVM.handlers[h.Name]; !ok {
			t.Fatalf("manifest declares handler %q not registered by bundle", h.Name)
		}
	}

	// 1. initVault
	initRes, err := rpcVM.DispatchHandler("initVault", []Value{Object(map[string]Value{})})
	if err != nil {
		t.Fatalf("initVault failed: %v", err)
	}
	assertOkResult(t, initRes, "initVault")
	totalCount, _ := initRes.objectGet("totalCount")
	if int(totalCount.Number()) != 4 {
		t.Fatalf("initVault totalCount = %v, want 4", totalCount.Number())
	}
	if _, ok := host.files["index.json"]; !ok {
		t.Fatalf("expected index.json after initVault")
	}
	if _, ok := host.files["snapshots/latest.json"]; !ok {
		t.Fatalf("expected snapshots/latest.json after initVault")
	}

	// 2. saveNote with astral UTF-8 lock icon & tasks -> verifies UTF-8 Base64 parity
	saveRes, err := rpcVM.DispatchHandler("saveNote", []Value{
		Object(map[string]Value{
			"note": Object(map[string]Value{
				"title":  String("Alpha Go VM Spec 🔒"),
				"kind":   String("task"),
				"folder": String("specs"),
				"pinned": Bool(false),
				"tags":   Array([]Value{String("govm")}),
				"body":   String("Verify #closures and #utf8\n- [ ] Check Go Base64 snapshot\n- [x] Verify CoW tag index"),
			}),
		}),
	})
	if err != nil {
		t.Fatalf("saveNote failed: %v", err)
	}
	assertOkResult(t, saveRes, "saveNote")
	savedNote, _ := saveRes.objectGet("savedNote")
	createdIDVal, _ := savedNote.objectGet("id")
	createdID := createdIDVal.String()

	snapFile, ok := host.files["snapshots/"+createdID+".b64"]
	if !ok {
		t.Fatalf("expected binary Base64 snapshot for %s", createdID)
	}
	if !utf8.Valid(snapFile.data) {
		t.Fatalf("decoded Base64 snapshot is not valid UTF-8: %q", string(snapFile.data))
	}
	var snapJSON struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(snapFile.data, &snapJSON); err != nil {
		t.Fatalf("unmarshal snapshot JSON: %v", err)
	}
	if snapJSON.ID != createdID || snapJSON.Title != "Alpha Go VM Spec 🔒" {
		t.Fatalf("snapshot mismatch: %+v", snapJSON)
	}

	// 3. listNotes with title_asc / title_desc ordering & tag filter
	ascRes, err := rpcVM.DispatchHandler("listNotes", []Value{
		Object(map[string]Value{"sortBy": String("title_asc")}),
	})
	if err != nil {
		t.Fatalf("listNotes title_asc failed: %v", err)
	}
	ascNotes, _ := ascRes.objectGet("notes")
	var unpinnedAsc []string
	for i := 0; i < ascNotes.arrayLen(); i++ {
		n := ascNotes.arrayAt(i)
		p, _ := n.objectGet("pinned")
		if !p.Bool() {
			titleVal, _ := n.objectGet("title")
			unpinnedAsc = append(unpinnedAsc, titleVal.String())
		}
	}
	wantAsc := []string{"Alpha Go VM Spec 🔒", "CoW Tag Index & Closure Filter Snippet", "VM Budget & Telemetry Notes"}
	if len(unpinnedAsc) != len(wantAsc) {
		t.Fatalf("unpinnedAsc = %v, want %v", unpinnedAsc, wantAsc)
	}
	for i := range wantAsc {
		if unpinnedAsc[i] != wantAsc[i] {
			t.Fatalf("title_asc[%d] = %q, want %q", i, unpinnedAsc[i], wantAsc[i])
		}
	}

	// 4. toggleTask
	toggleRes, err := rpcVM.DispatchHandler("toggleTask", []Value{
		Object(map[string]Value{"id": String(createdID), "lineIndex": Number(1)}),
	})
	if err != nil {
		t.Fatalf("toggleTask failed: %v", err)
	}
	assertOkResult(t, toggleRes, "toggleTask")
	toggledDone, _ := toggleRes.objectGet("toggledDone")
	if !toggledDone.Bool() {
		t.Fatalf("expected toggledDone = true")
	}

	// 5. exportBundlePage pagination (markdown + base64)
	page1, err := rpcVM.DispatchHandler("exportBundlePage", []Value{
		Object(map[string]Value{"format": String("markdown"), "cursor": Number(0), "pageSize": Number(3)}),
	})
	if err != nil {
		t.Fatalf("exportBundlePage page1 failed: %v", err)
	}
	done1, _ := page1.objectGet("done")
	if done1.Bool() {
		t.Fatalf("expected page1 done=false")
	}
	nextCursor, _ := page1.objectGet("nextCursor")
	page2, err := rpcVM.DispatchHandler("exportBundlePage", []Value{
		Object(map[string]Value{"format": String("markdown"), "cursor": nextCursor, "pageSize": Number(3)}),
	})
	if err != nil {
		t.Fatalf("exportBundlePage page2 failed: %v", err)
	}
	done2, _ := page2.objectGet("done")
	if !done2.Bool() {
		t.Fatalf("expected page2 done=true")
	}

	// 6. KV prefs merge, clearKeys (objDelete), reset (kvDelete)
	prefRes, err := rpcVM.DispatchHandler("savePrefs", []Value{
		Object(map[string]Value{"pageSize": Number(2), "extraTag": String("go")}),
	})
	if err != nil {
		t.Fatalf("savePrefs failed: %v", err)
	}
	prefsObj, _ := prefRes.objectGet("prefs")
	if ps, _ := prefsObj.objectGet("pageSize"); int(ps.Number()) != 2 {
		t.Fatalf("expected pageSize=2, got %v", ps)
	}
	prefCleared, err := rpcVM.DispatchHandler("savePrefs", []Value{
		Object(map[string]Value{"clearKeys": Array([]Value{String("extraTag")})}),
	})
	if err != nil {
		t.Fatalf("savePrefs clearKeys failed: %v", err)
	}
	clearedObj, _ := prefCleared.objectGet("prefs")
	if _, hasExtra := clearedObj.objectGet("extraTag"); hasExtra {
		t.Fatalf("expected extraTag deleted via objDelete")
	}
	prefReset, err := rpcVM.DispatchHandler("savePrefs", []Value{
		Object(map[string]Value{"reset": Bool(true)}),
	})
	if err != nil {
		t.Fatalf("savePrefs reset failed: %v", err)
	}
	resetObj, _ := prefReset.objectGet("prefs")
	if ps, _ := resetObj.objectGet("pageSize"); int(ps.Number()) != 4 {
		t.Fatalf("expected reset pageSize=4, got %v", ps)
	}

	// 7. Corrupt JSON try/catch quarantine + stack frames
	corruptRes, err := rpcVM.DispatchHandler("injectCorruptSample", []Value{Object(map[string]Value{})})
	if err != nil {
		t.Fatalf("injectCorruptSample failed: %v", err)
	}
	corruptArr, _ := corruptRes.objectGet("corrupt")
	if corruptArr.arrayLen() != 1 {
		t.Fatalf("expected 1 quarantined corrupt note, got %d", corruptArr.arrayLen())
	}
	stackVal, _ := corruptArr.arrayAt(0).objectGet("stack")
	var stackFrames []string
	for i := 0; i < stackVal.arrayLen(); i++ {
		stackFrames = append(stackFrames, stackVal.arrayAt(i).String())
	}
	joinedStack := strings.Join(stackFrames, "\n")
	if !strings.Contains(joinedStack, "storage.puls") || !strings.Contains(joinedStack, "main.puls") {
		t.Fatalf("expected multi-file stack naming storage.puls and main.puls, got:\n%s", joinedStack)
	}
	cleanRes, err := rpcVM.DispatchHandler("clearCorruptSamples", []Value{Object(map[string]Value{})})
	if err != nil {
		t.Fatalf("clearCorruptSamples failed: %v", err)
	}
	cleanCorrupt, _ := cleanRes.objectGet("corrupt")
	if cleanCorrupt.arrayLen() != 0 {
		t.Fatalf("expected corrupt array cleared, got %d", cleanCorrupt.arrayLen())
	}

	// 8. deleteNote prunes bucket & decrements count
	delRes, err := rpcVM.DispatchHandler("deleteNote", []Value{
		Object(map[string]Value{"id": String(createdID)}),
	})
	if err != nil {
		t.Fatalf("deleteNote failed: %v", err)
	}
	if d, _ := delRes.objectGet("deleted"); !d.Bool() {
		t.Fatalf("expected deleted=true")
	}
	if _, ok := host.files["notes/"+createdID+".json"]; ok {
		t.Fatalf("note file still present after deleteNote")
	}

	// 9. Service mode VM reacts to external fs.change event via DispatchEvent -> EmitEvent + notifyWindow
	svcVM := NewVMWithConfig(mod, host.callbacks(), ServiceVMConfig())
	if err := svcVM.Run(); err != nil {
		t.Fatalf("ServiceVM Run failed: %v", err)
	}
	host.files["notes/external-go-sync.json"] = &sandboxFile{
		data:     []byte(`{"id":"external-go-sync","title":"External Go Sync","kind":"note","folder":"sync","tags":["sync"],"body":"Synced via Go service test\n- [ ] Check service emit"}`),
		modified: float64(time.Now().UnixMilli()),
	}
	if err := svcVM.DispatchEvent("fs.change", Object(map[string]Value{
		"path":   String("notes/external-go-sync.json"),
		"action": String("created"),
	})); err != nil {
		t.Fatalf("ServiceVM DispatchEvent failed: %v", err)
	}
	if len(host.emitted) == 0 || len(host.windowEvents) == 0 {
		t.Fatalf("expected both EmitEvent and notifyWindow on fs.change, got emitted=%d window=%d", len(host.emitted), len(host.windowEvents))
	}
	lastEvt := host.emitted[len(host.emitted)-1]
	evtName, _ := lastEvt.objectGet("name")
	if evtName.String() != "vault.sync" {
		t.Fatalf("emitted event name = %q, want vault.sync", evtName.String())
	}
	winLast := host.windowEvents[len(host.windowEvents)-1]
	winCount, _ := winLast.objectGet("totalCount")
	if int(winCount.Number()) != 5 {
		t.Fatalf("notifyWindow totalCount = %v, want 5", winCount.Number())
	}
}
