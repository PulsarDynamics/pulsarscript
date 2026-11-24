package vm

import (
	"math"
	"math/rand"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// builtinFunc implements a "core" registry entry. Arity and argument kinds are already checked
// against hostapi.json when it runs.
type builtinFunc func(vm *VM, args []Value) (Value, error)

// coreBuiltins holds one implementation per "core" entry in hostapi.json (SPEC §8); a test
// checks the two match. They mirror the TypeScript interpreter's natives.
var coreBuiltins map[string]builtinFunc

func init() {
	num := func(f func(float64) float64) builtinFunc {
		return func(_ *VM, a []Value) (Value, error) { return Number(f(a[0].num)), nil }
	}
	coreBuiltins = map[string]builtinFunc{
		// Core / types
		"typeOf": func(_ *VM, a []Value) (Value, error) { return String(typeName(a[0])), nil },
		"string": func(vm *VM, a []Value) (Value, error) {
			if a[0].kind == kindString {
				return a[0], nil
			}
			s := a[0].String()
			if err := vm.checkStringSize(len(s)); err != nil {
				return Value{}, err
			}
			return String(s), nil
		},
		"number": func(_ *VM, a []Value) (Value, error) { return toNumber(a[0]), nil },
		"concat": func(vm *VM, a []Value) (Value, error) {
			parts := make([]string, len(a))
			totalLen := 0
			for i, v := range a {
				if v.kind == kindString {
					parts[i] = v.str
				} else {
					parts[i] = v.String()
				}
				totalLen += len(parts[i])
			}
			if err := vm.checkStringSize(totalLen); err != nil {
				return Value{}, err
			}
			var sb strings.Builder
			sb.Grow(totalLen)
			for _, p := range parts {
				sb.WriteString(p)
			}
			return String(sb.String()), nil
		},
		"len": func(vm *VM, a []Value) (Value, error) {
			if a[0].kind == kindArray {
				return Number(float64(a[0].arrayLen())), nil
			}
			// Length in Unicode code points, not bytes (O(1) cached when reused).
			return Number(float64(vm.stringRuneLen(a[0].str))), nil
		},

		// Math
		"abs":   num(math.Abs),
		"floor": num(math.Floor),
		"ceil":  num(math.Ceil),
		"round": num(roundHalfUp),
		"sqrt":  num(math.Sqrt),
		"pow":   func(_ *VM, a []Value) (Value, error) { return Number(math.Pow(a[0].num, a[1].num)), nil },
		"min":   func(_ *VM, a []Value) (Value, error) { return Number(jsMin(a[0].num, a[1].num)), nil },
		"max":   func(_ *VM, a []Value) (Value, error) { return Number(jsMax(a[0].num, a[1].num)), nil },
		"clamp": func(_ *VM, a []Value) (Value, error) {
			return Number(jsMin(jsMax(a[0].num, a[1].num), a[2].num)), nil
		},
		"isInteger": func(_ *VM, a []Value) (Value, error) {
			x := a[0].num
			return Bool(a[0].kind == kindNumber && !math.IsInf(x, 0) && x == math.Trunc(x)), nil
		},
		"isFinite": func(_ *VM, a []Value) (Value, error) {
			x := a[0].num
			return Bool(a[0].kind == kindNumber && !math.IsInf(x, 0) && !math.IsNaN(x)), nil
		},
		"sin":    num(math.Sin),
		"cos":    num(math.Cos),
		"tan":    num(math.Tan),
		"atan2":  func(_ *VM, a []Value) (Value, error) { return Number(math.Atan2(a[0].num, a[1].num)), nil },
		"log":    num(math.Log),
		"log10":  num(math.Log10),
		"exp":    num(math.Exp),
		"mathPi": func(_ *VM, _ []Value) (Value, error) { return Number(math.Pi), nil },
		"mathE":  func(_ *VM, _ []Value) (Value, error) { return Number(math.E), nil },

		// Strings: indices and lengths count code points, like len.
		"toUpper": func(vm *VM, a []Value) (Value, error) {
			res := strings.ToUpper(a[0].str)
			if err := vm.checkStringSize(len(res)); err != nil {
				return Value{}, err
			}
			return String(res), nil
		},
		"toLower": func(vm *VM, a []Value) (Value, error) {
			res := strings.ToLower(a[0].str)
			if err := vm.checkStringSize(len(res)); err != nil {
				return Value{}, err
			}
			return String(res), nil
		},
		"trim": func(_ *VM, a []Value) (Value, error) { return String(strings.TrimSpace(a[0].str)), nil },
		"indexOf": func(vm *VM, a []Value) (Value, error) {
			hasStart := len(a) == 3
			startNum := 0.0
			if hasStart {
				startNum = a[2].num
			}
			idx, err := indexOfRunes(a[0].str, a[1].str, hasStart, startNum)
			if err != nil {
				return Value{}, vm.runtimeError("%s", err.Error())
			}
			return Number(float64(idx)), nil
		},
		"lastIndexOf": func(vm *VM, a []Value) (Value, error) {
			hasStart := len(a) == 3
			startNum := 0.0
			if hasStart {
				startNum = a[2].num
			}
			idx, err := lastIndexOfRunes(a[0].str, a[1].str, hasStart, startNum)
			if err != nil {
				return Value{}, vm.runtimeError("%s", err.Error())
			}
			return Number(float64(idx)), nil
		},
		"split": func(vm *VM, a []Value) (Value, error) {
			s, sep := a[0].str, a[1].str
			var out []Value
			if sep == "" {
				n := utf8.RuneCountInString(s)
				if err := vm.checkCollectionSize(n); err != nil {
					return Value{}, err
				}
				if err := vm.accountAlloc(estCollectionHeader+int64(n)*estElementSlot, 1); err != nil {
					return Value{}, err
				}
				out = make([]Value, 0, n)
				for _, r := range s {
					out = append(out, String(string(r)))
				}
			} else {
				parts := strings.Split(s, sep)
				if err := vm.checkCollectionSize(len(parts)); err != nil {
					return Value{}, err
				}
				if err := vm.accountAlloc(estCollectionHeader+int64(len(parts))*estElementSlot, 1); err != nil {
					return Value{}, err
				}
				out = make([]Value, len(parts))
				for i, p := range parts {
					out[i] = String(p)
				}
			}
			return Array(out), nil
		},
		"replace": func(vm *VM, a []Value) (Value, error) {
			s, target, repl := a[0].str, a[1].str, a[2].str
			var count int
			if target == "" {
				count = utf8.RuneCountInString(s) + 1
			} else {
				count = strings.Count(s, target)
			}
			if vm.maxStringBytes > 0 && count > 0 && len(repl) > len(target) {
				extra := count * (len(repl) - len(target))
				if err := vm.checkStringSize(len(s) + extra); err != nil {
					return Value{}, err
				}
			}
			res := strings.ReplaceAll(s, target, repl)
			if err := vm.checkStringSize(len(res)); err != nil {
				return Value{}, err
			}
			return String(res), nil
		},
		"startsWith": func(_ *VM, a []Value) (Value, error) {
			return Bool(strings.HasPrefix(a[0].str, a[1].str)), nil
		},
		"endsWith": func(_ *VM, a []Value) (Value, error) {
			return Bool(strings.HasSuffix(a[0].str, a[1].str)), nil
		},
		"repeat": func(vm *VM, a []Value) (Value, error) {
			s := a[0].str
			cnt := a[1].num
			if math.IsNaN(cnt) || math.IsInf(cnt, 0) || cnt < 0 {
				return Value{}, vm.runtimeError("repeat: count must be a finite non-negative number")
			}
			t := math.Trunc(cnt)
			if t == 0 {
				return String(""), nil
			}
			if s == "" {
				return String(""), nil
			}
			if t > float64(math.MaxInt32) {
				if vm.maxStringBytes > 0 {
					return Value{}, vm.checkStringSize(vm.maxStringBytes + 1)
				}
				return Value{}, vm.runtimeError("repeat: count too large")
			}
			n := int(t)
			if vm.maxStringBytes > 0 && n > vm.maxStringBytes/len(s) {
				return Value{}, vm.checkStringSize(vm.maxStringBytes + 1)
			}
			if err := vm.checkStringSize(len(s) * n); err != nil {
				return Value{}, err
			}
			return String(strings.Repeat(s, n)), nil
		},
		"padStart": func(vm *VM, a []Value) (Value, error) {
			fill := " "
			if len(a) == 3 {
				fill = a[2].str
			}
			return padStringRunes(vm, "padStart", a[0].str, a[1].num, fill, true)
		},
		"padEnd": func(vm *VM, a []Value) (Value, error) {
			fill := " "
			if len(a) == 3 {
				fill = a[2].str
			}
			return padStringRunes(vm, "padEnd", a[0].str, a[1].num, fill, false)
		},
		"charCodeAt": func(vm *VM, a []Value) (Value, error) {
			if math.IsNaN(a[1].num) || math.IsInf(a[1].num, 0) {
				return Value{}, vm.runtimeError("charCodeAt: index must be a finite number")
			}
			idx := int(math.Trunc(a[1].num))
			if idx < 0 {
				return Nil(), nil
			}
			i := 0
			for _, r := range a[0].str {
				if i == idx {
					return Number(float64(r)), nil
				}
				i++
			}
			return Nil(), nil
		},
		"fromCharCode": func(vm *VM, a []Value) (Value, error) {
			c := a[0].num
			if math.IsNaN(c) || math.IsInf(c, 0) || c != math.Trunc(c) || c < 0 || c > 0x10FFFF || (c >= 0xD800 && c <= 0xDFFF) {
				return Value{}, vm.runtimeError("fromCharCode: invalid Unicode code point %v", c)
			}
			return String(string(rune(int(c)))), nil
		},
		"substr": func(vm *VM, a []Value) (Value, error) {
			start, length := a[1].num, a[2].num
			if math.IsNaN(start) || math.IsInf(start, 0) || math.IsNaN(length) || math.IsInf(length, 0) {
				return Value{}, vm.runtimeError("substr: start and length must be finite numbers")
			}
			i, n := int(math.Trunc(start)), int(math.Trunc(length))
			if i < 0 {
				return Value{}, vm.runtimeError("substr: start index cannot be negative")
			}
			if n < 0 {
				return Value{}, vm.runtimeError("substr: length cannot be negative")
			}
			runes := []rune(a[0].str)
			if i >= len(runes) {
				return String(""), nil
			}
			end := i + n
			if end > len(runes) {
				end = len(runes)
			}
			sub := string(runes[i:end])
			if err := vm.checkStringSize(len(sub)); err != nil {
				return Value{}, err
			}
			return String(sub), nil
		},

		// Parsing
		"parseInt": func(_ *VM, a []Value) (Value, error) { return parseIntStrict(a[0], a[1].num), nil },
		"parseFloat": func(_ *VM, a []Value) (Value, error) {
			if a[0].kind == kindNumber {
				return a[0], nil
			}
			s := strings.TrimSpace(a[0].str)
			if !isDecimalLiteral(s, false) {
				return Nil(), nil
			}
			f, err := strconv.ParseFloat(s, 64)
			if err != nil || math.IsInf(f, 0) {
				return Nil(), nil
			}
			return Number(f), nil
		},
		"toNumberOr": func(_ *VM, a []Value) (Value, error) {
			if n := toNumber(a[0]); n.kind != kindNil {
				return n, nil
			}
			return a[1], nil
		},

		// Time / random
		"clock": func(_ *VM, _ []Value) (Value, error) { return Number(float64(time.Now().UnixMilli())), nil },
		"dateFormat": func(vm *VM, a []Value) (Value, error) {
			pattern := "YYYY-MM-DDTHH:mm:ss.SSSZ"
			if len(a) == 2 {
				pattern = a[1].str
			}
			res, err := formatUTCDate(vm, a[0].num, pattern)
			if err != nil {
				return Value{}, err
			}
			return String(res), nil
		},
		"dateParse": func(_ *VM, a []Value) (Value, error) {
			return parseISODateStrict(a[0].str), nil
		},
		"random": func(vm *VM, _ []Value) (Value, error) { return Number(vm.random()), nil },
		"randomInt": func(vm *VM, a []Value) (Value, error) {
			x, y := math.Trunc(a[0].num), math.Trunc(a[1].num)
			lo, hi := math.Min(x, y), math.Max(x, y)
			return Number(lo + math.Floor(vm.random()*(hi-lo+1))), nil
		},
		"randomSeed": func(vm *VM, a []Value) (Value, error) {
			vm.rng = rand.New(rand.NewSource(int64(a[0].num)))
			return Nil(), nil
		},

		// Arrays and objects are values: every function returns a new value (SPEC §3.3).
		"arrayLen": func(_ *VM, a []Value) (Value, error) { return Number(float64(a[0].arrayLen())), nil },
		"arrayPush": func(vm *VM, a []Value) (Value, error) {
			curLen := a[0].arrayLen()
			newLen := curLen + len(a) - 1
			if err := vm.checkCollectionSize(newLen); err != nil {
				return Value{}, err
			}
			nextArr, copied := a[0].arr.pushMany(a[1:])
			deltaBytes := int64(len(a)-1) * estElementSlot
			if copied {
				deltaBytes = estCollectionHeader + int64(newLen)*estElementSlot
			}
			if err := vm.accountAlloc(deltaBytes, len(a)-1); err != nil {
				return Value{}, err
			}
			return Value{kind: kindArray, arr: nextArr}, nil
		},
		"arrayPop": func(_ *VM, a []Value) (Value, error) {
			n := a[0].arrayLen()
			if n == 0 {
				return Nil(), nil
			}
			return a[0].arrayAt(n - 1), nil
		},
		"arraySlice": func(vm *VM, a []Value) (Value, error) {
			arrLen := a[0].arrayLen()
			start := math.Max(0, math.Trunc(a[1].num))
			end := math.Min(float64(arrLen), math.Trunc(a[2].num))
			if math.IsNaN(start) || math.IsNaN(end) || start > end {
				if err := vm.accountAlloc(estCollectionHeader, 1); err != nil {
					return Value{}, err
				}
				return Array([]Value{}), nil
			}
			n := int(end) - int(start)
			if err := vm.accountAlloc(estCollectionHeader+int64(n)*estElementSlot, 1); err != nil {
				return Value{}, err
			}
			s := int(start)
			out := make([]Value, n)
			for i := 0; i < n; i++ {
				out[i] = a[0].arrayAt(s + i)
			}
			return Array(out), nil
		},
		"arrayConcat": func(vm *VM, a []Value) (Value, error) {
			total := 0
			for _, v := range a {
				total += v.arrayLen()
			}
			if err := vm.checkCollectionSize(total); err != nil {
				return Value{}, err
			}
			if err := vm.accountAlloc(estCollectionHeader+int64(total)*estElementSlot, 1); err != nil {
				return Value{}, err
			}
			out := make([]Value, 0, total)
			for _, v := range a {
				n := v.arrayLen()
				for i := 0; i < n; i++ {
					out = append(out, v.arrayAt(i))
				}
			}
			return Array(out), nil
		},
		"arrayIndexOf": func(_ *VM, a []Value) (Value, error) {
			n := a[0].arrayLen()
			for i := 0; i < n; i++ {
				if valuesEqual(a[0].arrayAt(i), a[1]) {
					return Number(float64(i)), nil
				}
			}
			return Number(-1), nil
		},
		"arrayIncludes": func(_ *VM, a []Value) (Value, error) {
			n := a[0].arrayLen()
			for i := 0; i < n; i++ {
				if valuesEqual(a[0].arrayAt(i), a[1]) {
					return Bool(true), nil
				}
			}
			return Bool(false), nil
		},
		"arrayJoin": func(vm *VM, a []Value) (Value, error) {
			sep := ","
			if len(a) == 2 {
				sep = a[1].str
			}
			n := a[0].arrayLen()
			if n == 0 {
				return String(""), nil
			}
			var sb strings.Builder
			for i := 0; i < n; i++ {
				if i > 0 {
					sb.WriteString(sep)
				}
				el := a[0].arrayAt(i)
				if el.kind == kindString {
					sb.WriteString(el.str)
				} else {
					sb.WriteString(el.String())
				}
				if err := vm.checkStringSize(sb.Len()); err != nil {
					return Value{}, err
				}
			}
			return String(sb.String()), nil
		},
		"arrayMap": func(vm *VM, a []Value) (Value, error) {
			n := a[0].arrayLen()
			if err := vm.checkCollectionSize(n); err != nil {
				return Value{}, err
			}
			out := make([]Value, n)
			for i := 0; i < n; i++ {
				v, err := vm.callValueSync(a[1], []Value{a[0].arrayAt(i)})
				if err != nil {
					return Value{}, err
				}
				out[i] = v
			}
			if err := vm.accountAlloc(estCollectionHeader+int64(n)*estElementSlot, 1); err != nil {
				return Value{}, err
			}
			return Array(out), nil
		},
		"arrayFilter": func(vm *VM, a []Value) (Value, error) {
			n := a[0].arrayLen()
			out := make([]Value, 0)
			for i := 0; i < n; i++ {
				el := a[0].arrayAt(i)
				v, err := vm.callValueSync(a[1], []Value{el})
				if err != nil {
					return Value{}, err
				}
				if isTruthy(v) {
					out = append(out, el)
				}
			}
			if err := vm.accountAlloc(estCollectionHeader+int64(len(out))*estElementSlot, 1); err != nil {
				return Value{}, err
			}
			return Array(out), nil
		},
		"arrayReduce": func(vm *VM, a []Value) (Value, error) {
			acc := a[2]
			n := a[0].arrayLen()
			for i := 0; i < n; i++ {
				var err error
				acc, err = vm.callValueSync(a[1], []Value{acc, a[0].arrayAt(i)})
				if err != nil {
					return Value{}, err
				}
			}
			return acc, nil
		},
		"arrayFind": func(vm *VM, a []Value) (Value, error) {
			n := a[0].arrayLen()
			for i := 0; i < n; i++ {
				el := a[0].arrayAt(i)
				v, err := vm.callValueSync(a[1], []Value{el})
				if err != nil {
					return Value{}, err
				}
				if isTruthy(v) {
					return el, nil
				}
			}
			return Nil(), nil
		},
		"arraySort": func(vm *VM, a []Value) (Value, error) {
			n := a[0].arrayLen()
			items := make([]Value, n)
			for i := 0; i < n; i++ {
				items[i] = a[0].arrayAt(i)
			}
			var sorted []Value
			var err error
			if len(a) == 2 {
				cmp := a[1]
				if cmp.cl != nil && cmp.cl.fn.Arity != 2 {
					return Value{}, vm.runtimeError("%s expects 2 args, got %d", cmp.cl.fn.Name, cmp.cl.fn.Arity)
				} else if info, ok := vm.module.Functions[int(cmp.num)]; ok && info.Arity != 2 {
					return Value{}, vm.runtimeError("%s expects 2 args, got %d", info.Name, info.Arity)
				}
				sorted, err = mergeSortValues(items, func(x, y Value) (bool, error) {
					res, err := vm.callValueSync(cmp, []Value{x, y})
					if err != nil {
						return false, err
					}
					if res.kind != kindNumber || math.IsNaN(res.num) {
						return false, vm.runtimeError("arraySort: comparator must return a finite or numeric value, got %s", typeName(res))
					}
					return res.num < 0, nil
				})
			} else {
				sorted, err = defaultSortCompare(vm, items)
			}
			if err != nil {
				return Value{}, err
			}
			if err := vm.accountAlloc(estCollectionHeader+int64(len(sorted))*estElementSlot, 1); err != nil {
				return Value{}, err
			}
			return Array(sorted), nil
		},
		"objKeys": func(vm *VM, a []Value) (Value, error) {
			n := a[0].objectLen()
			if err := vm.accountAlloc(estCollectionHeader+int64(n)*estElementSlot, 1); err != nil {
				return Value{}, err
			}
			names := a[0].objectKeys()
			out := make([]Value, len(names))
			for i, k := range names {
				out[i] = String(k)
			}
			return Array(out), nil
		},
		"objValues": func(vm *VM, a []Value) (Value, error) {
			n := a[0].objectLen()
			if err := vm.accountAlloc(estCollectionHeader+int64(n)*estElementSlot, 1); err != nil {
				return Value{}, err
			}
			names := a[0].objectKeys()
			out := make([]Value, len(names))
			for i, k := range names {
				val, _ := a[0].objectGet(k)
				out[i] = val
			}
			return Array(out), nil
		},
		"objHas": func(_ *VM, a []Value) (Value, error) {
			return Bool(a[0].obj.has(a[1].String())), nil
		},
		"objGet": func(_ *VM, a []Value) (Value, error) {
			if v, ok := a[0].objectGet(a[1].String()); ok {
				return v, nil
			}
			return Nil(), nil
		},
		"objSet": func(vm *VM, a []Value) (Value, error) {
			keyStr := a[1].String()
			newLen := a[0].objectLen()
			if !a[0].obj.has(keyStr) {
				newLen++
			}
			if err := vm.checkCollectionSize(newLen); err != nil {
				return Value{}, err
			}
			nextObj, copied := a[0].obj.set(keyStr, a[2])
			deltaBytes := int64(estObjectEntry)
			if copied {
				deltaBytes = estCollectionHeader + int64(newLen)*estObjectEntry
			}
			if err := vm.accountAlloc(deltaBytes, 1); err != nil {
				return Value{}, err
			}
			return Value{kind: kindObject, obj: nextObj}, nil
		},
		"objDelete": func(vm *VM, a []Value) (Value, error) {
			keyStr := a[1].String()
			nextObj, deleted, copied := a[0].obj.deleteKey(keyStr)
			if !deleted {
				return a[0], nil
			}
			newLen := nextObj.len()
			var deltaBytes int64
			if copied {
				deltaBytes = estCollectionHeader + int64(newLen)*estObjectEntry
			}
			if err := vm.accountAlloc(deltaBytes, 1); err != nil {
				return Value{}, err
			}
			return Value{kind: kindObject, obj: nextObj}, nil
		},
		"objEntries": func(vm *VM, a []Value) (Value, error) {
			keys := a[0].objectKeys()
			n := len(keys)
			if err := vm.checkCollectionSize(n); err != nil {
				return Value{}, err
			}
			if err := vm.accountAlloc(estCollectionHeader+int64(n)*(estElementSlot+estCollectionHeader+2*estElementSlot), 1+n); err != nil {
				return Value{}, err
			}
			out := make([]Value, n)
			for i, k := range keys {
				v, _ := a[0].objectGet(k)
				out[i] = Array([]Value{String(k), v})
			}
			return Array(out), nil
		},
		"objMerge": func(vm *VM, a []Value) (Value, error) {
			merged := make(map[string]Value)
			for _, objVal := range a {
				for _, k := range objVal.objectKeys() {
					v, _ := objVal.objectGet(k)
					if _, exists := merged[k]; !exists {
						if err := vm.checkCollectionSize(len(merged) + 1); err != nil {
							return Value{}, err
						}
					}
					merged[k] = v
				}
			}
			if err := vm.accountAlloc(estCollectionHeader+int64(len(merged))*estObjectEntry, 1); err != nil {
				return Value{}, err
			}
			return Object(merged), nil
		},
		"jsonParse": func(vm *VM, a []Value) (Value, error) {
			return parseJSONStrict(vm, a[0].str)
		},
		"jsonStringify": func(vm *VM, a []Value) (Value, error) {
			s, err := stringifyJSONValue(vm, a[0])
			if err != nil {
				return Value{}, err
			}
			return String(s), nil
		},

		// Handlers
		"registerHandler": func(vm *VM, a []Value) (Value, error) {
			if a[1].kind == kindFunction {
				addr := int(a[1].num)
				info, ok := vm.module.Functions[addr]
				if !ok {
					info = FunctionInfo{Name: a[1].str, Address: addr}
				}
				if a[1].cl != nil {
					info = a[1].cl.fn
				}
				vm.handlers[a[0].str] = handlerEntry{info: info, fn: a[1]}
				return Nil(), nil
			}
			fn, ok := vm.findFunctionByName(a[1].str)
			if !ok {
				return Value{}, vm.runtimeError("registerHandler: handler function not found: %s", a[1].str)
			}
			vm.handlers[a[0].str] = handlerEntry{info: fn, fn: Function(fn.Address, fn.Name)}
			return Nil(), nil
		},
		"on": func(vm *VM, a []Value) (Value, error) {
			vm.eventListeners[a[0].str] = append(vm.eventListeners[a[0].str], a[1])
			return Nil(), nil
		},
		"emit": func(vm *VM, a []Value) (Value, error) {
			payload := Nil()
			if len(a) == 2 {
				payload = a[1]
			}
			evt := Object(map[string]Value{"name": a[0], "payload": payload})
			if vm.host.EmitEvent != nil {
				if _, err := vm.host.EmitEvent(evt); err != nil {
					return Value{}, err
				}
				return Nil(), nil
			}
			if len(vm.events) >= vm.eventCap {
				return Value{}, vm.runtimeError("event queue full")
			}
			vm.events = append(vm.events, evt)
			return Nil(), nil
		},
		"sleep": func(vm *VM, a []Value) (Value, error) {
			if math.IsNaN(a[0].num) || math.IsInf(a[0].num, 0) || a[0].num < 0 {
				return Value{}, vm.runtimeError("sleep: argument 1 (ms) must be a finite non-negative number")
			}
			dur := time.Duration(a[0].num * float64(time.Millisecond))
			vm.sleepUntil = time.Now().Add(dur)
			vm.yielded = true
			return Value{}, ErrYielded
		},
		"yield": func(vm *VM, _ []Value) (Value, error) {
			vm.yielded = true
			return Value{}, ErrYielded
		},
	}
}

// toNumber implements number(): numbers as-is, booleans 1/0, decimal-literal strings parsed.
func toNumber(v Value) Value {
	switch v.kind {
	case kindNumber:
		return v
	case kindBool:
		if v.b {
			return Number(1)
		}
		return Number(0)
	case kindString:
		if isDecimalLiteral(v.str, true) {
			if f, err := strconv.ParseFloat(strings.TrimSpace(v.str), 64); err == nil {
				return Number(f)
			}
		}
	}
	return Nil()
}

// roundHalfUp rounds like JavaScript's Math.round: halves go toward +Infinity.
func roundHalfUp(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// jsMin and jsMax propagate NaN like JavaScript's Math.min/Math.max.
func jsMin(a, b float64) float64 {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	return math.Min(a, b)
}

func jsMax(a, b float64) float64 {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	return math.Max(a, b)
}

// parseIntStrict parses the whole string as an integer in base 2-36; nil on any bad digit.
func parseIntStrict(v Value, base float64) Value {
	if v.kind == kindNumber {
		if v.num == math.Trunc(v.num) && !math.IsInf(v.num, 0) {
			return v
		}
		return Nil()
	}
	if base != math.Trunc(base) || base < 2 || base > 36 {
		return Nil()
	}
	b := int(base)
	s := strings.TrimSpace(v.str)
	sign := 1.0
	if strings.HasPrefix(s, "+") || strings.HasPrefix(s, "-") {
		if s[0] == '-' {
			sign = -1
		}
		s = s[1:]
	}
	if s == "" {
		return Nil()
	}
	value := 0.0
	for _, r := range strings.ToLower(s) {
		d := 99
		switch {
		case r >= '0' && r <= '9':
			d = int(r - '0')
		case r >= 'a' && r <= 'z':
			d = int(r-'a') + 10
		}
		if d >= b {
			return Nil()
		}
		value = value*float64(b) + float64(d)
	}
	return Number(sign * value)
}

// SetSeed makes random and randomInt repeatable, like randomSeed(seed) in a script.
func (vm *VM) SetSeed(seed int64) {
	vm.rng = rand.New(rand.NewSource(seed))
}

func (vm *VM) random() float64 {
	if vm.rng != nil {
		return vm.rng.Float64()
	}
	return rand.Float64()
}
