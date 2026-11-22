package vm

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// TestOpcodeTableMatchesTypeScript ensures the VM opcode constants stay aligned
// with the authoritative TypeScript enum in pulsarscript/Bytecode.ts.
func TestOpcodeTableMatchesTypeScript(t *testing.T) {
	tsPath := filepath.Join("..", "Bytecode.ts")
	data, err := os.ReadFile(tsPath)
	if err != nil {
		t.Fatalf("read Bytecode.ts: %v", err)
	}

	tsOpcodes, err := parseTypeScriptOpcodes(string(data))
	if err != nil {
		t.Fatalf("parse TypeScript opcodes: %v", err)
	}

	goOpcodes := map[string]byte{
		"CONST":         OpConst,
		"ADD":           OpAdd,
		"SUB":           OpSub,
		"MUL":           OpMul,
		"DIV":           OpDiv,
		"NEG":           OpNeg,
		"EQUAL":         OpEqual,
		"NOT_EQUAL":     OpNotEqual,
		"GREATER":       OpGreater,
		"GREATER_EQUAL": OpGreaterEqual,
		"LESS":          OpLess,
		"LESS_EQUAL":    OpLessEqual,
		"POP":           OpPop,
		"PRINT":         OpPrint,
		"DEFINE_GLOBAL": OpDefineGlobal,
		"GET_GLOBAL":    OpGetGlobal,
		"SET_GLOBAL":    OpSetGlobal,
		"GET_LOCAL":     OpGetLocal,
		"SET_LOCAL":     OpSetLocal,
		"JUMP":          OpJump,
		"JUMP_IF_FALSE": OpJumpIfFalse,
		"CALL":          OpCall,
		"RETURN":        OpReturn,
		"HOST_CALL":     OpHostCall,
		"HALT":          OpHalt,
		"ENTER_BLOCK":   OpEnterBlock,
		"EXIT_BLOCK":    OpExitBlock,
		"EMIT_EVENT":    OpEmitEvent,
		"POLL_EVENT":    OpPollEvent,
		"YIELD":         OpYield,
		"SLEEP":         OpSleep,
		"NOT":           OpNot,
		"AND":           OpAnd,
		"OR":            OpOr,
		"TRY_PUSH":      OpTryPush,
		"TRY_POP":       OpTryPop,
		"NEW_ARRAY":     OpNewArray,
		"ARRAY_GET":     OpArrayGet,
		"ARRAY_SET":     OpArraySet,
		"NEW_OBJECT":    OpNewObject,
		"OBJ_GET":       OpObjGet,
		"OBJ_SET":       OpObjSet,
		"INDEX_GET":     OpIndexGet,
		"INDEX_SET":     OpIndexSet,
		"MOD":           OpMod,
		"FUNC":          OpFunc,
		"CALL_VALUE":    OpCallValue,
		"ITER_ITEMS":    OpIterItems,
	}

	for name, goVal := range goOpcodes {
		tsVal, ok := tsOpcodes[name]
		if !ok {
			t.Fatalf("Go opcode %s missing from TypeScript enum", name)
		}
		if goVal != tsVal {
			t.Fatalf("Opcode mismatch for %s: go=%d ts=%d", name, goVal, tsVal)
		}
	}

	for name := range tsOpcodes {
		if _, ok := goOpcodes[name]; !ok {
			t.Fatalf("TypeScript opcode %s missing from Go constants", name)
		}
	}
}

var opcodeLine = regexp.MustCompile(`^\s*([A-Z_]+)\s*=\s*(\d+)\s*,?`)

func parseTypeScriptOpcodes(src string) (map[string]byte, error) {
	lines := strings.Split(src, "\n")
	inEnum := false
	result := make(map[string]byte)

	for _, line := range lines {
		if strings.Contains(line, "enum Opcode") {
			inEnum = true
			continue
		}
		if inEnum && strings.Contains(line, "}") {
			break
		}
		if !inEnum {
			continue
		}
		m := opcodeLine.FindStringSubmatch(line)
		if len(m) != 3 {
			continue
		}
		val, err := strconv.Atoi(m[2])
		if err != nil {
			return nil, err
		}
		result[m[1]] = byte(val)
	}
	return result, nil
}
