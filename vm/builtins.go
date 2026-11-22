package vm

import (
	"math"
	"math/rand"
	"regexp"
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

var floatLiteralRe = regexp.MustCompile(`^[+-]?(\d+\.\d+|\d+\.\d*|\.\d+|\d+)$`)

func init() {
	num := func(f func(float64) float64) builtinFunc {
		return func(_ *VM, a []Value) (Value, error) { return Number(f(a[0].num)), nil }
	}
	coreBuiltins = map[string]builtinFunc{
		// Core / types
		"typeOf": func(_ *VM, a []Value) (Value, error) { return String(typeName(a[0])), nil },
		"string": func(_ *VM, a []Value) (Value, error) { return String(a[0].String()), nil },
		"number": func(_ *VM, a []Value) (Value, error) { return toNumber(a[0]), nil },
		"concat": func(_ *VM, a []Value) (Value, error) {
			var sb strings.Builder
			for _, v := range a {
				sb.WriteString(v.String())
			}
			return String(sb.String()), nil
		},
		"len": func(_ *VM, a []Value) (Value, error) {
			if a[0].kind == kindArray {
				return Number(float64(len(a[0].arr))), nil
			}
			// Length in Unicode code points, not bytes.
			return Number(float64(utf8.RuneCountInString(a[0].str))), nil
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

		// Strings: indices and lengths count code points, like len.
		"toUpper": func(_ *VM, a []Value) (Value, error) { return String(strings.ToUpper(a[0].str)), nil },
		"toLower": func(_ *VM, a []Value) (Value, error) { return String(strings.ToLower(a[0].str)), nil },
		"trim":    func(_ *VM, a []Value) (Value, error) { return String(strings.TrimSpace(a[0].str)), nil },
		"indexOf": func(_ *VM, a []Value) (Value, error) {
			i := strings.Index(a[0].str, a[1].str)
			if i < 0 {
				return Number(-1), nil
			}
			return Number(float64(utf8.RuneCountInString(a[0].str[:i]))), nil
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
			return String(string(runes[i:end])), nil
		},

		// Parsing
		"parseInt": func(_ *VM, a []Value) (Value, error) { return parseIntStrict(a[0], a[1].num), nil },
		"parseFloat": func(_ *VM, a []Value) (Value, error) {
			if a[0].kind == kindNumber {
				return a[0], nil
			}
			s := strings.TrimSpace(a[0].str)
			if !floatLiteralRe.MatchString(s) {
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
		"clock":  func(_ *VM, _ []Value) (Value, error) { return Number(float64(time.Now().UnixMilli())), nil },
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
		"arrayLen": func(_ *VM, a []Value) (Value, error) { return Number(float64(len(a[0].arr))), nil },
		"arrayPush": func(_ *VM, a []Value) (Value, error) {
			out := make([]Value, 0, len(a[0].arr)+len(a)-1)
			out = append(out, a[0].arr...)
			return Array(append(out, a[1:]...)), nil
		},
		"arrayPop": func(_ *VM, a []Value) (Value, error) {
			if len(a[0].arr) == 0 {
				return Nil(), nil
			}
			return a[0].arr[len(a[0].arr)-1], nil
		},
		"arraySlice": func(_ *VM, a []Value) (Value, error) {
			arr := a[0].arr
			start := math.Max(0, math.Trunc(a[1].num))
			end := math.Min(float64(len(arr)), math.Trunc(a[2].num))
			if math.IsNaN(start) || math.IsNaN(end) || start > end {
				return Array([]Value{}), nil
			}
			out := make([]Value, int(end)-int(start))
			copy(out, arr[int(start):int(end)])
			return Array(out), nil
		},
		"arrayConcat": func(_ *VM, a []Value) (Value, error) {
			var out []Value
			for _, v := range a {
				out = append(out, v.arr...)
			}
			if out == nil {
				out = []Value{}
			}
			return Array(out), nil
		},
		"arrayIndexOf": func(_ *VM, a []Value) (Value, error) {
			for i, v := range a[0].arr {
				if valuesEqual(v, a[1]) {
					return Number(float64(i)), nil
				}
			}
			return Number(-1), nil
		},
		"objKeys": func(_ *VM, a []Value) (Value, error) {
			names := sortedKeys(a[0].obj)
			out := make([]Value, len(names))
			for i, k := range names {
				out[i] = String(k)
			}
			return Array(out), nil
		},
		"objValues": func(_ *VM, a []Value) (Value, error) {
			names := sortedKeys(a[0].obj)
			out := make([]Value, len(names))
			for i, k := range names {
				out[i] = a[0].obj[k]
			}
			return Array(out), nil
		},
		"objHas": func(_ *VM, a []Value) (Value, error) {
			_, ok := a[0].obj[a[1].String()]
			return Bool(ok), nil
		},
		"objGet": func(_ *VM, a []Value) (Value, error) {
			if v, ok := a[0].obj[a[1].String()]; ok {
				return v, nil
			}
			return Nil(), nil
		},
		"objSet": func(_ *VM, a []Value) (Value, error) {
			out := make(map[string]Value, len(a[0].obj)+1)
			for k, v := range a[0].obj {
				out[k] = v
			}
			out[a[1].String()] = a[2]
			return Object(out), nil
		},

		// Handlers
		"registerHandler": func(vm *VM, a []Value) (Value, error) {
			fn, ok := vm.findFunctionByName(a[1].str)
			if !ok {
				return Value{}, vm.runtimeError("registerHandler: handler function not found: %s", a[1].str)
			}
			vm.handlers[a[0].str] = fn
			return Nil(), nil
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
		if numberLiteralRe.MatchString(v.str) {
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
