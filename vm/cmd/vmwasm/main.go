//go:build js && wasm

package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	pulsarscriptvm "github.com/PulsarDynamics/pulsarscript/vm"
)

type runOptions struct {
	MockHost         bool            `json:"mockHost"`
	SeedMockFS       bool            `json:"seedMockFS"`
	Capabilities     map[string]bool `json:"capabilities"`
	AutoResumeYield  *bool           `json:"autoResumeYield"`
	Seed             int64           `json:"seed"`
	MaxSteps         int             `json:"maxSteps"`
	MaxDurationMs    float64         `json:"maxDurationMs"`
	MaxStringBytes   int             `json:"maxStringBytes"`
	MaxCollectionLen int             `json:"maxCollectionLen"`
	MaxMemoryBytes   int64           `json:"maxMemoryBytes"`
	MaxHeapCount     int             `json:"maxHeapCount"`
}

type mockHostCallRecord struct {
	Name       string `json:"name"`
	Capability string `json:"capability"`
	Args       []any  `json:"args"`
	Result     any    `json:"result"`
	Mock       bool   `json:"mock"`
}

func (m mockHostCallRecord) AppendJSON(dst []byte) []byte {
	dst = append(dst, `{"name":`...)
	dst = pulsarscriptvm.AppendJSONString(dst, m.Name)
	dst = append(dst, `,"capability":`...)
	dst = pulsarscriptvm.AppendJSONString(dst, m.Capability)
	dst = append(dst, `,"args":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, m.Args)
	dst = append(dst, `,"result":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, m.Result)
	dst = append(dst, `,"mock":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, m.Mock)
	return append(dst, '}')
}

type mockCallSlice []mockHostCallRecord

func (s mockCallSlice) AppendJSON(dst []byte) []byte {
	return pulsarscriptvm.AppendJSONSlice(dst, s)
}

type breakpointSlice []pulsarscriptvm.Breakpoint

func (s breakpointSlice) AppendJSON(dst []byte) []byte {
	return pulsarscriptvm.AppendJSONSlice(dst, s)
}

type runResponse struct {
	OK             bool                 `json:"ok"`
	Stage          string               `json:"stage"`
	Output         string               `json:"output"`
	Prints         []string             `json:"prints"`
	Error          string               `json:"error,omitempty"`
	ErrorLine      int                  `json:"errorLine,omitempty"`
	Handlers       []string             `json:"handlers"`
	EventListeners []string             `json:"eventListeners"`
	Events         []string             `json:"events"`
	DeniedCalls    []string             `json:"deniedCalls"`
	MockHostCalls  []mockHostCallRecord `json:"mockHostCalls"`
	Stats          runStats             `json:"stats"`
}

func (r runResponse) AppendJSON(dst []byte) []byte {
	dst = append(dst, `{"ok":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, r.OK)
	dst = append(dst, `,"stage":`...)
	dst = pulsarscriptvm.AppendJSONString(dst, r.Stage)
	dst = append(dst, `,"output":`...)
	dst = pulsarscriptvm.AppendJSONString(dst, r.Output)
	dst = append(dst, `,"prints":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, r.Prints)
	if r.Error != "" {
		dst = append(dst, `,"error":`...)
		dst = pulsarscriptvm.AppendJSONString(dst, r.Error)
	}
	if r.ErrorLine != 0 {
		dst = append(dst, `,"errorLine":`...)
		dst = strconv.AppendInt(dst, int64(r.ErrorLine), 10)
	}
	dst = append(dst, `,"handlers":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, r.Handlers)
	dst = append(dst, `,"eventListeners":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, r.EventListeners)
	dst = append(dst, `,"events":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, r.Events)
	dst = append(dst, `,"deniedCalls":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, r.DeniedCalls)
	dst = append(dst, `,"mockHostCalls":`...)
	dst = pulsarscriptvm.AppendJSONSlice(dst, r.MockHostCalls)
	dst = append(dst, `,"stats":`...)
	dst = r.Stats.AppendJSON(dst)
	return append(dst, '}')
}

type runStats struct {
	Steps          int     `json:"steps"`
	MaxSteps       int     `json:"maxSteps"`
	MemBytes       int64   `json:"memBytes"`
	MaxMemoryBytes int64   `json:"maxMemoryBytes"`
	HeapObjects    int     `json:"heapObjects"`
	DurationMs     float64 `json:"durationMs"`
	MaxDurationMs  float64 `json:"maxDurationMs"`
	CodeLen        int     `json:"codeLen"`
	ConstantsLen   int     `json:"constantsLen"`
	FunctionsLen   int     `json:"functionsLen"`
}

func (s runStats) AppendJSON(dst []byte) []byte {
	dst = append(dst, `{"steps":`...)
	dst = strconv.AppendInt(dst, int64(s.Steps), 10)
	dst = append(dst, `,"maxSteps":`...)
	dst = strconv.AppendInt(dst, int64(s.MaxSteps), 10)
	dst = append(dst, `,"memBytes":`...)
	dst = strconv.AppendInt(dst, s.MemBytes, 10)
	dst = append(dst, `,"maxMemoryBytes":`...)
	dst = strconv.AppendInt(dst, s.MaxMemoryBytes, 10)
	dst = append(dst, `,"heapObjects":`...)
	dst = strconv.AppendInt(dst, int64(s.HeapObjects), 10)
	dst = append(dst, `,"durationMs":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, s.DurationMs)
	dst = append(dst, `,"maxDurationMs":`...)
	dst = pulsarscriptvm.AppendJSONAny(dst, s.MaxDurationMs)
	dst = append(dst, `,"codeLen":`...)
	dst = strconv.AppendInt(dst, int64(s.CodeLen), 10)
	dst = append(dst, `,"constantsLen":`...)
	dst = strconv.AppendInt(dst, int64(s.ConstantsLen), 10)
	dst = append(dst, `,"functionsLen":`...)
	dst = strconv.AppendInt(dst, int64(s.FunctionsLen), 10)
	return append(dst, '}')
}

func parseRunOptions(optsJSON string) (runOptions, error) {
	var opts runOptions
	if strings.TrimSpace(optsJSON) == "" {
		return opts, nil
	}
	parsed, err := pulsarscriptvm.ParseJSON([]byte(optsJSON))
	if err != nil {
		return opts, err
	}
	m, ok := parsed.(map[string]any)
	if !ok {
		return opts, errors.New("options JSON must be object")
	}
	if v, ok := m["mockHost"].(bool); ok {
		opts.MockHost = v
	}
	if v, ok := m["seedMockFS"].(bool); ok {
		opts.SeedMockFS = v
	}
	if capMap, ok := m["capabilities"].(map[string]any); ok {
		opts.Capabilities = make(map[string]bool, len(capMap))
		for k, rawVal := range capMap {
			if b, ok := rawVal.(bool); ok {
				opts.Capabilities[k] = b
			}
		}
	}
	if v, ok := m["autoResumeYield"].(bool); ok {
		b := v
		opts.AutoResumeYield = &b
	}
	if v, ok := m["seed"].(float64); ok {
		opts.Seed = int64(v)
	}
	if v, ok := m["maxSteps"].(float64); ok {
		opts.MaxSteps = int(v)
	}
	if v, ok := m["maxDurationMs"].(float64); ok {
		opts.MaxDurationMs = v
	}
	if v, ok := m["maxStringBytes"].(float64); ok {
		opts.MaxStringBytes = int(v)
	}
	if v, ok := m["maxCollectionLen"].(float64); ok {
		opts.MaxCollectionLen = int(v)
	}
	if v, ok := m["maxMemoryBytes"].(float64); ok {
		opts.MaxMemoryBytes = int64(v)
	}
	if v, ok := m["maxHeapCount"].(float64); ok {
		opts.MaxHeapCount = int(v)
	}
	return opts, nil
}

type capabilityDeniedError struct {
	fn  string
	cap string
}

func (e *capabilityDeniedError) Error() string {
	return fmt.Sprintf("Permission denied: '%s' requires capability '%s' (disabled in host sandbox).", e.fn, e.cap)
}

type mockSandboxHost struct {
	mu            sync.Mutex
	caps          map[string]bool
	files         map[string]string
	kv            map[string]pulsarscriptvm.Value
	events        []string
	deniedCalls   []string
	mockHostCalls []mockHostCallRecord
}

func newMockSandboxHost(caps map[string]bool, seed bool) *mockSandboxHost {
	h := &mockSandboxHost{
		caps:  caps,
		files: make(map[string]string),
		kv:    make(map[string]pulsarscriptvm.Value),
	}
	if seed {
		h.files["/docs/notes.md"] = "# PulsarOS Notes\nSandboxed scripts stay inside their budget."
		h.files["/docs/spec.md"] = "PulsarScript v1.2 — SPEC v1.0 · Bytecode v3"
		h.files["/docs/todo.txt"] = "1. Verify CoW\n2. Gate host calls"
		h.kv["theme"] = pulsarscriptvm.String("pulsar-dark")
		h.kv["lastDir"] = pulsarscriptvm.String("/docs")
	}
	return h
}

func (h *mockSandboxHost) requireCap(fnName string) (string, error) {
	info, ok := pulsarscriptvm.LookupHostFunction(fnName)
	if !ok || info.Capability == "" {
		return "", nil
	}
	if h.caps != nil {
		if allowed, exists := h.caps[info.Capability]; exists && !allowed {
			h.deniedCalls = append(h.deniedCalls, fmt.Sprintf("%s -> requires %s", fnName, info.Capability))
			return info.Capability, &capabilityDeniedError{fn: fnName, cap: info.Capability}
		}
	}
	return info.Capability, nil
}

func (h *mockSandboxHost) entriesFor(dirPath string) []pulsarscriptvm.Value {
	clean := strings.TrimSuffix(dirPath, "/")
	if clean == "" {
		clean = "/"
	}
	if clean == "/" {
		return []pulsarscriptvm.Value{
			pulsarscriptvm.Object(map[string]pulsarscriptvm.Value{
				"name":     pulsarscriptvm.String("assets"),
				"dir":      pulsarscriptvm.Bool(true),
				"size":     pulsarscriptvm.Number(0),
				"modified": pulsarscriptvm.Number(1732406400000),
			}),
			pulsarscriptvm.Object(map[string]pulsarscriptvm.Value{
				"name":     pulsarscriptvm.String("docs"),
				"dir":      pulsarscriptvm.Bool(true),
				"size":     pulsarscriptvm.Number(0),
				"modified": pulsarscriptvm.Number(1732406400000),
			}),
		}
	}
	prefix := clean + "/"
	var keys []string
	for p := range h.files {
		if strings.HasPrefix(p, prefix) {
			rest := strings.TrimPrefix(p, prefix)
			if !strings.Contains(rest, "/") {
				keys = append(keys, rest)
			}
		}
	}
	sort.Strings(keys)
	out := make([]pulsarscriptvm.Value, 0, len(keys)+1)
	for _, k := range keys {
		content := h.files[prefix+k]
		out = append(out, pulsarscriptvm.Object(map[string]pulsarscriptvm.Value{
			"name":     pulsarscriptvm.String(k),
			"dir":      pulsarscriptvm.Bool(false),
			"size":     pulsarscriptvm.Number(float64(len(content))),
			"modified": pulsarscriptvm.Number(1732406400000),
		}))
	}
	return out
}

func (h *mockSandboxHost) call(name string, args []pulsarscriptvm.Value) (pulsarscriptvm.Value, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	capName, err := h.requireCap(name)
	if err != nil {
		return pulsarscriptvm.Nil(), err
	}

	var res pulsarscriptvm.Value
	switch name {
	case "fsRead":
		if content, ok := h.files[args[0].String()]; ok {
			res = pulsarscriptvm.String(content)
		} else {
			res = pulsarscriptvm.Nil()
		}
	case "fsReadBase64":
		if content, ok := h.files[args[0].String()]; ok {
			res = pulsarscriptvm.String(base64.StdEncoding.EncodeToString([]byte(content)))
		} else {
			res = pulsarscriptvm.Nil()
		}
	case "fsWrite":
		h.files[args[0].String()] = args[1].String()
		res = pulsarscriptvm.Bool(true)
	case "fsWriteBase64":
		decoded, decErr := base64.StdEncoding.DecodeString(args[1].String())
		if decErr != nil {
			return pulsarscriptvm.Bool(false), decErr
		}
		h.files[args[0].String()] = string(decoded)
		res = pulsarscriptvm.Bool(true)
	case "fsList":
		res = pulsarscriptvm.Array(h.entriesFor(args[0].String()))
	case "fsStat":
		p := args[0].String()
		if content, ok := h.files[p]; ok {
			parts := strings.Split(p, "/")
			res = pulsarscriptvm.Object(map[string]pulsarscriptvm.Value{
				"name":     pulsarscriptvm.String(parts[len(parts)-1]),
				"dir":      pulsarscriptvm.Bool(false),
				"size":     pulsarscriptvm.Number(float64(len(content))),
				"modified": pulsarscriptvm.Number(1732406400000),
			})
		} else if p == "/docs" || p == "/assets" {
			res = pulsarscriptvm.Object(map[string]pulsarscriptvm.Value{
				"name":     pulsarscriptvm.String(strings.TrimPrefix(p, "/")),
				"dir":      pulsarscriptvm.Bool(true),
				"size":     pulsarscriptvm.Number(0),
				"modified": pulsarscriptvm.Number(1732406400000),
			})
		} else {
			res = pulsarscriptvm.Nil()
		}
	case "fsExists":
		p := args[0].String()
		_, ok := h.files[p]
		res = pulsarscriptvm.Bool(ok || p == "/docs" || p == "/assets")
	case "fsDelete":
		p := args[0].String()
		_, ok := h.files[p]
		delete(h.files, p)
		res = pulsarscriptvm.Bool(ok)
	case "fsMkdir":
		res = pulsarscriptvm.Bool(true)
	case "fsRename":
		val, ok := h.files[args[0].String()]
		if !ok {
			res = pulsarscriptvm.Bool(false)
		} else {
			delete(h.files, args[0].String())
			h.files[args[1].String()] = val
			res = pulsarscriptvm.Bool(true)
		}
	case "fsCopy":
		val, ok := h.files[args[0].String()]
		if !ok {
			res = pulsarscriptvm.Bool(false)
		} else {
			h.files[args[1].String()] = val
			res = pulsarscriptvm.Bool(true)
		}
	case "fsQuota":
		used := 0
		for _, v := range h.files {
			used += len(v)
		}
		res = pulsarscriptvm.Object(map[string]pulsarscriptvm.Value{
			"used": pulsarscriptvm.Number(float64(used)),
			"max":  pulsarscriptvm.Number(1024 * 1024),
		})
	case "kvGet":
		if v, ok := h.kv[args[0].String()]; ok {
			res = v
		} else {
			res = pulsarscriptvm.Nil()
		}
	case "kvSet":
		h.kv[args[0].String()] = args[1]
		res = pulsarscriptvm.Bool(true)
	case "kvDelete":
		k := args[0].String()
		_, ok := h.kv[k]
		delete(h.kv, k)
		res = pulsarscriptvm.Bool(ok)
	case "emitEvent":
		payload := pulsarscriptvm.Nil()
		if len(args) > 0 {
			payload = args[0]
		}
		h.events = append(h.events, payload.String())
		res = pulsarscriptvm.Nil()
	case "pollEvent":
		if len(h.events) == 0 {
			res = pulsarscriptvm.Nil()
		} else {
			ev := h.events[0]
			h.events = h.events[1:]
			res = pulsarscriptvm.String(ev)
		}
	case "notifyWindow":
		h.events = append(h.events, "window: "+args[0].String())
		res = pulsarscriptvm.Nil()
	case "ipcSetContext":
		res = pulsarscriptvm.Nil()
	case "ipcSend":
		res = pulsarscriptvm.Object(map[string]pulsarscriptvm.Value{
			"mock":    pulsarscriptvm.Bool(true),
			"channel": args[0],
			"op":      args[1],
		})
	default:
		res = pulsarscriptvm.Nil()
	}

	argList := make([]any, len(args))
	for i, a := range args {
		argList[i] = pulsarscriptvm.ToInterface(a)
	}
	h.mockHostCalls = append(h.mockHostCalls, mockHostCallRecord{
		Name:       name,
		Capability: capName,
		Args:       argList,
		Result:     pulsarscriptvm.ToInterface(res),
		Mock:       true,
	})
	return res, nil
}

func buildVMConfig(opts runOptions) pulsarscriptvm.VMConfig {
	cfg := pulsarscriptvm.DefaultVMConfig()
	if opts.MaxSteps < 0 {
		cfg.MaxSteps = -1
	} else if opts.MaxSteps > 0 {
		cfg.MaxSteps = opts.MaxSteps
	}
	if opts.MaxDurationMs < 0 {
		cfg.MaxDuration = -1
	} else if opts.MaxDurationMs > 0 {
		cfg.MaxDuration = time.Duration(opts.MaxDurationMs * float64(time.Millisecond))
	}
	if opts.MaxStringBytes < 0 {
		cfg.MaxStringBytes = -1
	} else if opts.MaxStringBytes > 0 {
		cfg.MaxStringBytes = opts.MaxStringBytes
	}
	if opts.MaxCollectionLen < 0 {
		cfg.MaxCollectionLen = -1
	} else if opts.MaxCollectionLen > 0 {
		cfg.MaxCollectionLen = opts.MaxCollectionLen
	}
	if opts.MaxMemoryBytes < 0 {
		cfg.MaxMemoryBytes = -1
	} else if opts.MaxMemoryBytes > 0 {
		cfg.MaxMemoryBytes = opts.MaxMemoryBytes
	}
	if opts.MaxHeapCount < 0 {
		cfg.MaxHeapCount = -1
	} else if opts.MaxHeapCount > 0 {
		cfg.MaxHeapCount = opts.MaxHeapCount
	}
	return cfg
}

type vmSession struct {
	vm       *pulsarscriptvm.VM
	prints   *[]string
	mockHost *mockSandboxHost
}

type debugSession struct {
	dbg      *pulsarscriptvm.Debugger
	prints   *[]string
	mockHost *mockSandboxHost
}

var (
	sessionMu     sync.Mutex
	nextSessionID int
	rpcSessions   = make(map[int]*vmSession)
	debugSessions = make(map[int]*debugSession)
)

func createVMFromOptions(bytecodeJSON string, optsJSON string) (*pulsarscriptvm.VM, *[]string, *mockSandboxHost, pulsarscriptvm.Module, error) {
	opts, err := parseRunOptions(optsJSON)
	if err != nil {
		return nil, nil, nil, pulsarscriptvm.Module{}, fmt.Errorf("invalid options: %w", err)
	}
	mod, err := pulsarscriptvm.LoadModule([]byte(bytecodeJSON))
	if err != nil {
		return nil, nil, nil, pulsarscriptvm.Module{}, err
	}
	cfg := buildVMConfig(opts)
	prints := make([]string, 0)
	var mockHost *mockSandboxHost
	var hostCallFn func(string, []pulsarscriptvm.Value) (pulsarscriptvm.Value, error)
	if opts.MockHost {
		mockHost = newMockSandboxHost(opts.Capabilities, opts.SeedMockFS)
		hostCallFn = mockHost.call
	} else {
		hostCallFn = func(_ string, _ []pulsarscriptvm.Value) (pulsarscriptvm.Value, error) {
			return pulsarscriptvm.Nil(), nil
		}
	}
	machine := pulsarscriptvm.NewVMWithConfig(mod, pulsarscriptvm.HostCallbacks{
		Print: func(v pulsarscriptvm.Value) {
			prints = append(prints, v.String())
		},
		HostCall: hostCallFn,
	}, cfg)
	if opts.Seed != 0 {
		machine.SetSeed(opts.Seed)
	}
	return machine, &prints, mockHost, mod, nil
}

func stageForError(err error) string {
	var capErr *capabilityDeniedError
	switch {
	case errors.As(err, &capErr):
		return "capability"
	case errors.Is(err, pulsarscriptvm.ErrMemoryLimit):
		return "memory"
	case errors.Is(err, pulsarscriptvm.ErrStepBudgetExceeded), errors.Is(err, pulsarscriptvm.ErrTimeBudgetExceeded):
		return "budget"
	default:
		return "runtime"
	}
}

func errorLineFromErr(err error) int {
	var re *pulsarscriptvm.RuntimeError
	if errors.As(err, &re) {
		return re.Line
	}
	var me *pulsarscriptvm.MemoryLimitError
	if errors.As(err, &me) {
		return me.Line
	}
	return 0
}

func makePromise(fn func() string) js.Value {
	var cb js.Func
	cb = js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve := args[0]
		go func() {
			defer func() {
				if r := recover(); r != nil {
					resolve.Invoke(marshalJSON(map[string]any{
						"ok":    false,
						"stage": "runtime",
						"error": fmt.Sprintf("panic: %v", r),
					}))
				}
			}()
			resolve.Invoke(fn())
		}()
		return nil
	})
	p := js.Global().Get("Promise").New(cb)
	cb.Release()
	return p
}

func marshalJSON(v any) string {
	return pulsarscriptvm.MarshalJSONAny(v)
}

func verifyModuleJS(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return marshalJSON(map[string]any{"ok": false, "error": "missing bytecode JSON"})
	}
	mod, err := pulsarscriptvm.LoadModule([]byte(args[0].String()))
	if err != nil {
		return marshalJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	return marshalJSON(map[string]any{
		"ok":           true,
		"version":      mod.Version,
		"compiler":     mod.Compiler,
		"sourceHash":   mod.SourceHash,
		"codeLen":      len(mod.Code),
		"constantsLen": len(mod.Constants),
		"functions":    len(mod.Functions),
	})
}

func disassembleJS(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return marshalJSON(map[string]any{"ok": false, "error": "missing bytecode JSON"})
	}
	mod, err := pulsarscriptvm.LoadModule([]byte(args[0].String()))
	if err != nil {
		return marshalJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	machine := pulsarscriptvm.NewVM(mod, pulsarscriptvm.HostCallbacks{})
	return marshalJSON(map[string]any{"ok": true, "text": machine.Disassemble()})
}

func runAsyncJS(_ js.Value, args []js.Value) any {
	bytecodeJSON := ""
	optsJSON := ""
	if len(args) >= 1 {
		bytecodeJSON = args[0].String()
	}
	if len(args) >= 2 && args[1].Type() == js.TypeString {
		optsJSON = args[1].String()
	}
	return makePromise(func() string {
		opts, _ := parseRunOptions(optsJSON)
		autoResume := true
		if opts.AutoResumeYield != nil {
			autoResume = *opts.AutoResumeYield
		}
		t0 := time.Now()
		machine, prints, mockHost, mod, err := createVMFromOptions(bytecodeJSON, optsJSON)
		if err != nil {
			return marshalJSON(runResponse{
				OK:    false,
				Stage: "load",
				Error: err.Error(),
			})
		}

		var runErr error
		for {
			runErr = machine.Run()
			if runErr == nil {
				break
			}
			if errors.Is(runErr, pulsarscriptvm.ErrYielded) && autoResume {
				if d := machine.SleepRemaining(); d > 0 {
					time.Sleep(d)
				}
				machine.Resume()
				continue
			}
			break
		}

		durMs := float64(time.Since(t0).Microseconds()) / 1000.0
		memBytes, heapObjs := machine.LiveMemory()
		maxSteps, maxDur, maxMem, _ := machine.BudgetConfig()

		var evList []string
		for _, ev := range machine.DrainEvents() {
			evList = append(evList, ev.String())
		}
		var denied []string
		var mockCalls []mockHostCallRecord
		if mockHost != nil {
			evList = append(evList, mockHost.events...)
			denied = append(denied, mockHost.deniedCalls...)
			mockCalls = append(mockCalls, mockHost.mockHostCalls...)
		}

		resp := runResponse{
			OK:             runErr == nil,
			Stage:          "ok",
			Output:         strings.Join(*prints, "\n"),
			Prints:         *prints,
			Handlers:       machine.HandlerNames(),
			EventListeners: machine.EventListenerNames(),
			Events:         evList,
			DeniedCalls:    denied,
			MockHostCalls:  mockCalls,
			Stats: runStats{
				Steps:          machine.StepsUsed(),
				MaxSteps:       maxSteps,
				MemBytes:       memBytes,
				MaxMemoryBytes: maxMem,
				HeapObjects:    heapObjs,
				DurationMs:     durMs,
				MaxDurationMs:  float64(maxDur.Microseconds()) / 1000.0,
				CodeLen:        len(mod.Code),
				ConstantsLen:   len(mod.Constants),
				FunctionsLen:   len(mod.Functions),
			},
		}
		if runErr != nil {
			resp.Stage = stageForError(runErr)
			resp.Error = runErr.Error()
			resp.ErrorLine = errorLineFromErr(runErr)
		}
		return marshalJSON(resp)
	})
}

func createSessionJS(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return marshalJSON(map[string]any{"ok": false, "error": "missing bytecode JSON"})
	}
	optsJSON := ""
	if len(args) >= 2 && args[1].Type() == js.TypeString {
		optsJSON = args[1].String()
	}
	machine, prints, mockHost, _, err := createVMFromOptions(args[0].String(), optsJSON)
	if err != nil {
		return marshalJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	if err := machine.Run(); err != nil {
		return marshalJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	sessionMu.Lock()
	nextSessionID++
	id := nextSessionID
	rpcSessions[id] = &vmSession{vm: machine, prints: prints, mockHost: mockHost}
	sessionMu.Unlock()
	return marshalJSON(map[string]any{
		"ok":        true,
		"sessionId": id,
		"handlers":  machine.HandlerNames(),
	})
}

func dispatchHandlerAsyncJS(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return makePromise(func() string {
			return marshalJSON(map[string]any{"ok": false, "error": "expected (sessionId, handler, argsJson)"})
		})
	}
	id := args[0].Int()
	handler := args[1].String()
	argsJSON := "[]"
	if len(args) >= 3 && args[2].Type() == js.TypeString {
		argsJSON = args[2].String()
	}
	return makePromise(func() string {
		sessionMu.Lock()
		sess := rpcSessions[id]
		sessionMu.Unlock()
		if sess == nil {
			return marshalJSON(map[string]any{"ok": false, "error": "unknown session"})
		}
		var rawArgs []any
		if strings.TrimSpace(argsJSON) != "" {
			parsedArgs, err := pulsarscriptvm.ParseJSON([]byte(argsJSON))
			if err != nil {
				return marshalJSON(map[string]any{"ok": false, "error": err.Error()})
			}
			arr, ok := parsedArgs.([]any)
			if !ok {
				return marshalJSON(map[string]any{"ok": false, "error": "handler args must be a JSON array"})
			}
			rawArgs = arr
		}
		vmArgs := make([]pulsarscriptvm.Value, len(rawArgs))
		for i, a := range rawArgs {
			v, convErr := pulsarscriptvm.FromInterface(a)
			if convErr != nil {
				return marshalJSON(map[string]any{"ok": false, "error": convErr.Error()})
			}
			vmArgs[i] = v
		}
		*sess.prints = (*sess.prints)[:0]
		t0 := time.Now()
		res, err := sess.vm.DispatchHandler(handler, vmArgs)
		durMs := float64(time.Since(t0).Microseconds()) / 1000.0
		if err != nil {
			return marshalJSON(map[string]any{
				"ok":         false,
				"stage":      stageForError(err),
				"error":      err.Error(),
				"prints":     *sess.prints,
				"durationMs": durMs,
			})
		}
		return marshalJSON(map[string]any{
			"ok":         true,
			"result":     pulsarscriptvm.ToInterface(res),
			"prints":     *sess.prints,
			"durationMs": durMs,
		})
	})
}

func disposeSessionJS(_ js.Value, args []js.Value) any {
	if len(args) >= 1 {
		sessionMu.Lock()
		delete(rpcSessions, args[0].Int())
		sessionMu.Unlock()
	}
	return nil
}

func createDebugSessionJS(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return marshalJSON(map[string]any{"ok": false, "error": "missing bytecode JSON"})
	}
	optsJSON := ""
	if len(args) >= 2 && args[1].Type() == js.TypeString {
		optsJSON = args[1].String()
	}
	machine, prints, mockHost, _, err := createVMFromOptions(args[0].String(), optsJSON)
	if err != nil {
		return marshalJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	dbg := pulsarscriptvm.NewDebugger(machine)
	sessionMu.Lock()
	nextSessionID++
	id := nextSessionID
	debugSessions[id] = &debugSession{dbg: dbg, prints: prints, mockHost: mockHost}
	sessionMu.Unlock()
	return marshalJSON(map[string]any{
		"ok":        true,
		"sessionId": id,
		"snapshot":  dbg.Snapshot("paused"),
	})
}

func getDebugSession(id int) *debugSession {
	sessionMu.Lock()
	defer sessionMu.Unlock()
	return debugSessions[id]
}

func debugResponse(ds *debugSession, snap pulsarscriptvm.DebugSnapshot) string {
	var mockCalls []mockHostCallRecord
	var denied []string
	if ds.mockHost != nil {
		ds.mockHost.mu.Lock()
		mockCalls = append(mockCalls, ds.mockHost.mockHostCalls...)
		denied = append(denied, ds.mockHost.deniedCalls...)
		ds.mockHost.mu.Unlock()
	}
	return marshalJSON(map[string]any{
		"ok":            true,
		"snapshot":      snap,
		"prints":        *ds.prints,
		"output":        strings.Join(*ds.prints, "\n"),
		"mockHostCalls": mockCallSlice(mockCalls),
		"deniedCalls":   denied,
	})
}

func debugSetBreakpointsJS(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return marshalJSON(map[string]any{"ok": false, "error": "expected (sessionId, breakpointsJson)"})
	}
	ds := getDebugSession(args[0].Int())
	if ds == nil {
		return marshalJSON(map[string]any{"ok": false, "error": "unknown debug session"})
	}
	parsedBps, err := pulsarscriptvm.ParseJSON([]byte(args[1].String()))
	if err != nil {
		return marshalJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	rawArr, ok := parsedBps.([]any)
	if !ok {
		return marshalJSON(map[string]any{"ok": false, "error": "breakpoints must be a JSON array"})
	}
	bps := make([]pulsarscriptvm.Breakpoint, 0, len(rawArr))
	for _, entry := range rawArr {
		m, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		var bp pulsarscriptvm.Breakpoint
		if f, ok := m["file"].(string); ok {
			bp.File = f
		}
		if ln, ok := m["line"].(float64); ok {
			bp.Line = int(ln)
		}
		bps = append(bps, bp)
	}
	ds.dbg.ClearBreakpoints()
	for _, bp := range bps {
		ds.dbg.AddBreakpoint(bp.File, bp.Line)
	}
	return marshalJSON(map[string]any{"ok": true, "breakpoints": breakpointSlice(ds.dbg.Breakpoints())})
}

func debugStepActionJS(action string) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 1 {
			return makePromise(func() string {
				return marshalJSON(map[string]any{"ok": false, "error": "missing sessionId"})
			})
		}
		id := args[0].Int()
		return makePromise(func() string {
			ds := getDebugSession(id)
			if ds == nil {
				return marshalJSON(map[string]any{"ok": false, "error": "unknown debug session"})
			}
			var snap pulsarscriptvm.DebugSnapshot
			switch action {
			case "continue":
				snap = ds.dbg.Continue()
			case "stepIn":
				snap = ds.dbg.StepIn()
			case "stepOver":
				snap = ds.dbg.StepOver()
			case "stepOut":
				snap = ds.dbg.StepOut()
			case "stepInstruction":
				snap = ds.dbg.StepInstruction()
			default:
				snap = ds.dbg.Snapshot("paused")
			}
			return debugResponse(ds, snap)
		})
	})
}

func debugSnapshotJS(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return marshalJSON(map[string]any{"ok": false, "error": "missing sessionId"})
	}
	ds := getDebugSession(args[0].Int())
	if ds == nil {
		return marshalJSON(map[string]any{"ok": false, "error": "unknown debug session"})
	}
	return debugResponse(ds, ds.dbg.Snapshot("paused"))
}

func debugDisposeJS(_ js.Value, args []js.Value) any {
	if len(args) >= 1 {
		sessionMu.Lock()
		delete(debugSessions, args[0].Int())
		sessionMu.Unlock()
	}
	return nil
}

func main() {
	api := map[string]any{
		"version":              "1.2.0",
		"verifyModule":         js.FuncOf(verifyModuleJS),
		"disassemble":          js.FuncOf(disassembleJS),
		"runAsync":             js.FuncOf(runAsyncJS),
		"createSession":        js.FuncOf(createSessionJS),
		"dispatchHandlerAsync": js.FuncOf(dispatchHandlerAsyncJS),
		"disposeSession":       js.FuncOf(disposeSessionJS),
		"createDebugSession":   js.FuncOf(createDebugSessionJS),
		"debugSetBreakpoints":  js.FuncOf(debugSetBreakpointsJS),
		"debugContinue":        debugStepActionJS("continue"),
		"debugStepIn":          debugStepActionJS("stepIn"),
		"debugStepOver":        debugStepActionJS("stepOver"),
		"debugStepOut":         debugStepActionJS("stepOut"),
		"debugStepInstruction": debugStepActionJS("stepInstruction"),
		"debugSnapshot":        js.FuncOf(debugSnapshotJS),
		"debugDispose":         js.FuncOf(debugDisposeJS),
	}
	js.Global().Set("PulsarWasmVM", js.ValueOf(api))
	select {}
}
