package vm

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
	"unsafe"
)

// Opcode definitions must match pulsarscript/Bytecode.ts
const (
	OpConst        byte = 0
	OpAdd          byte = 1
	OpSub          byte = 2
	OpMul          byte = 3
	OpDiv          byte = 4
	OpNeg          byte = 5
	OpEqual        byte = 6
	OpNotEqual     byte = 7
	OpGreater      byte = 8
	OpGreaterEqual byte = 9
	OpLess         byte = 10
	OpLessEqual    byte = 11
	OpPop          byte = 12
	OpPrint        byte = 13
	OpDefineGlobal byte = 14
	OpGetGlobal    byte = 15
	OpSetGlobal    byte = 16
	OpGetLocal     byte = 17
	OpSetLocal     byte = 18
	OpJump         byte = 19
	OpJumpIfFalse  byte = 20
	OpCall         byte = 21
	OpReturn       byte = 22
	OpHostCall     byte = 23
	OpHalt         byte = 24
	OpEnterBlock   byte = 25
	OpExitBlock    byte = 26
	OpEmitEvent    byte = 27
	OpPollEvent    byte = 28
	OpYield        byte = 29
	OpSleep        byte = 30
	OpNot          byte = 31
	OpAnd          byte = 32
	OpOr           byte = 33
	OpTryPush      byte = 34 // operand: catch handler offset
	OpTryPop       byte = 35 // remove current exception handler
	OpNewArray     byte = 36 // operand: element count; pops N elements, pushes array
	OpArrayGet     byte = 37 // pops index, pops array, pushes element
	OpArraySet     byte = 38 // pops value, pops index, pops array; sets element
	OpNewObject    byte = 39 // operand: property count; pops N key/value pairs, pushes object
	OpObjGet       byte = 40 // pops key, pops object, pushes value
	OpObjSet       byte = 41 // pops value, pops key, pops object; sets property
	// Bytecode version 2 (SPEC v0.5):
	OpIndexGet  byte = 42 // operand: 1 for o.key, 0 for x[k]; pops key, pops container, pushes element
	OpIndexSet  byte = 43 // operand: as INDEX_GET; pops value, key, container; pushes the updated copy
	OpMod       byte = 44 // pops b, pops a, pushes a % b
	OpFunc      byte = 45 // operand: function address; pushes a function value
	OpCallValue byte = 46 // operand: arg count; calls the function value below the arguments
	OpIterItems byte = 47 // pops x, pushes what for...of walks: array as is, object keys, string characters
	// Bytecode version 3 (SPEC v1.0):
	OpClosure      byte = 48 // operand: function address; allocates closure capturing upvalues
	OpGetUpvalue   byte = 49 // operand: upvalue slot; pushes captured value
	OpSetUpvalue   byte = 50 // operand: upvalue slot; stores top-of-stack and leaves it on stack
	OpCloseUpvalue byte = 51 // operand: local slot; closes open upvalue pointing to base + slot
)

const (
	maxStackDepth   = 1024
	maxCallDepth    = 256
	defaultEventCap = 64
)

var (
	ErrStepBudgetExceeded = errors.New("step budget exceeded")
	ErrTimeBudgetExceeded = errors.New("time budget exceeded")
	ErrMemoryLimit        = errors.New("memory limit exceeded")
	ErrYielded            = errors.New("yielded")
	ErrSuspended          = errors.New("suspended")
)

// MemoryLimitError is raised when a script exceeds its string, collection, heap, or live
// memory cap. It unwraps to ErrMemoryLimit and cannot be caught by try/catch.
type MemoryLimitError struct {
	Line int
	Msg  string
}

func (e *MemoryLimitError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("[line %d] memory limit exceeded: %s", e.Line, e.Msg)
	}
	return "memory limit exceeded: " + e.Msg
}

func (e *MemoryLimitError) Unwrap() error { return ErrMemoryLimit }

func isUncatchable(err error) bool {
	return errors.Is(err, ErrYielded) ||
		errors.Is(err, ErrSuspended) ||
		errors.Is(err, ErrStepBudgetExceeded) ||
		errors.Is(err, ErrTimeBudgetExceeded) ||
		errors.Is(err, ErrMemoryLimit)
}

// Value represents a VM value (number/string/bool/nil/array/object).
type Value struct {
	kind valueKind
	num  float64
	str  string
	b    bool
	arr  *pArray  // for arrays (CoW persistent)
	obj  *pObject // for objects (CoW persistent)
	cl   *closure // non-nil when value is a runtime closure
}

type upvalue struct {
	location int
	closed   Value
	next     *upvalue
}

type closure struct {
	fn       FunctionInfo
	upvalues []*upvalue
}

type handlerEntry struct {
	info FunctionInfo
	fn   Value
}

type valueKind int

// Kind exposes value kinds to host callers.
type Kind int

const (
	kindNil valueKind = iota
	kindNumber
	kindString
	kindBool
	kindArray
	kindObject
	kindFunction
)

const (
	KindNil Kind = iota
	KindNumber
	KindString
	KindBool
	KindArray
	KindObject
	KindFunction
)

func Number(v float64) Value              { return Value{kind: kindNumber, num: v} }
func String(v string) Value               { return Value{kind: kindString, str: v} }
func Bool(v bool) Value                   { return Value{kind: kindBool, b: v} }
func Nil() Value                          { return Value{kind: kindNil} }
func Array(elements []Value) Value        { return Value{kind: kindArray, arr: newPArray(elements)} }
func Object(props map[string]Value) Value { return Value{kind: kindObject, obj: newPObject(props)} }

func (v Value) arrayLen() int {
	if v.arr == nil {
		return 0
	}
	return v.arr.len()
}

func (v Value) arrayAt(i int) Value {
	return v.arr.at(i)
}

func (v Value) objectLen() int {
	if v.obj == nil {
		return 0
	}
	return v.obj.len()
}

func (v Value) objectGet(key string) (Value, bool) {
	if v.obj == nil {
		return Value{}, false
	}
	return v.obj.get(key)
}

func (v Value) objectKeys() []string {
	if v.obj == nil {
		return nil
	}
	return v.obj.keys()
}

// Function is a reference to a top-level function: its code address and name (SPEC 3.1).
func Function(address int, name string) Value {
	return Value{kind: kindFunction, num: float64(address), str: name}
}

func (v Value) Kind() Kind      { return Kind(v.kind) }
func (v Value) Number() float64 { return v.num }
func (v Value) Bool() bool      { return v.b }

// String renders a value as print() and string() show it (SPEC 3.2).
func (v Value) String() string {
	switch v.kind {
	case kindNil:
		return "nil"
	case kindNumber:
		return FormatNumber(v.num)
	case kindString:
		return v.str
	case kindBool:
		if v.b {
			return "true"
		}
		return "false"
	case kindArray:
		n := v.arrayLen()
		parts := make([]string, n)
		for i := 0; i < n; i++ {
			parts[i] = v.arrayAt(i).repr()
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case kindObject:
		if v.objectLen() == 0 {
			return "{}"
		}
		keys := v.objectKeys()
		parts := make([]string, len(keys))
		for i, k := range keys {
			name := k
			if !identRe.MatchString(k) {
				name = quoteJSON(k)
			}
			val, _ := v.objectGet(k)
			parts[i] = name + ": " + val.repr()
		}
		return "{" + strings.Join(parts, ", ") + "}"
	case kindFunction:
		if v.str == "" {
			return "<fn anonymous>"
		}
		return "<fn " + v.str + ">"
	default:
		return "<?>"
	}
}

// repr renders a value nested inside an array or object: strings are quoted.
func (v Value) repr() string {
	if v.kind == kindString {
		return quoteJSON(v.str)
	}
	return v.String()
}

// sortedKeys returns an object's keys in sorted order.
func sortedKeys(m map[string]Value) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

var identRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// quoteJSON writes s as a JSON string literal (no HTML escaping), as JSON.stringify does.
func quoteJSON(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSuffix(buf.String(), "\n")
}

// FormatNumber renders a number like JavaScript's Number#toString: the shortest form that
// round-trips, plain decimal for 1e-6 <= |x| < 1e21, exponent form ("1e+21", "1.5e-7")
// outside it, "0" for negative zero, and NaN / Infinity / -Infinity (SPEC 3.2, D14).
func FormatNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	if a := math.Abs(f); a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	mant, exp, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.TrimLeft(exp[1:], "0")
	if digits == "" {
		digits = "0"
	}
	return mant + "e" + exp[:1] + digits
}

// numberLiteralRe is the text number() accepts: optional sign, decimal digits with an
// optional fraction and exponent, surrounding whitespace allowed (SPEC 8).
var numberLiteralRe = regexp.MustCompile(`^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$`)

// typeName is the result of typeOf (SPEC 3).
func typeName(v Value) string {
	switch v.kind {
	case kindNil:
		return "nil"
	case kindNumber:
		return "number"
	case kindString:
		return "string"
	case kindBool:
		return "boolean"
	case kindArray:
		return "array"
	case kindObject:
		return "object"
	case kindFunction:
		return "function"
	default:
		return "unknown"
	}
}

// RuntimeError is a script error with its source line (0 when unknown).
type RuntimeError struct {
	Line int
	Msg  string
}

func (e *RuntimeError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("[line %d] %s", e.Line, e.Msg)
	}
	return e.Msg
}

// errorValue is what a catch block receives: {kind, line, message, stack} (SPEC 7, D7, LANG-06).
func errorValue(err error, line int) Value {
	return errorValueWithStack(err, line, []Value{})
}

func errorValueWithStack(err error, line int, stack []Value) Value {
	msg := err.Error()
	var re *RuntimeError
	if errors.As(err, &re) {
		msg = re.Msg
		if re.Line > 0 {
			line = re.Line
		}
	}
	lineVal := Nil()
	if line > 0 {
		lineVal = Number(float64(line))
	}
	if stack == nil {
		stack = []Value{}
	}
	return Object(map[string]Value{
		"kind":    String("runtime"),
		"line":    lineVal,
		"message": String(msg),
		"stack":   Array(stack),
	})
}

// Module is a compiled chunk: constants + code.
type Module struct {
	Constants       []Value
	Code            []int
	Functions       map[int]FunctionInfo
	FunctionsByName map[string]FunctionInfo
	LineMap         []int    // instruction index → source line number
	Sources         []string // source file paths (index 0 = entry module)
	FileMap         []int    // instruction index → Sources index

	// From the file header (A5); zero values for a version 0 file.
	Version    int    // bytecode format version
	Compiler   string // e.g. "pulsarscript 0.4.0"
	SourceHash string // "sha256:<hex>" of the source
}

// UpvalueDesc describes a variable captured by a closure.
type UpvalueDesc struct {
	IsLocal bool `json:"isLocal"`
	Index   int  `json:"index"`
}

// FunctionInfo describes a compiled function entry.
type FunctionInfo struct {
	Name     string        `json:"name"`
	Address  int           `json:"address"`
	Arity    int           `json:"arity"`
	Locals   int           `json:"locals"`
	Upvalues []UpvalueDesc `json:"upvalues,omitempty"`
	SelfSlot *int          `json:"selfSlot,omitempty"`
}

// LoadModule parses a JSON-encoded chunk {constants: [...], code: [...]}.
func LoadModule(data []byte) (Module, error) {
	var raw struct {
		Format     string         `json:"format"`
		Version    int            `json:"version"`
		Compiler   string         `json:"compiler"`
		SourceHash string         `json:"sourceHash"`
		Constants  []interface{}  `json:"constants"`
		Code       []int          `json:"code"`
		Functions  []FunctionInfo `json:"functions"`
		LineMap    []int          `json:"lineMap"`
		Sources    []string       `json:"sources"`
		FileMap    []int          `json:"fileMap"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return Module{}, err
	}
	if err := checkHeader(raw.Format, raw.Version); err != nil {
		return Module{}, err
	}
	constants := make([]Value, len(raw.Constants))
	for i, c := range raw.Constants {
		switch v := c.(type) {
		case nil:
			constants[i] = Nil()
		case bool:
			constants[i] = Bool(v)
		case float64:
			constants[i] = Number(v)
		case string:
			constants[i] = String(v)
		default:
			return Module{}, fmt.Errorf("unsupported constant type %T", c)
		}
	}
	funcs := make(map[int]FunctionInfo)
	funcsByName := make(map[string]FunctionInfo)
	for _, fn := range raw.Functions {
		funcs[fn.Address] = fn
		if fn.Name != "" {
			funcsByName[fn.Name] = fn
		}
	}
	mod := Module{
		Constants: constants, Code: raw.Code, Functions: funcs, FunctionsByName: funcsByName,
		LineMap: raw.LineMap, Sources: raw.Sources, FileMap: raw.FileMap,
		Version: raw.Version, Compiler: raw.Compiler, SourceHash: raw.SourceHash,
	}
	if err := VerifyModule(mod); err != nil {
		return Module{}, fmt.Errorf("invalid module: %w", err)
	}
	return mod, nil
}

// PendingHostCall describes an async host call awaiting resumption (LANG-11).
type PendingHostCall struct {
	Name string
	Args []Value
}

// HostCallbacks allow side effects like print logging and host syscalls.
type HostCallbacks struct {
	Print          func(Value)
	HostCall       func(name string, args []Value) (Value, error)
	EmitEvent      func(Value) (Value, error)
	ValidateResume func() error
}

// TickResult reports the outcome of a single tick.
type TickResult struct {
	Halted      bool
	Yielded     bool
	Sleeping    bool
	SleepFor    time.Duration
	Suspended   bool
	PendingCall *PendingHostCall
	Err         error
}

// VM executes PulsarScript bytecode.
type VM struct {
	module         Module
	ip             int
	stack          []Value
	host           HostCallbacks
	globals        map[string]Value
	halted         bool
	frames         []callFrame
	rootLocals     int
	events         []Value
	eventCap       int
	yielded        bool
	sleepUntil     time.Time
	handlers       map[string]handlerEntry
	eventListeners map[string][]Value
	openUpvalues   *upvalue      // open upvalues ordered by descending stack location
	excHandlers    []excHandler  // exception handler stack
	rng            *rand.Rand    // seeded PRNG for deterministic random
	opIP           int           // start of the instruction being executed, for CurrentLine
	maxSteps       int           // default step budget for Run/DispatchHandler (0 = unlimited)
	maxDuration    time.Duration // default time budget for Run/DispatchHandler (0 = unlimited)
	budgetActive   bool          // active RunWithBudget invocation state (shared with callValueSync)
	activeSteps    int
	activeMaxStp   int
	activeStart    time.Time
	activeMaxDur   time.Duration
	// Async host call suspension state (LANG-11)
	suspended        bool
	pendingCall      *PendingHostCall
	resumePending    bool
	resumeResult     Value
	resumeErr        error
	suspendedSteps   int
	suspendedElapsed time.Duration
	// Configurable limits
	maxStack         int   // maximum stack depth
	maxCalls         int   // maximum call frame depth
	maxHeap          int   // maximum live heap objects (0 = unlimited)
	maxStringBytes   int   // maximum bytes per single string (0 = unlimited)
	maxCollectionLen int   // maximum elements per single array/object (0 = unlimited)
	maxMemory        int64 // maximum estimated live memory in bytes (0 = unlimited)
	memBytes         int64 // cumulative allocation estimate since last recomputeLiveMemory
	heapObjects      int   // cumulative collection/closure allocations since last recompute
	// 1-entry O(1) string indexing & rune length cache (LANG-07)
	strCacheVal  string
	strCacheByte int
	strCacheRune int
	strCacheLen  int
}

// excHandler tracks a try/catch block's catch handler location
type excHandler struct {
	catchIP    int // IP to jump to on exception
	stackDepth int // stack depth when try was entered
	frameDepth int // call frames when try was entered; deeper frames are unwound (D19)
	locals     int // live locals of the entering frame when try was entered
}

type callFrame struct {
	returnIP int
	base     int
	locals   int
	name     string
	arity    int
	cl       *closure
	callLine int
	callFile string
}

// VMConfig provides configurable limits for VM instances.
//
// MaxSteps and MaxDuration bound Run and DispatchHandler (D10): every run is limited unless
// the host opts out, so a runaway script cannot hang its host. 0 selects the default; a
// negative value disables the limit. RunWithBudget and DispatchHandlerWithBudget take
// explicit budgets instead.
type VMConfig struct {
	MaxStackDepth    int           // Maximum stack depth (default: 1024)
	MaxCallDepth     int           // Maximum call frame depth (default: 256)
	MaxHeapCount     int           // Maximum live heap objects (arrays/objects/closures) (0 = DefaultMaxHeapCount, negative = unlimited)
	MaxStringBytes   int           // Maximum bytes in a single string (0 = DefaultMaxStringBytes, negative = unlimited)
	MaxCollectionLen int           // Maximum elements in a single array/object (0 = DefaultMaxCollectionLen, negative = unlimited)
	MaxMemoryBytes   int64         // Estimated live memory limit in bytes (0 = DefaultMaxMemoryBytes, negative = unlimited)
	MaxSteps         int           // Instructions per Run/DispatchHandler (0 = DefaultMaxSteps, negative = unlimited)
	MaxDuration      time.Duration // Wall time per Run/DispatchHandler (0 = DefaultMaxDuration, negative = unlimited)
}

// Default execution and memory budgets for Run and DispatchHandler.
const (
	DefaultMaxSteps         = 10_000_000
	DefaultMaxDuration      = 10 * time.Second
	DefaultMaxStringBytes   = 16 * 1024 * 1024  // 16 MiB
	DefaultMaxCollectionLen = 1_000_000         // 1,000,000 elements
	DefaultMaxMemoryBytes   = 256 * 1024 * 1024 // 256 MiB
	DefaultMaxHeapCount     = 1_000_000
)

// DefaultVMConfig returns the CLI/REPL default VM configuration.
func DefaultVMConfig() VMConfig {
	return VMConfig{
		MaxStackDepth:    maxStackDepth,
		MaxCallDepth:     maxCallDepth,
		MaxHeapCount:     DefaultMaxHeapCount,
		MaxStringBytes:   DefaultMaxStringBytes,
		MaxCollectionLen: DefaultMaxCollectionLen,
		MaxMemoryBytes:   DefaultMaxMemoryBytes,
		MaxSteps:         DefaultMaxSteps,
		MaxDuration:      DefaultMaxDuration,
	}
}

// RPCVMConfig returns tight per-call resource limits suitable for RPC handler execution.
func RPCVMConfig() VMConfig {
	return VMConfig{
		MaxStackDepth:    maxStackDepth,
		MaxCallDepth:     maxCallDepth,
		MaxHeapCount:     250_000,
		MaxStringBytes:   1 << 20,  // 1 MiB
		MaxCollectionLen: 100_000,  // 100,000 elements
		MaxMemoryBytes:   16 << 20, // 16 MiB
		MaxSteps:         250_000,
		MaxDuration:      1500 * time.Millisecond,
	}
}

// ServiceVMConfig returns resource limits suitable for long-lived service scripts.
func ServiceVMConfig() VMConfig {
	return VMConfig{
		MaxStackDepth:    maxStackDepth,
		MaxCallDepth:     maxCallDepth,
		MaxHeapCount:     500_000,
		MaxStringBytes:   4 << 20,  // 4 MiB
		MaxCollectionLen: 100_000,  // 100,000 elements
		MaxMemoryBytes:   64 << 20, // 64 MiB
		MaxSteps:         DefaultMaxSteps,
		MaxDuration:      DefaultMaxDuration,
	}
}

// NewVM creates a VM instance with default configuration.
func NewVM(mod Module, host HostCallbacks) *VM {
	return NewVMWithConfig(mod, host, DefaultVMConfig())
}

// NewVMWithConfig creates a VM instance with custom configuration.
func NewVMWithConfig(mod Module, host HostCallbacks, config VMConfig) *VM {
	if config.MaxStackDepth <= 0 {
		config.MaxStackDepth = maxStackDepth
	}
	if config.MaxCallDepth <= 0 {
		config.MaxCallDepth = maxCallDepth
	}
	// Budgets and memory caps: 0 = default, negative = unlimited (0 internally).
	switch {
	case config.MaxHeapCount == 0:
		config.MaxHeapCount = DefaultMaxHeapCount
	case config.MaxHeapCount < 0:
		config.MaxHeapCount = 0
	}
	switch {
	case config.MaxStringBytes == 0:
		config.MaxStringBytes = DefaultMaxStringBytes
	case config.MaxStringBytes < 0:
		config.MaxStringBytes = 0
	}
	switch {
	case config.MaxCollectionLen == 0:
		config.MaxCollectionLen = DefaultMaxCollectionLen
	case config.MaxCollectionLen < 0:
		config.MaxCollectionLen = 0
	}
	switch {
	case config.MaxMemoryBytes == 0:
		config.MaxMemoryBytes = DefaultMaxMemoryBytes
	case config.MaxMemoryBytes < 0:
		config.MaxMemoryBytes = 0
	}
	switch {
	case config.MaxSteps == 0:
		config.MaxSteps = DefaultMaxSteps
	case config.MaxSteps < 0:
		config.MaxSteps = 0
	}
	switch {
	case config.MaxDuration == 0:
		config.MaxDuration = DefaultMaxDuration
	case config.MaxDuration < 0:
		config.MaxDuration = 0
	}
	v := &VM{
		module:         mod,
		ip:             0,
		stack:          make([]Value, 0, 64),
		host:           host,
		globals:        make(map[string]Value),
		frames:         make([]callFrame, 0, 8),
		eventCap:       defaultEventCap,
		events:         make([]Value, 0, defaultEventCap),
		rootLocals:     0,
		handlers:       make(map[string]handlerEntry),
		eventListeners: make(map[string][]Value),
		strCacheLen:    -1,
	}
	// Store config in VM for limit checks
	v.maxStack = config.MaxStackDepth
	v.maxCalls = config.MaxCallDepth
	v.maxHeap = config.MaxHeapCount
	v.maxStringBytes = config.MaxStringBytes
	v.maxCollectionLen = config.MaxCollectionLen
	v.maxMemory = config.MaxMemoryBytes
	v.maxSteps = config.MaxSteps
	v.maxDuration = config.MaxDuration
	// Freeze any container values embedded in module constants so concurrent runs cannot mutate them.
	for _, c := range mod.Constants {
		if c.kind == kindArray && c.arr != nil {
			c.arr.frozen = true
		} else if c.kind == kindObject && c.obj != nil {
			c.obj.frozen = true
		}
	}
	return v
}

// CurrentLine returns the source line for the current instruction position.
// Returns 0 if no line map is available.
func (vm *VM) CurrentLine() int {
	if vm.ip <= 0 || len(vm.module.LineMap) == 0 {
		return 0
	}
	// The line of the instruction being executed (its opcode), not of the last operand read
	// or of a jump target (D18).
	idx := vm.opIP
	if idx >= len(vm.module.LineMap) {
		idx = len(vm.module.LineMap) - 1
	}
	return vm.module.LineMap[idx]
}

// runtimeError creates an error with source line information if available.
func (vm *VM) runtimeError(format string, args ...any) error {
	return &RuntimeError{Line: vm.CurrentLine(), Msg: fmt.Sprintf(format, args...)}
}

const (
	estStringHeader     = 16
	estCollectionHeader = 48
	estElementSlot      = 32
	estObjectEntry      = 48
)

func (vm *VM) memError(msg string) error {
	return &MemoryLimitError{Line: vm.CurrentLine(), Msg: msg}
}

func (vm *VM) checkStringSize(byteLen int) error {
	if vm.maxStringBytes > 0 && byteLen > vm.maxStringBytes {
		return vm.memError(fmt.Sprintf("string length %d exceeds limit of %d bytes", byteLen, vm.maxStringBytes))
	}
	return vm.accountAlloc(int64(byteLen)+estStringHeader, 0)
}

func (vm *VM) checkCollectionSize(n int) error {
	if vm.maxCollectionLen > 0 && n > vm.maxCollectionLen {
		return vm.memError(fmt.Sprintf("collection length %d exceeds limit of %d elements", n, vm.maxCollectionLen))
	}
	return nil
}

func (vm *VM) accountAlloc(deltaBytes int64, deltaObjs int) error {
	if vm.maxMemory <= 0 && vm.maxHeap <= 0 {
		return nil
	}
	vm.memBytes += deltaBytes
	vm.heapObjects += deltaObjs
	if (vm.maxMemory > 0 && vm.memBytes > vm.maxMemory) || (vm.maxHeap > 0 && vm.heapObjects > vm.maxHeap) {
		liveBytes, liveObjs := vm.recomputeLiveMemory()
		vm.memBytes = liveBytes + deltaBytes
		vm.heapObjects = liveObjs + deltaObjs
		if vm.maxHeap > 0 && vm.heapObjects > vm.maxHeap {
			return vm.memError(fmt.Sprintf("heap objects %d exceeds limit of %d", vm.heapObjects, vm.maxHeap))
		}
		if vm.maxMemory > 0 && vm.memBytes > vm.maxMemory {
			return vm.memError(fmt.Sprintf("allocated memory %d exceeds limit of %d bytes", vm.memBytes, vm.maxMemory))
		}
	}
	return nil
}

func (vm *VM) accountValue(root Value) error {
	if vm.maxStringBytes <= 0 && vm.maxCollectionLen <= 0 && vm.maxMemory <= 0 && vm.maxHeap <= 0 {
		return nil
	}
	var bytes int64
	var objs int
	seenArr := make(map[*pArray]struct{})
	seenObj := make(map[*pObject]struct{})
	seenStr := make(map[uintptr]struct{})
	queue := []Value{root}
	for len(queue) > 0 {
		v := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		switch v.kind {
		case kindString:
			if vm.maxStringBytes > 0 && len(v.str) > vm.maxStringBytes {
				return vm.memError(fmt.Sprintf("string length %d exceeds limit of %d bytes", len(v.str), vm.maxStringBytes))
			}
			if n := len(v.str); n > 0 {
				p := uintptr(unsafe.Pointer(unsafe.StringData(v.str)))
				if _, ok := seenStr[p]; !ok {
					seenStr[p] = struct{}{}
					bytes += int64(n) + estStringHeader
				}
			}
		case kindArray:
			for arr := v.arr; arr != nil; arr = arr.parent {
				if _, ok := seenArr[arr]; ok {
					break
				}
				seenArr[arr] = struct{}{}
				objs++
				if arr.kind == pArrRoot {
					if vm.maxCollectionLen > 0 && len(arr.elems) > vm.maxCollectionLen {
						return vm.memError(fmt.Sprintf("collection length %d exceeds limit of %d elements", len(arr.elems), vm.maxCollectionLen))
					}
					bytes += estCollectionHeader + int64(len(arr.elems))*estElementSlot
					queue = append(queue, arr.elems...)
					break
				}
				bytes += estCollectionHeader
				if arr.kind == pArrSet || arr.kind == pArrPush {
					queue = append(queue, arr.val)
				}
			}
		case kindObject:
			for obj := v.obj; obj != nil; obj = obj.parent {
				if _, ok := seenObj[obj]; ok {
					break
				}
				seenObj[obj] = struct{}{}
				objs++
				if obj.kind == pObjRoot {
					if vm.maxCollectionLen > 0 && len(obj.props) > vm.maxCollectionLen {
						return vm.memError(fmt.Sprintf("collection length %d exceeds limit of %d elements", len(obj.props), vm.maxCollectionLen))
					}
					bytes += estCollectionHeader + int64(len(obj.props))*estObjectEntry
					for k, val := range obj.props {
						if n := len(k); n > 0 {
							kp := uintptr(unsafe.Pointer(unsafe.StringData(k)))
							if _, ok := seenStr[kp]; !ok {
								seenStr[kp] = struct{}{}
								bytes += int64(n) + estStringHeader
							}
						}
						queue = append(queue, val)
					}
					break
				}
				bytes += estCollectionHeader
				if n := len(obj.key); n > 0 {
					kp := uintptr(unsafe.Pointer(unsafe.StringData(obj.key)))
					if _, ok := seenStr[kp]; !ok {
						seenStr[kp] = struct{}{}
						bytes += int64(n) + estStringHeader
					}
				}
				if obj.hadOld {
					queue = append(queue, obj.oldVal)
				}
			}
		}
	}
	return vm.accountAlloc(bytes, objs)
}

func (vm *VM) recomputeLiveMemory() (int64, int) {
	var bytes int64
	var objs int
	seenArr := make(map[*pArray]struct{})
	seenObj := make(map[*pObject]struct{})
	seenCl := make(map[*closure]struct{})
	seenUv := make(map[*upvalue]struct{})
	seenStr := make(map[uintptr]struct{})
	queue := make([]Value, 0, len(vm.stack)+len(vm.globals)+len(vm.events))
	queue = append(queue, vm.stack...)
	for _, v := range vm.globals {
		queue = append(queue, v)
	}
	queue = append(queue, vm.events...)
	for _, h := range vm.handlers {
		if h.fn.kind == kindFunction {
			queue = append(queue, h.fn)
		}
	}
	for len(queue) > 0 {
		v := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		switch v.kind {
		case kindString:
			if n := len(v.str); n > 0 {
				p := uintptr(unsafe.Pointer(unsafe.StringData(v.str)))
				if _, ok := seenStr[p]; !ok {
					seenStr[p] = struct{}{}
					bytes += int64(n) + estStringHeader
				}
			}
		case kindFunction:
			if v.cl != nil {
				if _, ok := seenCl[v.cl]; !ok {
					seenCl[v.cl] = struct{}{}
					objs++
					bytes += estCollectionHeader + int64(len(v.cl.upvalues))*16
					for _, uv := range v.cl.upvalues {
						if uv == nil {
							continue
						}
						if _, ok := seenUv[uv]; !ok {
							seenUv[uv] = struct{}{}
							objs++
							bytes += 32
							if uv.location < 0 {
								queue = append(queue, uv.closed)
							}
						}
					}
				}
			}
		case kindArray:
			for arr := v.arr; arr != nil; arr = arr.parent {
				if _, ok := seenArr[arr]; ok {
					break
				}
				seenArr[arr] = struct{}{}
				objs++
				if arr.kind == pArrRoot {
					bytes += estCollectionHeader + int64(len(arr.elems))*estElementSlot
					queue = append(queue, arr.elems...)
					break
				}
				bytes += estCollectionHeader
				if arr.kind == pArrSet || arr.kind == pArrPush {
					queue = append(queue, arr.val)
				}
			}
		case kindObject:
			for obj := v.obj; obj != nil; obj = obj.parent {
				if _, ok := seenObj[obj]; ok {
					break
				}
				seenObj[obj] = struct{}{}
				objs++
				if obj.kind == pObjRoot {
					bytes += estCollectionHeader + int64(len(obj.props))*estObjectEntry
					for k, val := range obj.props {
						if n := len(k); n > 0 {
							kp := uintptr(unsafe.Pointer(unsafe.StringData(k)))
							if _, ok := seenStr[kp]; !ok {
								seenStr[kp] = struct{}{}
								bytes += int64(n) + estStringHeader
							}
						}
						queue = append(queue, val)
					}
					break
				}
				bytes += estCollectionHeader
				if n := len(obj.key); n > 0 {
					kp := uintptr(unsafe.Pointer(unsafe.StringData(obj.key)))
					if _, ok := seenStr[kp]; !ok {
						seenStr[kp] = struct{}{}
						bytes += int64(n) + estStringHeader
					}
				}
				if obj.hadOld {
					queue = append(queue, obj.oldVal)
				}
			}
		}
	}
	return bytes, objs
}

// IP returns the current instruction pointer.
func (vm *VM) IP() int { return vm.ip }

// StackDepth returns the current stack depth.
func (vm *VM) StackDepth() int { return len(vm.stack) }

// Halted returns true if the VM has halted.
func (vm *VM) Halted() bool { return vm.halted }

// ListHandlers returns all registered handler functions.
func (vm *VM) ListHandlers() []FunctionInfo {
	result := make([]FunctionInfo, 0, len(vm.handlers))
	for _, h := range vm.handlers {
		result = append(result, h.info)
	}
	return result
}

func (vm *VM) push(v Value) error {
	limit := vm.maxStack
	if limit <= 0 {
		limit = maxStackDepth
	}
	if len(vm.stack) >= limit {
		return errors.New("stack overflow")
	}
	vm.stack = append(vm.stack, v)
	return nil
}

func (vm *VM) ensureStackSize(size int) error {
	limit := vm.maxStack
	if limit <= 0 {
		limit = maxStackDepth
	}
	if size > limit {
		return errors.New("stack overflow")
	}
	for len(vm.stack) < size {
		vm.stack = append(vm.stack, Nil())
	}
	return nil
}

func (vm *VM) pop() (Value, error) {
	if len(vm.stack) == 0 {
		return Value{}, errors.New("stack underflow")
	}
	v := vm.stack[len(vm.stack)-1]
	vm.stack = vm.stack[:len(vm.stack)-1]
	return v, nil
}

// EnqueueEvent allows hosts to inject events into the VM's queue.
func (vm *VM) EnqueueEvent(v Value) bool {
	if len(vm.events) >= vm.eventCap {
		return false
	}
	vm.events = append(vm.events, v)
	return true
}

// Resume clears yielded state if any sleep has elapsed.
func (vm *VM) Resume() {
	if !vm.yielded {
		return
	}
	if vm.sleepUntil.IsZero() || !time.Now().Before(vm.sleepUntil) {
		vm.yielded = false
		vm.sleepUntil = time.Time{}
	}
}

// SleepRemaining returns the remaining duration of an active sleep, or 0.
func (vm *VM) SleepRemaining() time.Duration {
	if !vm.yielded || vm.sleepUntil.IsZero() {
		return 0
	}
	rem := time.Until(vm.sleepUntil)
	if rem < 0 {
		return 0
	}
	return rem
}

// DrainEvents returns and clears any events buffered in the VM's internal queue.
func (vm *VM) DrainEvents() []Value {
	if len(vm.events) == 0 {
		return nil
	}
	out := make([]Value, len(vm.events))
	copy(out, vm.events)
	vm.events = vm.events[:0]
	return out
}

// EventListenerNames returns sorted event names that have at least one listener registered via on().
func (vm *VM) EventListenerNames() []string {
	names := make([]string, 0, len(vm.eventListeners))
	for name, list := range vm.eventListeners {
		if len(list) > 0 {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// RunWithBudget executes until halt/yield or budget exhausted.
func (vm *VM) RunWithBudget(maxSteps int, maxDuration time.Duration) error {
	prevActive := vm.budgetActive
	prevSteps := vm.activeSteps
	prevMaxSteps := vm.activeMaxStp
	prevStart := vm.activeStart
	prevMaxDur := vm.activeMaxDur
	vm.budgetActive = true
	vm.activeSteps = 0
	vm.activeMaxStp = maxSteps
	vm.activeStart = time.Now()
	vm.activeMaxDur = maxDuration
	defer func() {
		vm.budgetActive = prevActive
		vm.activeSteps = prevSteps
		vm.activeMaxStp = prevMaxSteps
		vm.activeStart = prevStart
		vm.activeMaxDur = prevMaxDur
	}()

	for !vm.halted {
		if vm.yielded {
			if vm.sleepUntil.IsZero() || !time.Now().Before(vm.sleepUntil) {
				vm.yielded = false
				vm.sleepUntil = time.Time{}
			} else {
				return ErrYielded
			}
		}
		if vm.activeMaxStp > 0 && vm.activeSteps >= vm.activeMaxStp {
			return ErrStepBudgetExceeded
		}
		if vm.activeMaxDur > 0 && vm.activeSteps&255 == 0 && time.Since(vm.activeStart) >= vm.activeMaxDur {
			return ErrTimeBudgetExceeded
		}
		if err := vm.Step(); err != nil {
			if isUncatchable(err) {
				return err
			}
			// Check if this error can be caught by an exception handler
			if vm.handleException(err) {
				vm.activeSteps++
				continue // Exception handled, continue execution
			}
			return err
		}
		vm.activeSteps++
	}
	return nil
}

// callValueSync invokes a PulsarScript function/closure synchronously from inside a builtin
// (e.g. arrayMap, arrayFilter, arrayReduce, arrayFind, arraySort), sharing the active step/time budget.
func (vm *VM) callValueSync(fn Value, args []Value) (Value, error) {
	if fn.kind != kindFunction {
		return Value{}, vm.runtimeError("can only call functions, got %s", typeName(fn))
	}
	targetDepth := len(vm.frames)
	savedIP := vm.ip
	savedHalted := vm.halted
	savedStackLen := len(vm.stack)

	for _, arg := range args {
		if err := vm.push(arg); err != nil {
			vm.stack = vm.stack[:savedStackLen]
			return Value{}, err
		}
	}
	if err := vm.callFunctionValue(fn, len(args)); err != nil {
		vm.stack = vm.stack[:savedStackLen]
		return Value{}, err
	}

	for len(vm.frames) > targetDepth && !vm.halted {
		if vm.budgetActive {
			if vm.activeMaxStp > 0 && vm.activeSteps >= vm.activeMaxStp {
				return Value{}, ErrStepBudgetExceeded
			}
			if vm.activeMaxDur > 0 && vm.activeSteps&255 == 0 && time.Since(vm.activeStart) >= vm.activeMaxDur {
				return Value{}, ErrTimeBudgetExceeded
			}
		}
		if err := vm.Step(); err != nil {
			if errors.Is(err, ErrYielded) {
				vm.yielded = false
				vm.sleepUntil = time.Time{}
				return Value{}, vm.runtimeError("cannot yield or sleep inside callback")
			}
			if errors.Is(err, ErrSuspended) {
				vm.suspended = false
				vm.pendingCall = nil
				return Value{}, vm.runtimeError("cannot suspend inside callback")
			}
			if isUncatchable(err) {
				return Value{}, err
			}
			// Handle exceptions caught inside the callback; let exceptions from outer try/catch
			// propagate out so RunWithBudget preserves full frames for e.stack before unwinding.
			if len(vm.excHandlers) > 0 && vm.excHandlers[len(vm.excHandlers)-1].frameDepth > targetDepth {
				if vm.handleException(err) {
					if vm.budgetActive {
						vm.activeSteps++
					}
					continue
				}
			}
			return Value{}, err
		}
		if vm.budgetActive {
			vm.activeSteps++
		}
	}

	var ret Value
	if vm.halted && !savedHalted {
		ret = Nil()
	} else {
		var err error
		ret, err = vm.pop()
		if err != nil {
			return Value{}, err
		}
	}
	vm.ip = savedIP
	vm.halted = savedHalted
	return ret, nil
}

// Suspended reports whether the VM is paused waiting for an async host call result.
func (vm *VM) Suspended() bool {
	return vm.suspended
}

// PendingHostCall returns a copy of the pending host call if suspended, or nil.
func (vm *VM) PendingHostCall() *PendingHostCall {
	if !vm.suspended || vm.pendingCall == nil {
		return nil
	}
	argsCopy := make([]Value, len(vm.pendingCall.Args))
	copy(argsCopy, vm.pendingCall.Args)
	return &PendingHostCall{Name: vm.pendingCall.Name, Args: argsCopy}
}

// ResumeAsync supplies the result or error for a suspended async host call (LANG-11).
// It re-validates host state via ValidateResume and checks memory limits on result.
func (vm *VM) ResumeAsync(result Value, callErr error) error {
	if !vm.suspended {
		return errors.New("vm is not suspended")
	}
	if vm.host.ValidateResume != nil {
		if err := vm.host.ValidateResume(); err != nil {
			return err
		}
	}
	if callErr == nil {
		if err := vm.accountValue(result); err != nil {
			return err
		}
	}
	vm.suspended = false
	vm.pendingCall = nil
	vm.resumePending = true
	vm.resumeResult = result
	vm.resumeErr = callErr
	return nil
}

// ContinueWithBudget resumes execution after ResumeAsync, carrying over prior steps and elapsed wall time.
func (vm *VM) ContinueWithBudget(maxSteps int, maxDuration time.Duration) error {
	if vm.suspended {
		return ErrSuspended
	}
	remSteps := maxSteps
	if maxSteps > 0 {
		remSteps = maxSteps - vm.suspendedSteps
		if remSteps <= 0 {
			vm.suspendedSteps = 0
			vm.suspendedElapsed = 0
			return ErrStepBudgetExceeded
		}
	}
	remDur := maxDuration
	if maxDuration > 0 {
		remDur = maxDuration - vm.suspendedElapsed
		if remDur <= 0 {
			vm.suspendedSteps = 0
			vm.suspendedElapsed = 0
			return ErrTimeBudgetExceeded
		}
	}
	if vm.resumePending {
		vm.resumePending = false
		res := vm.resumeResult
		callErr := vm.resumeErr
		vm.resumeResult = Value{}
		vm.resumeErr = nil
		if callErr != nil {
			if isUncatchable(callErr) {
				vm.suspendedSteps = 0
				vm.suspendedElapsed = 0
				return callErr
			}
			if !vm.handleException(callErr) {
				vm.suspendedSteps = 0
				vm.suspendedElapsed = 0
				return callErr
			}
			vm.suspendedSteps++
			if maxSteps > 0 {
				remSteps--
				if remSteps <= 0 {
					vm.suspendedSteps = 0
					vm.suspendedElapsed = 0
					return ErrStepBudgetExceeded
				}
			}
		} else {
			if err := vm.push(res); err != nil {
				vm.suspendedSteps = 0
				vm.suspendedElapsed = 0
				return err
			}
		}
	}
	err := vm.RunWithBudget(remSteps, remDur)
	if !errors.Is(err, ErrSuspended) {
		vm.suspendedSteps = 0
		vm.suspendedElapsed = 0
	}
	return err
}

// Tick executes up to the provided budgets and reports state. Budgets are best-effort;
// host code should handle ErrStepBudgetExceeded/ErrTimeBudgetExceeded to throttle execution.
func (vm *VM) Tick(maxSteps int, maxDuration time.Duration) TickResult {
	if vm.halted {
		return TickResult{Halted: true}
	}
	if vm.suspended {
		return TickResult{Suspended: true, PendingCall: vm.PendingHostCall()}
	}
	vm.Resume()
	var err error
	if vm.resumePending {
		err = vm.ContinueWithBudget(maxSteps, maxDuration)
	} else {
		err = vm.RunWithBudget(maxSteps, maxDuration)
	}
	if err == nil {
		return TickResult{Halted: vm.halted}
	}
	if errors.Is(err, ErrSuspended) {
		return TickResult{Suspended: true, PendingCall: vm.PendingHostCall()}
	}
	if errors.Is(err, ErrYielded) {
		res := TickResult{Yielded: true}
		if !vm.sleepUntil.IsZero() && time.Now().Before(vm.sleepUntil) {
			res.Sleeping = true
			res.SleepFor = time.Until(vm.sleepUntil)
		}
		return res
	}
	return TickResult{Err: err}
}

// TickLoop drives the VM until halt or a hard error. Step/time budget overruns
// return control to the caller so it can schedule another tick. Yield/Sleep
// are handled by sleeping via sleepFn (default time.Sleep) when applicable.
func (vm *VM) TickLoop(stepBudget int, timeBudget time.Duration, sleepFn func(time.Duration)) error {
	if sleepFn == nil {
		sleepFn = time.Sleep
	}
	for !vm.halted {
		res := vm.Tick(stepBudget, timeBudget)
		switch {
		case res.Err != nil:
			if errors.Is(res.Err, ErrStepBudgetExceeded) || errors.Is(res.Err, ErrTimeBudgetExceeded) {
				return res.Err
			}
			return res.Err
		case res.Halted:
			return nil
		case res.Sleeping && res.SleepFor > 0:
			sleepFn(res.SleepFor)
			vm.Resume()
		case res.Yielded:
			// yielded without sleep; return to host for scheduling
			return nil
		default:
			// continue loop
		}
	}
	return nil
}

// CurrentFile returns the source filename for the current instruction (or "" if single-file).
func (vm *VM) CurrentFile() string {
	if len(vm.module.Sources) <= 1 || vm.opIP < 0 || vm.opIP >= len(vm.module.FileMap) {
		return ""
	}
	idx := vm.module.FileMap[vm.opIP]
	if idx < 0 || idx >= len(vm.module.Sources) {
		return ""
	}
	return vm.module.Sources[idx]
}

func formatStackLocation(file string, line int) string {
	if file != "" && line > 0 {
		return fmt.Sprintf("%s:%d", file, line)
	}
	if line > 0 {
		return fmt.Sprintf("line %d", line)
	}
	return ""
}

func displayFuncName(name string) string {
	if name == "" {
		return "<anonymous>"
	}
	if strings.HasPrefix(name, "__m") {
		if idx := strings.IndexByte(name, '$'); idx > 3 {
			allDigits := true
			for i := 3; i < idx; i++ {
				if name[i] < '0' || name[i] > '9' {
					allDigits = false
					break
				}
			}
			if allDigits && idx+1 < len(name) {
				return name[idx+1:]
			}
		}
	}
	return name
}

func (vm *VM) formatCallStack(errLine int) []Value {
	loc := formatStackLocation(vm.CurrentFile(), errLine)
	frameName := "<script>"
	if len(vm.frames) > 0 {
		frameName = displayFuncName(vm.frames[len(vm.frames)-1].name)
	}
	out := make([]Value, 0, len(vm.frames)+1)
	if loc != "" {
		out = append(out, String(fmt.Sprintf("%s (%s)", frameName, loc)))
	} else {
		out = append(out, String(frameName))
	}
	for i := len(vm.frames) - 1; i >= 0; i-- {
		caller := "<script>"
		if i > 0 {
			caller = displayFuncName(vm.frames[i-1].name)
		}
		callLoc := formatStackLocation(vm.frames[i].callFile, vm.frames[i].callLine)
		if callLoc != "" {
			out = append(out, String(fmt.Sprintf("%s (%s)", caller, callLoc)))
		} else {
			out = append(out, String(caller))
		}
	}
	return out
}

func (vm *VM) captureUpvalue(stackIdx int) *upvalue {
	var prev *upvalue
	uv := vm.openUpvalues
	for uv != nil && uv.location > stackIdx {
		prev = uv
		uv = uv.next
	}
	if uv != nil && uv.location == stackIdx {
		return uv
	}
	created := &upvalue{location: stackIdx, next: uv}
	if prev == nil {
		vm.openUpvalues = created
	} else {
		prev.next = created
	}
	return created
}

func (vm *VM) closeUpvalues(lastIdx int) {
	for vm.openUpvalues != nil && vm.openUpvalues.location >= lastIdx {
		uv := vm.openUpvalues
		vm.openUpvalues = uv.next
		if uv.location >= 0 && uv.location < len(vm.stack) {
			uv.closed = vm.stack[uv.location]
		}
		uv.location = -1
		uv.next = nil
	}
}

func (vm *VM) closeSlot(slotIdx int) {
	var prev *upvalue
	uv := vm.openUpvalues
	for uv != nil && uv.location > slotIdx {
		prev = uv
		uv = uv.next
	}
	if uv != nil && uv.location == slotIdx {
		if prev == nil {
			vm.openUpvalues = uv.next
		} else {
			prev.next = uv.next
		}
		if uv.location >= 0 && uv.location < len(vm.stack) {
			uv.closed = vm.stack[uv.location]
		}
		uv.location = -1
		uv.next = nil
	}
}

// handleException attempts to dispatch an error to an active exception handler.
// Returns true if the exception was handled (execution can continue), false otherwise.
func (vm *VM) handleException(err error) bool {
	if len(vm.excHandlers) == 0 {
		return false
	}

	line := vm.CurrentLine()
	var re *RuntimeError
	if errors.As(err, &re) && re.Line > 0 {
		line = re.Line
	}
	stack := vm.formatCallStack(line)

	// Pop the most recent exception handler
	handler := vm.excHandlers[len(vm.excHandlers)-1]
	vm.excHandlers = vm.excHandlers[:len(vm.excHandlers)-1]

	// Close any open upvalues in the unwound stack region before truncating stack.
	vm.closeUpvalues(handler.stackDepth)

	// Unwind call frames entered inside the try block, then restore the entering frame's
	// locals and the stack to where they were at TRY_PUSH (D19).
	if handler.frameDepth < len(vm.frames) {
		vm.frames = vm.frames[:handler.frameDepth]
	}
	*vm.currentLocals() = handler.locals
	if handler.stackDepth < len(vm.stack) {
		vm.stack = vm.stack[:handler.stackDepth]
	}

	// The catch block receives an error object {kind, line, message, stack} (SPEC 7, D7, LANG-06).
	vm.stack = append(vm.stack, errorValueWithStack(err, line, stack))

	// Jump to the catch handler
	vm.ip = handler.catchIP

	return true
}

// Run executes the loaded module.
func (vm *VM) Run() error {
	// Bounded by the VM's default budgets (VMConfig.MaxSteps/MaxDuration, D10).
	return vm.RunWithBudget(vm.maxSteps, vm.maxDuration)
}

// Step executes a single instruction; sets halted on OpHalt.
func (vm *VM) Step() error {
	if vm.ip >= len(vm.module.Code) {
		vm.halted = true
		return nil
	}
	code := vm.module.Code
	op := byte(code[vm.ip])
	vm.opIP = vm.ip
	vm.ip++
	switch op {
	case OpConst:
		if vm.ip >= len(code) {
			return errors.New("missing operand for CONST")
		}
		idx := code[vm.ip]
		vm.ip++
		if idx < 0 || idx >= len(vm.module.Constants) {
			return fmt.Errorf("constant index out of range: %d", idx)
		}
		if err := vm.push(vm.module.Constants[idx]); err != nil {
			return err
		}
	case OpAdd, OpSub, OpMul, OpDiv:
		b, err := vm.pop()
		if err != nil {
			return err
		}
		a, err := vm.pop()
		if err != nil {
			return err
		}
		if op == OpAdd && (a.kind == kindString || b.kind == kindString) {
			// + concatenates when either operand is a string (SPEC 4.2, D6).
			var as, bs string
			if a.kind == kindString {
				as = a.str
			} else {
				as = a.String()
			}
			if b.kind == kindString {
				bs = b.str
			} else {
				bs = b.String()
			}
			if err := vm.checkStringSize(len(as) + len(bs)); err != nil {
				return err
			}
			if err := vm.push(String(as + bs)); err != nil {
				return err
			}
			return nil
		}
		if a.kind != kindNumber || b.kind != kindNumber {
			return fmt.Errorf("arithmetic on non-number")
		}
		var res float64
		switch op {
		case OpAdd:
			res = a.num + b.num
		case OpSub:
			res = a.num - b.num
		case OpMul:
			res = a.num * b.num
		case OpDiv:
			if b.num == 0 {
				return errors.New("division by zero")
			}
			res = a.num / b.num
		}
		if err := vm.push(Number(res)); err != nil {
			return err
		}
	case OpNeg:
		v, err := vm.pop()
		if err != nil {
			return err
		}
		if v.kind != kindNumber {
			return fmt.Errorf("negate on non-number")
		}
		if err := vm.push(Number(-v.num)); err != nil {
			return err
		}
	case OpEqual, OpNotEqual:
		b, err := vm.pop()
		if err != nil {
			return err
		}
		a, err := vm.pop()
		if err != nil {
			return err
		}
		eq := valuesEqual(a, b)
		if op == OpNotEqual {
			eq = !eq
		}
		if err := vm.push(Bool(eq)); err != nil {
			return err
		}
	case OpGreater, OpGreaterEqual, OpLess, OpLessEqual:
		b, err := vm.pop()
		if err != nil {
			return err
		}
		a, err := vm.pop()
		if err != nil {
			return err
		}
		var result bool
		if a.kind == kindString && b.kind == kindString {
			switch op {
			case OpGreater:
				result = a.str > b.str
			case OpGreaterEqual:
				result = a.str >= b.str
			case OpLess:
				result = a.str < b.str
			case OpLessEqual:
				result = a.str <= b.str
			}
		} else {
			if a.kind != kindNumber || b.kind != kindNumber {
				return fmt.Errorf("comparison on non-number")
			}
			switch op {
			case OpGreater:
				result = a.num > b.num
			case OpGreaterEqual:
				result = a.num >= b.num
			case OpLess:
				result = a.num < b.num
			case OpLessEqual:
				result = a.num <= b.num
			}
		}
		if err := vm.push(Bool(result)); err != nil {
			return err
		}
	case OpNot:
		v, err := vm.pop()
		if err != nil {
			return err
		}
		return vm.push(Bool(!isTruthy(v)))
	case OpAnd:
		b, err := vm.pop()
		if err != nil {
			return err
		}
		a, err := vm.pop()
		if err != nil {
			return err
		}
		if isTruthy(a) && isTruthy(b) {
			return vm.push(b)
		}
		return vm.push(Bool(false))
	case OpOr:
		b, err := vm.pop()
		if err != nil {
			return err
		}
		a, err := vm.pop()
		if err != nil {
			return err
		}
		if isTruthy(a) {
			return vm.push(a)
		}
		return vm.push(b)
	case OpPop:
		if _, err := vm.pop(); err != nil {
			return err
		}
	case OpPrint:
		v, err := vm.pop()
		if err != nil {
			return err
		}
		if vm.host.Print != nil {
			vm.host.Print(v)
		}
	case OpDefineGlobal:
		if vm.ip >= len(code) {
			return errors.New("missing operand for DEFINE_GLOBAL")
		}
		idx := code[vm.ip]
		vm.ip++
		if idx < 0 || idx >= len(vm.module.Constants) {
			return fmt.Errorf("const index out of range: %d", idx)
		}
		name := vm.module.Constants[idx].String()
		val, err := vm.pop()
		if err != nil {
			return err
		}
		vm.globals[name] = val
	case OpGetGlobal:
		if vm.ip >= len(code) {
			return errors.New("missing operand for GET_GLOBAL")
		}
		idx := code[vm.ip]
		vm.ip++
		if idx < 0 || idx >= len(vm.module.Constants) {
			return fmt.Errorf("const index out of range: %d", idx)
		}
		name := vm.module.Constants[idx].String()
		val, ok := vm.globals[name]
		if !ok {
			return fmt.Errorf("undefined global '%s'", name)
		}
		if err := vm.push(val); err != nil {
			return err
		}
	case OpSetGlobal:
		if vm.ip >= len(code) {
			return errors.New("missing operand for SET_GLOBAL")
		}
		idx := code[vm.ip]
		vm.ip++
		if idx < 0 || idx >= len(vm.module.Constants) {
			return fmt.Errorf("const index out of range: %d", idx)
		}
		name := vm.module.Constants[idx].String()
		val, err := vm.pop()
		if err != nil {
			return err
		}
		vm.globals[name] = val
	case OpGetLocal:
		if vm.ip >= len(code) {
			return errors.New("missing operand for GET_LOCAL")
		}
		slot := code[vm.ip]
		vm.ip++
		base := vm.currentBase()
		idx := base + slot
		if idx < 0 || idx >= len(vm.stack) {
			return fmt.Errorf("local index out of range: %d", slot)
		}
		if err := vm.push(vm.stack[idx]); err != nil {
			return err
		}
	case OpSetLocal:
		if vm.ip >= len(code) {
			return errors.New("missing operand for SET_LOCAL")
		}
		slot := code[vm.ip]
		vm.ip++
		val, err := vm.pop()
		if err != nil {
			return err
		}
		base := vm.currentBase()
		idx := base + slot
		if err := vm.ensureStackSize(idx + 1); err != nil {
			return err
		}
		vm.stack[idx] = val
		vm.bumpLocals(slot + 1)
		if err := vm.push(val); err != nil {
			return err
		}
	case OpEnterBlock:
		if vm.ip >= len(code) {
			return errors.New("missing operand for ENTER_BLOCK")
		}
		count := code[vm.ip]
		vm.ip++
		if count < 0 {
			return fmt.Errorf("negative local count for ENTER_BLOCK: %d", count)
		}
		locals := vm.currentLocals()
		*locals += count
		if *locals < 0 {
			return errors.New("locals underflow")
		}
		base := vm.currentBase()
		if err := vm.ensureStackSize(base + *locals); err != nil {
			return err
		}
	case OpExitBlock:
		if vm.ip >= len(code) {
			return errors.New("missing operand for EXIT_BLOCK")
		}
		count := code[vm.ip]
		vm.ip++
		if count < 0 {
			return fmt.Errorf("negative local count for EXIT_BLOCK: %d", count)
		}
		locals := vm.currentLocals()
		if *locals < count {
			return fmt.Errorf("EXIT_BLOCK underflow: have %d locals, dropping %d", *locals, count)
		}
		*locals -= count
		base := vm.currentBase()
		keep := base + *locals
		if keep < 0 || keep > len(vm.stack) {
			return fmt.Errorf("invalid stack trim to %d", keep)
		}
		vm.closeUpvalues(keep)
		vm.stack = vm.stack[:keep]
	case OpJump:
		if vm.ip >= len(code) {
			return errors.New("missing operand for JUMP")
		}
		offset := code[vm.ip]
		vm.ip++
		vm.ip += offset
		if vm.ip < 0 || vm.ip > len(code) {
			return fmt.Errorf("jump out of bounds: %d", vm.ip)
		}
	case OpJumpIfFalse:
		if vm.ip >= len(code) {
			return errors.New("missing operand for JUMP_IF_FALSE")
		}
		offset := code[vm.ip]
		vm.ip++
		cond, err := vm.pop()
		if err != nil {
			return err
		}
		if !isTruthy(cond) {
			vm.ip += offset
			if vm.ip < 0 || vm.ip > len(code) {
				return fmt.Errorf("jump out of bounds: %d", vm.ip)
			}
		}
	case OpCall:
		if vm.ip >= len(code) {
			return errors.New("missing operand for CALL address")
		}
		target := code[vm.ip]
		vm.ip++
		if vm.ip >= len(code) {
			return errors.New("missing operand for CALL arg count")
		}
		argCount := code[vm.ip]
		vm.ip++
		return vm.callFunction(target, argCount)
	case OpCallValue:
		if vm.ip >= len(code) {
			return errors.New("missing operand for CALL_VALUE")
		}
		argCount := code[vm.ip]
		vm.ip++
		at := len(vm.stack) - argCount - 1
		if argCount < 0 || at < vm.currentBase()+*vm.currentLocals() {
			return fmt.Errorf("CALL_VALUE: stack has no callee for %d args", argCount)
		}
		callee := vm.stack[at]
		if callee.kind != kindFunction {
			return fmt.Errorf("can only call functions, got %s", typeName(callee))
		}
		// Drop the callee from under the arguments, then call as CALL does.
		copy(vm.stack[at:], vm.stack[at+1:])
		vm.stack = vm.stack[:len(vm.stack)-1]
		return vm.callFunctionValue(callee, argCount)
	case OpFunc:
		if vm.ip >= len(code) {
			return errors.New("missing operand for FUNC")
		}
		target := code[vm.ip]
		vm.ip++
		info, ok := vm.module.Functions[target]
		if !ok {
			return fmt.Errorf("FUNC: no function at %d", target)
		}
		return vm.push(Function(target, info.Name))
	case OpClosure:
		if vm.ip >= len(code) {
			return errors.New("missing operand for CLOSURE")
		}
		target := code[vm.ip]
		vm.ip++
		info, ok := vm.module.Functions[target]
		if !ok {
			return fmt.Errorf("CLOSURE: no function at %d", target)
		}
		uvs := make([]*upvalue, len(info.Upvalues))
		var parentCl *closure
		if len(vm.frames) > 0 {
			parentCl = vm.frames[len(vm.frames)-1].cl
		}
		base := vm.currentBase()
		for i, desc := range info.Upvalues {
			if desc.IsLocal {
				uvs[i] = vm.captureUpvalue(base + desc.Index)
			} else {
				if parentCl == nil || desc.Index < 0 || desc.Index >= len(parentCl.upvalues) {
					return fmt.Errorf("CLOSURE: upvalue %d out of range", desc.Index)
				}
				uvs[i] = parentCl.upvalues[desc.Index]
			}
		}
		if err := vm.accountAlloc(estCollectionHeader+int64(len(uvs))*16, 1+len(uvs)); err != nil {
			return err
		}
		cl := &closure{fn: info, upvalues: uvs}
		return vm.push(Value{kind: kindFunction, num: float64(target), str: info.Name, cl: cl})
	case OpGetUpvalue:
		if vm.ip >= len(code) {
			return errors.New("missing operand for GET_UPVALUE")
		}
		slot := code[vm.ip]
		vm.ip++
		if len(vm.frames) == 0 || vm.frames[len(vm.frames)-1].cl == nil {
			return errors.New("GET_UPVALUE outside closure")
		}
		cl := vm.frames[len(vm.frames)-1].cl
		if slot < 0 || slot >= len(cl.upvalues) {
			return fmt.Errorf("GET_UPVALUE: slot %d out of range", slot)
		}
		uv := cl.upvalues[slot]
		if uv.location >= 0 {
			return vm.push(vm.stack[uv.location])
		}
		return vm.push(uv.closed)
	case OpSetUpvalue:
		if vm.ip >= len(code) {
			return errors.New("missing operand for SET_UPVALUE")
		}
		slot := code[vm.ip]
		vm.ip++
		if len(vm.frames) == 0 || vm.frames[len(vm.frames)-1].cl == nil {
			return errors.New("SET_UPVALUE outside closure")
		}
		cl := vm.frames[len(vm.frames)-1].cl
		if slot < 0 || slot >= len(cl.upvalues) {
			return fmt.Errorf("SET_UPVALUE: slot %d out of range", slot)
		}
		val, err := vm.pop()
		if err != nil {
			return err
		}
		uv := cl.upvalues[slot]
		if uv.location >= 0 {
			vm.stack[uv.location] = val
		} else {
			uv.closed = val
		}
		return vm.push(val)
	case OpCloseUpvalue:
		if vm.ip >= len(code) {
			return errors.New("missing operand for CLOSE_UPVALUE")
		}
		slot := code[vm.ip]
		vm.ip++
		vm.closeSlot(vm.currentBase() + slot)
	case OpMod:
		b, err := vm.pop()
		if err != nil {
			return err
		}
		a, err := vm.pop()
		if err != nil {
			return err
		}
		if a.kind != kindNumber || b.kind != kindNumber {
			return fmt.Errorf("operands of %% must be numbers, got %s and %s", typeName(a), typeName(b))
		}
		if b.num == 0 {
			return errors.New("modulo by zero")
		}
		// Remainder with the sign of the dividend, as in C, Go and JavaScript.
		return vm.push(Number(math.Mod(a.num, b.num)))
	case OpIterItems:
		x, err := vm.pop()
		if err != nil {
			return err
		}
		switch x.kind {
		case kindArray:
			return vm.push(x)
		case kindObject:
			n := x.objectLen()
			if err := vm.checkCollectionSize(n); err != nil {
				return err
			}
			if err := vm.accountAlloc(estCollectionHeader+int64(n)*estElementSlot, 1); err != nil {
				return err
			}
			keys := x.objectKeys()
			items := make([]Value, len(keys))
			for i, k := range keys {
				items[i] = String(k)
			}
			return vm.push(Array(items))
		case kindString:
			runeCount := utf8.RuneCountInString(x.str)
			if err := vm.checkCollectionSize(runeCount); err != nil {
				return err
			}
			if err := vm.accountAlloc(estCollectionHeader+int64(runeCount)*(estElementSlot+estStringHeader+4), 1); err != nil {
				return err
			}
			items := make([]Value, 0, runeCount)
			for _, r := range x.str {
				items = append(items, String(string(r)))
			}
			return vm.push(Array(items))
		default:
			return fmt.Errorf("for...of needs an array, object or string, got %s", typeName(x))
		}
	case OpIndexGet:
		if vm.ip >= len(code) {
			return errors.New("missing operand for INDEX_GET")
		}
		member := code[vm.ip] == 1
		vm.ip++
		key, err := vm.pop()
		if err != nil {
			return err
		}
		container, err := vm.pop()
		if err != nil {
			return err
		}
		v, err := vm.readElement(container, key, member)
		if err != nil {
			return err
		}
		return vm.push(v)
	case OpIndexSet:
		if vm.ip >= len(code) {
			return errors.New("missing operand for INDEX_SET")
		}
		member := code[vm.ip] == 1
		vm.ip++
		val, err := vm.pop()
		if err != nil {
			return err
		}
		key, err := vm.pop()
		if err != nil {
			return err
		}
		container, err := vm.pop()
		if err != nil {
			return err
		}
		next, err := vm.withElementCoW(container, key, val, member)
		if err != nil {
			return err
		}
		return vm.push(next)
	case OpReturn:
		ret, err := vm.pop()
		if err != nil {
			return err
		}
		if len(vm.frames) == 0 {
			vm.closeUpvalues(0)
			vm.halted = true
			vm.stack = vm.stack[:0]
			return vm.push(ret)
		}
		// Drop handlers registered inside the returning frame: `return` inside `try`
		// must not leave a stale handler behind (D19).
		depth := len(vm.frames)
		for len(vm.excHandlers) > 0 && vm.excHandlers[len(vm.excHandlers)-1].frameDepth >= depth {
			vm.excHandlers = vm.excHandlers[:len(vm.excHandlers)-1]
		}
		frame := vm.frames[len(vm.frames)-1]
		vm.frames = vm.frames[:len(vm.frames)-1]
		vm.ip = frame.returnIP
		if frame.base < 0 || frame.base > len(vm.stack) {
			return fmt.Errorf("invalid frame base %d", frame.base)
		}
		vm.closeUpvalues(frame.base)
		vm.stack = vm.stack[:frame.base]
		return vm.push(ret)
	case OpHostCall:
		if vm.ip+1 >= len(code) {
			return errors.New("missing operands for HOST_CALL")
		}
		nameIdx := code[vm.ip]
		vm.ip++
		argCount := code[vm.ip]
		vm.ip++
		if argCount < 0 {
			return fmt.Errorf("negative arg count for HOST_CALL: %d", argCount)
		}
		if nameIdx < 0 || nameIdx >= len(vm.module.Constants) {
			return fmt.Errorf("const index out of range: %d", nameIdx)
		}
		name := vm.module.Constants[nameIdx].String()
		if argCount > len(vm.stack) {
			return fmt.Errorf("host call %s requires %d args but stack has %d", name, argCount, len(vm.stack))
		}
		var stackArgs [8]Value
		var args []Value
		if argCount <= len(stackArgs) {
			args = stackArgs[:argCount]
		} else {
			args = make([]Value, argCount)
		}
		for i := argCount - 1; i >= 0; i-- {
			v, err := vm.pop()
			if err != nil {
				return err
			}
			args[i] = v
		}
		// Every call is checked against hostapi.json; "core" entries run inside the VM so all
		// hosts behave the same, "host" entries go to the embedding host (SPEC §8).
		fn, ok := hostAPI[name]
		if !ok {
			return vm.runtimeError("unknown host call %q", name)
		}
		if err := fn.checkCall(args); err != nil {
			return vm.runtimeError("%s", err.Error())
		}
		if fn.Provider == ProviderCore {
			res, err := coreBuiltins[name](vm, args)
			if err != nil {
				return err
			}
			return vm.push(res)
		}
		if vm.host.HostCall == nil {
			return vm.runtimeError("host call not available: %s", name)
		}
		res, err := vm.host.HostCall(name, args)
		if err != nil {
			if errors.Is(err, ErrSuspended) {
				cloned := make([]Value, len(args))
				copy(cloned, args)
				vm.suspended = true
				vm.pendingCall = &PendingHostCall{Name: name, Args: cloned}
				if vm.budgetActive {
					vm.suspendedSteps += vm.activeSteps + 1
					if !vm.activeStart.IsZero() {
						vm.suspendedElapsed += time.Since(vm.activeStart)
					}
				}
				return ErrSuspended
			}
			return err
		}
		if err := vm.accountValue(res); err != nil {
			return err
		}
		if err := vm.push(res); err != nil {
			return err
		}
	case OpEmitEvent:
		val, err := vm.pop()
		if err != nil {
			return err
		}
		if vm.host.EmitEvent != nil {
			res, err := vm.host.EmitEvent(val)
			if err != nil {
				return err
			}
			return vm.push(res)
		}
		if len(vm.events) >= vm.eventCap {
			return errors.New("event queue full")
		}
		vm.events = append(vm.events, val)
		return vm.push(Nil())
	case OpPollEvent:
		if len(vm.events) == 0 {
			return vm.push(Nil())
		}
		val := vm.events[0]
		vm.events = vm.events[1:]
		return vm.push(val)
	case OpYield:
		vm.yielded = true
		return ErrYielded
	case OpSleep:
		val, err := vm.pop()
		if err != nil {
			return err
		}
		if val.kind != kindNumber || math.IsNaN(val.num) || math.IsInf(val.num, 0) || val.num < 0 {
			return vm.runtimeError("sleep: argument 1 (ms) must be a finite non-negative number")
		}
		dur := time.Duration(val.num * float64(time.Millisecond))
		vm.sleepUntil = time.Now().Add(dur)
		vm.yielded = true
		return ErrYielded
	case OpHalt:
		vm.halted = true
		return nil
	case OpTryPush:
		if vm.ip >= len(code) {
			return errors.New("missing operand for TRY_PUSH")
		}
		offset := code[vm.ip]
		vm.ip++
		catchIP := vm.ip + offset
		if catchIP < 0 || catchIP > len(code) {
			return fmt.Errorf("try catch handler out of bounds: %d", catchIP)
		}
		vm.excHandlers = append(vm.excHandlers, excHandler{
			catchIP:    catchIP,
			stackDepth: len(vm.stack),
			frameDepth: len(vm.frames),
			locals:     *vm.currentLocals(),
		})
	case OpTryPop:
		if len(vm.excHandlers) == 0 {
			return errors.New("TRY_POP with no active exception handler")
		}
		vm.excHandlers = vm.excHandlers[:len(vm.excHandlers)-1]
	case OpNewArray:
		if vm.ip >= len(code) {
			return errors.New("missing operand for NEW_ARRAY")
		}
		count := code[vm.ip]
		vm.ip++
		if count < 0 || count > len(vm.stack) {
			return fmt.Errorf("NEW_ARRAY: invalid element count %d", count)
		}
		if err := vm.checkCollectionSize(count); err != nil {
			return err
		}
		if err := vm.accountAlloc(estCollectionHeader+int64(count)*estElementSlot, 1); err != nil {
			return err
		}
		elements := make([]Value, count)
		// Pop elements in reverse order (first element pushed is at bottom of stack portion)
		for i := count - 1; i >= 0; i-- {
			val, err := vm.pop()
			if err != nil {
				return err
			}
			elements[i] = val
		}
		if err := vm.push(Array(elements)); err != nil {
			return err
		}
	case OpArrayGet:
		idx, err := vm.pop()
		if err != nil {
			return err
		}
		arr, err := vm.pop()
		if err != nil {
			return err
		}
		if arr.kind != kindArray {
			return fmt.Errorf("ARRAY_GET: expected array, got %v", arr.kind)
		}
		if idx.kind != kindNumber {
			return fmt.Errorf("ARRAY_GET: index must be number, got %v", idx.kind)
		}
		i := int(idx.num)
		n := arr.arrayLen()
		if i < 0 || i >= n {
			return fmt.Errorf("ARRAY_GET: index %d out of bounds (length %d)", i, n)
		}
		if err := vm.push(arr.arrayAt(i)); err != nil {
			return err
		}
	case OpArraySet:
		val, err := vm.pop()
		if err != nil {
			return err
		}
		idx, err := vm.pop()
		if err != nil {
			return err
		}
		arr, err := vm.pop()
		if err != nil {
			return err
		}
		if arr.kind != kindArray {
			return fmt.Errorf("ARRAY_SET: expected array, got %v", arr.kind)
		}
		if idx.kind != kindNumber {
			return fmt.Errorf("ARRAY_SET: index must be number, got %v", idx.kind)
		}
		i := int(idx.num)
		n := arr.arrayLen()
		if i < 0 || i >= n {
			return fmt.Errorf("ARRAY_SET: index %d out of bounds (length %d)", i, n)
		}
		nextArr, copied := arr.arr.set(i, val)
		deltaBytes := int64(estCollectionHeader)
		if copied {
			deltaBytes = estCollectionHeader + int64(n)*estElementSlot
		}
		if err := vm.accountAlloc(deltaBytes, 1); err != nil {
			return err
		}
		if err := vm.push(Value{kind: kindArray, arr: nextArr}); err != nil {
			return err
		}
	case OpNewObject:
		if vm.ip >= len(code) {
			return errors.New("missing operand for NEW_OBJECT")
		}
		count := code[vm.ip]
		vm.ip++
		if count < 0 || count*2 > len(vm.stack) {
			return fmt.Errorf("NEW_OBJECT: invalid property count %d", count)
		}
		if err := vm.checkCollectionSize(count); err != nil {
			return err
		}
		if err := vm.accountAlloc(estCollectionHeader+int64(count)*estObjectEntry, 1); err != nil {
			return err
		}
		props := make(map[string]Value, count)
		// Pop key-value pairs in reverse order (key first, then value)
		for i := count - 1; i >= 0; i-- {
			val, err := vm.pop()
			if err != nil {
				return err
			}
			key, err := vm.pop()
			if err != nil {
				return err
			}
			props[key.String()] = val
		}
		if err := vm.push(Object(props)); err != nil {
			return err
		}
	case OpObjGet:
		key, err := vm.pop()
		if err != nil {
			return err
		}
		obj, err := vm.pop()
		if err != nil {
			return err
		}
		if obj.kind != kindObject {
			return fmt.Errorf("OBJ_GET: expected object, got %v", obj.kind)
		}
		keyStr := key.String()
		val, ok := obj.objectGet(keyStr)
		if !ok {
			return vm.push(Nil())
		}
		if err := vm.push(val); err != nil {
			return err
		}
	case OpObjSet:
		val, err := vm.pop()
		if err != nil {
			return err
		}
		key, err := vm.pop()
		if err != nil {
			return err
		}
		obj, err := vm.pop()
		if err != nil {
			return err
		}
		if obj.kind != kindObject {
			return fmt.Errorf("OBJ_SET: expected object, got %v", obj.kind)
		}
		keyStr := key.String()
		curLen := obj.objectLen()
		newLen := curLen
		if !obj.obj.has(keyStr) {
			newLen++
		}
		if err := vm.checkCollectionSize(newLen); err != nil {
			return err
		}
		nextObj, copied := obj.obj.set(keyStr, val)
		deltaBytes := int64(estObjectEntry)
		if copied {
			deltaBytes = estCollectionHeader + int64(newLen)*estObjectEntry
		}
		if err := vm.accountAlloc(deltaBytes, 1); err != nil {
			return err
		}
		if err := vm.push(Value{kind: kindObject, obj: nextObj}); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown opcode %d", op)
	}
	return nil
}

// callFunction enters the function at target with argCount arguments on the stack (CALL).
func (vm *VM) callFunction(target, argCount int) error {
	return vm.callFunctionValue(Function(target, ""), argCount)
}

func (vm *VM) callFunctionValue(callee Value, argCount int) error {
	target := int(callee.num)
	code := vm.module.Code
	if argCount < 0 {
		return fmt.Errorf("negative arg count for CALL: %d", argCount)
	}
	base := len(vm.stack) - argCount
	if base < 0 {
		return fmt.Errorf("call requires %d args but stack has %d", argCount, len(vm.stack))
	}
	if target < 0 || target >= len(code) {
		return fmt.Errorf("call target out of range: %d", target)
	}
	info, hasInfo := vm.module.Functions[target]
	localCount := argCount
	if hasInfo {
		if info.Arity != argCount {
			name := info.Name
			if name == "" {
				name = fmt.Sprintf("fn@%d", target)
			}
			return fmt.Errorf("%s expects %d args, got %d", name, info.Arity, argCount)
		}
		if info.Locals > localCount {
			localCount = info.Locals
		}
	}
	if err := vm.ensureStackSize(base + localCount); err != nil {
		return err
	}
	if len(vm.frames) >= maxCallDepth {
		return errors.New("call stack overflow")
	}
	if info.SelfSlot != nil && *info.SelfSlot >= 0 && base+*info.SelfSlot < len(vm.stack) {
		vm.stack[base+*info.SelfSlot] = callee
	}
	frameName := info.Name
	if callee.cl != nil && callee.cl.fn.Name != "" {
		frameName = callee.cl.fn.Name
	}
	frame := callFrame{
		returnIP: vm.ip,
		base:     base,
		locals:   localCount,
		name:     frameName,
		arity:    argCount,
		cl:       callee.cl,
		callLine: vm.CurrentLine(),
		callFile: vm.CurrentFile(),
	}
	vm.frames = append(vm.frames, frame)
	vm.ip = target
	return nil
}

var asciiSingleChars = func() [128]string {
	var t [128]string
	for i := 0; i < 128; i++ {
		t[i] = string(byte(i))
	}
	return t
}()

func (vm *VM) stringRuneLen(s string) int {
	if len(s) == 0 {
		return 0
	}
	if vm.strCacheLen >= 0 && s == vm.strCacheVal {
		return vm.strCacheLen
	}
	n := utf8.RuneCountInString(s)
	if vm.strCacheLen < 0 || s != vm.strCacheVal {
		vm.strCacheVal = s
		vm.strCacheByte = 0
		vm.strCacheRune = 0
	}
	vm.strCacheLen = n
	return n
}

func (vm *VM) readElement(container, key Value, member bool) (Value, error) {
	switch container.kind {
	case kindObject:
		if key.kind != kindString {
			return Nil(), fmt.Errorf("object keys must be strings, got %s", typeName(key))
		}
		if v, ok := container.objectGet(key.str); ok {
			return v, nil
		}
		return Nil(), nil
	case kindArray, kindString:
		if member {
			return Nil(), fmt.Errorf("cannot read property '%s' of %s", key.String(), typeName(container))
		}
		if container.kind == kindArray {
			i, err := elementIndex(key, container.arrayLen(), false)
			if err != nil {
				return Nil(), err
			}
			return container.arrayAt(i), nil
		}
		s := container.str
		i, err := elementIndex(key, vm.stringRuneLen(s), false)
		if err != nil {
			return Nil(), err
		}
		byteOff := 0
		runeIdx := 0
		if vm.strCacheLen >= 0 && s == vm.strCacheVal && i >= vm.strCacheRune {
			byteOff = vm.strCacheByte
			runeIdx = vm.strCacheRune
		}
		for runeIdx < i {
			if s[byteOff] < 0x80 {
				byteOff++
			} else {
				_, size := utf8.DecodeRuneInString(s[byteOff:])
				byteOff += size
			}
			runeIdx++
		}
		vm.strCacheVal = s
		vm.strCacheByte = byteOff
		vm.strCacheRune = i
		if b := s[byteOff]; b < 0x80 {
			return String(asciiSingleChars[b]), nil
		}
		r, _ := utf8.DecodeRuneInString(s[byteOff:])
		return String(string(r)), nil
	default:
		if member {
			return Nil(), fmt.Errorf("cannot read property '%s' of %s", key.String(), typeName(container))
		}
		return Nil(), fmt.Errorf("cannot index %s", typeName(container))
	}
}

// readElement is container[key] (SPEC 4.8): arrays and strings take an integer index,
// objects a string key (a missing key reads as nil). member is true for o.key.
func readElement(container, key Value, member bool) (Value, error) {
	switch container.kind {
	case kindObject:
		if key.kind != kindString {
			return Nil(), fmt.Errorf("object keys must be strings, got %s", typeName(key))
		}
		if v, ok := container.objectGet(key.str); ok {
			return v, nil
		}
		return Nil(), nil
	case kindArray, kindString:
		if member {
			return Nil(), fmt.Errorf("cannot read property '%s' of %s", key.String(), typeName(container))
		}
		if container.kind == kindArray {
			i, err := elementIndex(key, container.arrayLen(), false)
			if err != nil {
				return Nil(), err
			}
			return container.arrayAt(i), nil
		}
		runes := []rune(container.str)
		i, err := elementIndex(key, len(runes), false)
		if err != nil {
			return Nil(), err
		}
		return String(string(runes[i])), nil
	default:
		if member {
			return Nil(), fmt.Errorf("cannot read property '%s' of %s", key.String(), typeName(container))
		}
		return Nil(), fmt.Errorf("cannot index %s", typeName(container))
	}
}

// elementIndex validates an array or string index; forWrite also allows the index one past
// the end, which appends.
func elementIndex(key Value, length int, forWrite bool) (int, error) {
	if key.kind != kindNumber || key.num != math.Trunc(key.num) || math.IsInf(key.num, 0) {
		if key.kind == kindNumber {
			return 0, fmt.Errorf("index must be an integer, got %s", FormatNumber(key.num))
		}
		return 0, fmt.Errorf("index must be an integer, got %s", typeName(key))
	}
	i := int(key.num)
	if i < 0 || i > length || (i == length && !forWrite) {
		return 0, fmt.Errorf("index %d out of bounds (length %d)", i, length)
	}
	return i, nil
}

// withElement updates container[key] = val preserving value semantics via CoW.
func withElement(container, key, val Value, member bool) (Value, error) {
	switch {
	case container.kind == kindObject:
		if key.kind != kindString {
			return Nil(), fmt.Errorf("object keys must be strings, got %s", typeName(key))
		}
		obj := container.obj
		if obj == nil {
			obj = newPObject(nil)
		}
		nextObj, _ := obj.set(key.str, val)
		return Value{kind: kindObject, obj: nextObj}, nil
	case container.kind == kindArray && !member:
		arr := container.arr
		if arr == nil {
			arr = newPArray(nil)
		}
		i, err := elementIndex(key, arr.len(), true)
		if err != nil {
			return Nil(), err
		}
		nextArr, _ := arr.set(i, val)
		return Value{kind: kindArray, arr: nextArr}, nil
	default:
		return Nil(), fmt.Errorf("cannot set an element of %s", typeName(container))
	}
}

func (vm *VM) withElementCoW(container, key, val Value, member bool) (Value, error) {
	switch {
	case container.kind == kindObject:
		if key.kind != kindString {
			return Nil(), fmt.Errorf("object keys must be strings, got %s", typeName(key))
		}
		obj := container.obj
		if obj == nil {
			obj = newPObject(nil)
		}
		curLen := obj.len()
		newLen := curLen
		if !obj.has(key.str) {
			newLen++
		}
		if err := vm.checkCollectionSize(newLen); err != nil {
			return Nil(), err
		}
		nextObj, copied := obj.set(key.str, val)
		deltaBytes := int64(estObjectEntry)
		if copied {
			deltaBytes = estCollectionHeader + int64(newLen)*estObjectEntry
		}
		if err := vm.accountAlloc(deltaBytes, 1); err != nil {
			return Nil(), err
		}
		return Value{kind: kindObject, obj: nextObj}, nil
	case container.kind == kindArray && !member:
		arr := container.arr
		if arr == nil {
			arr = newPArray(nil)
		}
		curLen := arr.len()
		i, err := elementIndex(key, curLen, true)
		if err != nil {
			return Nil(), err
		}
		newLen := curLen
		if i == curLen {
			newLen++
		}
		if err := vm.checkCollectionSize(newLen); err != nil {
			return Nil(), err
		}
		nextArr, copied := arr.set(i, val)
		deltaBytes := int64(estElementSlot)
		if copied {
			deltaBytes = estCollectionHeader + int64(newLen)*estElementSlot
		}
		if err := vm.accountAlloc(deltaBytes, 1); err != nil {
			return Nil(), err
		}
		return Value{kind: kindArray, arr: nextArr}, nil
	default:
		return Nil(), fmt.Errorf("cannot set an element of %s", typeName(container))
	}
}

func isTruthy(v Value) bool {
	switch v.kind {
	case kindNil:
		return false
	case kindBool:
		return v.b
	default:
		return true
	}
}

func valuesEqual(a, b Value) bool {
	if a.kind != b.kind {
		return false
	}
	switch a.kind {
	case kindNil:
		return true
	case kindBool:
		return a.b == b.b
	case kindNumber:
		return a.num == b.num
	case kindString:
		return a.str == b.str
	case kindFunction:
		if a.cl != nil || b.cl != nil {
			return a.cl == b.cl
		}
		return a.num == b.num
	case kindArray:
		// Arrays and objects are values, so equality compares contents (SPEC 4.3).
		if a.arr == b.arr {
			return true
		}
		n := a.arrayLen()
		if n != b.arrayLen() {
			return false
		}
		for i := 0; i < n; i++ {
			if !valuesEqual(a.arrayAt(i), b.arrayAt(i)) {
				return false
			}
		}
		return true
	case kindObject:
		if a.obj == b.obj {
			return true
		}
		if a.objectLen() != b.objectLen() {
			return false
		}
		keys := a.objectKeys()
		for _, k := range keys {
			av, _ := a.objectGet(k)
			bv, ok := b.objectGet(k)
			if !ok || !valuesEqual(av, bv) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func (vm *VM) currentBase() int {
	if len(vm.frames) == 0 {
		return 0
	}
	return vm.frames[len(vm.frames)-1].base
}

func (vm *VM) currentLocals() *int {
	if len(vm.frames) == 0 {
		return &vm.rootLocals
	}
	return &vm.frames[len(vm.frames)-1].locals
}

func (vm *VM) bumpLocals(count int) {
	locals := vm.currentLocals()
	if count > *locals {
		*locals = count
	}
}

// HandlerNames returns registered handler names sorted for stable output.
func (vm *VM) HandlerNames() []string {
	names := make([]string, 0, len(vm.handlers))
	for name := range vm.handlers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// HasHandler reports whether a handler was registered inside this VM.
func (vm *VM) HasHandler(name string) bool {
	if name == "" {
		return false
	}
	_, ok := vm.handlers[name]
	return ok
}

func (vm *VM) findFunctionByName(name string) (FunctionInfo, bool) {
	if name == "" {
		return FunctionInfo{}, false
	}
	if vm.module.FunctionsByName != nil {
		if fn, ok := vm.module.FunctionsByName[name]; ok {
			return fn, true
		}
	}
	for _, fn := range vm.module.Functions {
		if fn.Name == name {
			return fn, true
		}
	}
	return FunctionInfo{}, false
}

// DispatchHandler lets host code invoke a registered handler by name.
func (vm *VM) DispatchHandler(name string, args []Value) (Value, error) {
	return vm.DispatchHandlerWithBudget(name, args, vm.maxSteps, vm.maxDuration)
}

// DispatchHandlerWithBudget invokes a handler with step/time budgets to prevent runaway execution.
func (vm *VM) DispatchHandlerWithBudget(name string, args []Value, maxSteps int, maxDuration time.Duration) (Value, error) {
	h, ok := vm.handlers[name]
	if !ok {
		return Value{}, fmt.Errorf("handler not found: %s", name)
	}
	fn := h.info
	if fn.Arity != len(args) {
		return Value{}, fmt.Errorf("handler %s expects %d args, got %d", name, fn.Arity, len(args))
	}
	vm.halted = false
	vm.yielded = false
	vm.closeUpvalues(0)
	vm.frames = vm.frames[:0]
	vm.stack = vm.stack[:0]
	vm.rootLocals = 0
	vm.ip = fn.Address
	for _, a := range args {
		if err := vm.push(a); err != nil {
			return Value{}, err
		}
	}
	localCount := fn.Locals
	if localCount < len(args) {
		localCount = len(args)
	}
	if err := vm.ensureStackSize(localCount); err != nil {
		return Value{}, err
	}
	if fn.SelfSlot != nil && *fn.SelfSlot >= 0 && *fn.SelfSlot < len(vm.stack) {
		vm.stack[*fn.SelfSlot] = h.fn
	}
	frame := callFrame{returnIP: len(vm.module.Code), base: 0, locals: localCount, name: fn.Name, arity: fn.Arity, cl: h.fn.cl}
	vm.frames = append(vm.frames, frame)
	if err := vm.RunWithBudget(maxSteps, maxDuration); err != nil && !errors.Is(err, ErrYielded) {
		return Value{}, err
	}
	if len(vm.stack) == 0 {
		return Nil(), nil
	}
	return vm.stack[len(vm.stack)-1], nil
}

// DispatchEvent invokes all listeners registered via on(name, fn) using default VM budgets.
func (vm *VM) DispatchEvent(name string, payload Value) error {
	return vm.DispatchEventWithBudget(name, payload, vm.maxSteps, vm.maxDuration)
}

// DispatchEventWithBudget invokes all listeners registered for event `name` in registration
// order, sharing the given step and duration budget across the wake-up.
func (vm *VM) DispatchEventWithBudget(name string, payload Value, maxSteps int, maxDuration time.Duration) error {
	orig := vm.eventListeners[name]
	if len(orig) == 0 {
		return nil
	}
	listeners := make([]Value, len(orig))
	copy(listeners, orig)

	start := time.Now()
	prevActive := vm.budgetActive
	prevSteps := vm.activeSteps
	prevMaxSteps := vm.activeMaxStp
	prevStart := vm.activeStart
	prevMaxDur := vm.activeMaxDur
	vm.budgetActive = true
	vm.activeSteps = 0
	vm.activeMaxStp = maxSteps
	vm.activeStart = start
	vm.activeMaxDur = maxDuration
	defer func() {
		vm.budgetActive = prevActive
		vm.activeSteps = prevSteps
		vm.activeMaxStp = prevMaxSteps
		vm.activeStart = prevStart
		vm.activeMaxDur = prevMaxDur
	}()

	for _, listener := range listeners {
		arity := 1
		if listener.cl != nil {
			arity = listener.cl.fn.Arity
		} else if info, ok := vm.module.Functions[int(listener.num)]; ok {
			arity = info.Arity
		}
		var args []Value
		switch arity {
		case 0:
			args = nil
		case 1:
			args = []Value{payload}
		default:
			return fmt.Errorf("event %s listener expects 0 or 1 args, got %d", name, arity)
		}

		vm.halted = false
		vm.yielded = false
		vm.closeUpvalues(0)
		vm.frames = vm.frames[:0]
		vm.stack = vm.stack[:0]
		vm.rootLocals = 0
		vm.ip = len(vm.module.Code)

		if err := vm.accountValue(payload); err != nil {
			return err
		}
		for _, a := range args {
			if err := vm.push(a); err != nil {
				return err
			}
		}
		fnInfo := FunctionInfo{Name: listener.str, Address: int(listener.num), Arity: arity, Locals: arity}
		if listener.cl != nil {
			fnInfo = listener.cl.fn
		} else if info, ok := vm.module.Functions[int(listener.num)]; ok {
			fnInfo = info
		}
		localCount := fnInfo.Locals
		if localCount < len(args) {
			localCount = len(args)
		}
		if err := vm.ensureStackSize(localCount); err != nil {
			return err
		}
		if fnInfo.SelfSlot != nil && *fnInfo.SelfSlot >= 0 && *fnInfo.SelfSlot < len(vm.stack) {
			vm.stack[*fnInfo.SelfSlot] = listener
		}
		vm.frames = append(vm.frames, callFrame{
			returnIP: len(vm.module.Code),
			base:     0,
			locals:   localCount,
			name:     fnInfo.Name,
			arity:    fnInfo.Arity,
			cl:       listener.cl,
		})
		vm.ip = fnInfo.Address

		for !vm.halted {
			if vm.yielded {
				if vm.sleepUntil.IsZero() || !time.Now().Before(vm.sleepUntil) {
					vm.yielded = false
					vm.sleepUntil = time.Time{}
				} else {
					break
				}
			}
			if vm.activeMaxStp > 0 && vm.activeSteps >= vm.activeMaxStp {
				return ErrStepBudgetExceeded
			}
			if vm.activeMaxDur > 0 && vm.activeSteps&255 == 0 && time.Since(vm.activeStart) >= vm.activeMaxDur {
				return ErrTimeBudgetExceeded
			}
			if err := vm.Step(); err != nil {
				if errors.Is(err, ErrYielded) {
					break
				}
				if isUncatchable(err) {
					return err
				}
				if vm.handleException(err) {
					vm.activeSteps++
					continue
				}
				return err
			}
			vm.activeSteps++
		}
	}
	return nil
}

// Bytecode file format (SPEC §10, decision A5).
const (
	// BytecodeFormat is the "format" field of every PulsarScript bytecode file.
	BytecodeFormat = "pulsarscript-bytecode"
	// BytecodeVersion is the newest format version this VM reads; compile.ts writes it.
	BytecodeVersion = 3
	// MinBytecodeVersion is the oldest version still loaded: 0 is a file without a header,
	// written before SPEC v0.4, which is otherwise identical to version 1. Version 2
	// (SPEC v0.5) adds INDEX_GET, INDEX_SET, MOD, FUNC, CALL_VALUE and ITER_ITEMS. Version 3
	// (SPEC v1.0) adds CLOSURE, GET_UPVALUE, SET_UPVALUE, CLOSE_UPVALUE and source maps.
	MinBytecodeVersion = 0
)

// checkHeader rejects files that are not PulsarScript bytecode or whose format version
// this VM does not know, instead of misreading them.
func checkHeader(format string, version int) error {
	if format == "" && version == 0 {
		return nil // version 0: no header
	}
	if format != BytecodeFormat {
		return fmt.Errorf("not PulsarScript bytecode (format %q)", format)
	}
	if version < 1 || version > BytecodeVersion {
		return fmt.Errorf("bytecode version %d is not supported: this VM reads versions %d to %d; recompile with a matching compiler or upgrade the VM", version, MinBytecodeVersion, BytecodeVersion)
	}
	return nil
}
