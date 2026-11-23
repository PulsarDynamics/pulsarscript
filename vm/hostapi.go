package vm

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// hostapi.json is the registry of built-in functions and host calls (SPEC §8): the single
// source of truth, read here by the VM and by the TypeScript compiler, analyzer and
// interpreter (HostApi.ts imports this same file).
//
//go:embed hostapi.json
var hostAPIJSON []byte

// HostParam is one parameter of a registry entry.
type HostParam struct {
	Name     string `json:"name"`
	Type     string `json:"type"` // any, number, string, boolean, array, object, or a union like string|number
	Optional bool   `json:"optional,omitempty"`
	Variadic bool   `json:"variadic,omitempty"`
	Min      int    `json:"min,omitempty"` // for a variadic parameter: values it needs at least
}

// HostFunction is one registry entry.
type HostFunction struct {
	Name       string      `json:"name"`
	Provider   string      `json:"provider"` // "core": implemented by the VM; "host": supplied by HostCallbacks.HostCall
	Capability string      `json:"capability,omitempty"`
	Deprecated string      `json:"deprecated,omitempty"`
	Params     []HostParam `json:"params"`
	Returns    string      `json:"returns"`
	Doc        string      `json:"doc"`

	minArgs int
	maxArgs int // -1: variadic
}

// Provider values.
const (
	ProviderCore = "core"
	ProviderHost = "host"
)

var hostAPI = mustLoadHostAPI(hostAPIJSON)

func mustLoadHostAPI(data []byte) map[string]*HostFunction {
	var reg struct {
		Version   int            `json:"version"`
		Functions []HostFunction `json:"functions"`
	}
	if err := json.Unmarshal(data, &reg); err != nil {
		panic(fmt.Sprintf("pulsarscriptvm: invalid hostapi.json: %v", err))
	}
	out := make(map[string]*HostFunction, len(reg.Functions))
	for i := range reg.Functions {
		fn := &reg.Functions[i]
		if fn.Provider != ProviderCore && fn.Provider != ProviderHost {
			panic(fmt.Sprintf("pulsarscriptvm: hostapi.json: %s has unknown provider %q", fn.Name, fn.Provider))
		}
		for j, p := range fn.Params {
			if p.Variadic {
				if j != len(fn.Params)-1 {
					panic(fmt.Sprintf("pulsarscriptvm: hostapi.json: %s: variadic parameter must be last", fn.Name))
				}
				fn.minArgs += p.Min
				fn.maxArgs = -1
				continue
			}
			if !p.Optional {
				fn.minArgs++
			}
			fn.maxArgs++
		}
		if _, dup := out[fn.Name]; dup {
			panic(fmt.Sprintf("pulsarscriptvm: hostapi.json: duplicate entry %s", fn.Name))
		}
		out[fn.Name] = fn
	}
	return out
}

// LookupHostFunction returns the registry entry for name.
func LookupHostFunction(name string) (HostFunction, bool) {
	fn, ok := hostAPI[name]
	if !ok {
		return HostFunction{}, false
	}
	return *fn, true
}

// HostFunctionNames lists every registered name; hosts can use it to check their HostCall
// implementation covers the "host" entries.
func HostFunctionNames(provider string) []string {
	var names []string
	for name, fn := range hostAPI {
		if provider == "" || fn.Provider == provider {
			names = append(names, name)
		}
	}
	return names
}

func plural(n int) string {
	if n == 1 {
		return "1 argument"
	}
	return fmt.Sprintf("%d arguments", n)
}

// checkCall validates arity and argument kinds against the registry (the same messages as the
// TypeScript interpreter).
func (fn *HostFunction) checkCall(args []Value) error {
	n := len(args)
	if n < fn.minArgs || (fn.maxArgs >= 0 && n > fn.maxArgs) {
		var expected string
		switch {
		case fn.minArgs == fn.maxArgs:
			expected = plural(fn.minArgs)
		case fn.maxArgs < 0:
			expected = "at least " + plural(fn.minArgs)
		default:
			expected = fmt.Sprintf("%d to %s", fn.minArgs, plural(fn.maxArgs))
		}
		return fmt.Errorf("%s: expected %s but got %d.", fn.Name, expected, n)
	}
	for i, a := range args {
		pi := i
		if pi >= len(fn.Params) {
			pi = len(fn.Params) - 1
		}
		p := fn.Params[pi]
		if p.Type == "any" {
			continue
		}
		kind := typeName(a)
		ok := false
		for _, t := range strings.Split(p.Type, "|") {
			if t == kind {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("%s: argument %d (%s) must be %s, got %s", fn.Name, i+1, p.Name, strings.ReplaceAll(p.Type, "|", " or "), kind)
		}
	}
	return nil
}

// opcodeInfo is the single table of opcode names and operand counts, used by the module
// verifier, the disassembler and step mode (D9).
var opcodeInfo = map[byte]struct {
	name     string
	operands int
}{
	OpConst: {"CONST", 1}, OpAdd: {"ADD", 0}, OpSub: {"SUB", 0}, OpMul: {"MUL", 0}, OpDiv: {"DIV", 0},
	OpNeg: {"NEG", 0}, OpEqual: {"EQUAL", 0}, OpNotEqual: {"NOT_EQUAL", 0}, OpGreater: {"GREATER", 0},
	OpGreaterEqual: {"GREATER_EQUAL", 0}, OpLess: {"LESS", 0}, OpLessEqual: {"LESS_EQUAL", 0},
	OpPop: {"POP", 0}, OpPrint: {"PRINT", 0}, OpDefineGlobal: {"DEFINE_GLOBAL", 1},
	OpGetGlobal: {"GET_GLOBAL", 1}, OpSetGlobal: {"SET_GLOBAL", 1}, OpGetLocal: {"GET_LOCAL", 1},
	OpSetLocal: {"SET_LOCAL", 1}, OpJump: {"JUMP", 1}, OpJumpIfFalse: {"JUMP_IF_FALSE", 1},
	OpCall: {"CALL", 2}, OpReturn: {"RETURN", 0}, OpHostCall: {"HOST_CALL", 2}, OpHalt: {"HALT", 0},
	OpEnterBlock: {"ENTER_BLOCK", 1}, OpExitBlock: {"EXIT_BLOCK", 1}, OpEmitEvent: {"EMIT_EVENT", 0},
	OpPollEvent: {"POLL_EVENT", 0}, OpYield: {"YIELD", 0}, OpSleep: {"SLEEP", 0}, OpNot: {"NOT", 0},
	OpAnd: {"AND", 0}, OpOr: {"OR", 0}, OpTryPush: {"TRY_PUSH", 1}, OpTryPop: {"TRY_POP", 0},
	OpNewArray: {"NEW_ARRAY", 1}, OpArrayGet: {"ARRAY_GET", 0}, OpArraySet: {"ARRAY_SET", 0},
	OpNewObject: {"NEW_OBJECT", 1}, OpObjGet: {"OBJ_GET", 0}, OpObjSet: {"OBJ_SET", 0},
	OpIndexGet: {"INDEX_GET", 1}, OpIndexSet: {"INDEX_SET", 1}, OpMod: {"MOD", 0},
	OpFunc: {"FUNC", 1}, OpCallValue: {"CALL_VALUE", 1}, OpIterItems: {"ITER_ITEMS", 0},
	OpClosure: {"CLOSURE", 1}, OpGetUpvalue: {"GET_UPVALUE", 1},
	OpSetUpvalue: {"SET_UPVALUE", 1}, OpCloseUpvalue: {"CLOSE_UPVALUE", 1},
}

// OpcodeName returns an opcode's mnemonic and operand count; ok is false for unknown opcodes.
func OpcodeName(op byte) (name string, operands int, ok bool) {
	info, ok := opcodeInfo[op]
	if !ok {
		return fmt.Sprintf("UNKNOWN_%d", op), 0, false
	}
	return info.name, info.operands, true
}

// VerifyModule checks a module before it runs: every opcode is known and complete, and every
// HOST_CALL names a registry entry with a valid constant. Like a linker resolving imports, it
// makes an unknown host call a load error instead of a runtime error that try/catch could
// swallow (D3), even for hand-written or stale bytecode.
func VerifyModule(mod Module) error {
	code := mod.Code
	for ip := 0; ip < len(code); {
		if code[ip] < 0 || code[ip] > 255 {
			return fmt.Errorf("invalid opcode %d at %d", code[ip], ip)
		}
		op := byte(code[ip])
		name, operands, ok := OpcodeName(op)
		if !ok {
			return fmt.Errorf("unknown opcode %d at %d", op, ip)
		}
		if ip+operands >= len(code) {
			return fmt.Errorf("%s at %d is missing operands", name, ip)
		}
		if op == OpFunc || op == OpClosure {
			fn, ok := mod.Functions[code[ip+1]]
			if !ok {
				return fmt.Errorf("%s at %d: no function at address %d", name, ip, code[ip+1])
			}
			for j, uv := range fn.Upvalues {
				if uv.Index < 0 {
					return fmt.Errorf("%s at %d: invalid upvalue %d index %d", name, ip, j, uv.Index)
				}
			}
			if fn.SelfSlot != nil && (*fn.SelfSlot < 0 || *fn.SelfSlot >= fn.Locals) {
				return fmt.Errorf("%s at %d: invalid selfSlot %d", name, ip, *fn.SelfSlot)
			}
		}
		if op == OpGetUpvalue || op == OpSetUpvalue || op == OpCloseUpvalue {
			if code[ip+1] < 0 {
				return fmt.Errorf("%s at %d: negative operand %d", name, ip, code[ip+1])
			}
		}
		if (op == OpIndexGet || op == OpIndexSet) && code[ip+1] != 0 && code[ip+1] != 1 {
			return fmt.Errorf("%s at %d: operand must be 0 or 1, got %d", name, ip, code[ip+1])
		}
		if op == OpHostCall {
			idx := code[ip+1]
			if idx < 0 || idx >= len(mod.Constants) || mod.Constants[idx].kind != kindString {
				return fmt.Errorf("HOST_CALL at %d: name constant %d is not a string", ip, idx)
			}
			callee := mod.Constants[idx].str
			fn, known := hostAPI[callee]
			if !known {
				return fmt.Errorf("unknown host call %q at %d", callee, ip)
			}
			argc := code[ip+2]
			if argc < fn.minArgs || (fn.maxArgs >= 0 && argc > fn.maxArgs) {
				return fmt.Errorf("host call %q at %d passes %d arguments", callee, ip, argc)
			}
		}
		ip += 1 + operands
	}
	return nil
}
