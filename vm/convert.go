package vm

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
)

// ToInterface converts a value to plain Go data that encoding/json can marshal: nil, bool,
// float64, string, []interface{} and map[string]interface{}. Hosts use it to return script
// results over IPC (D11). NaN and ±Infinity have no JSON form and become nil.
func ToInterface(v Value) interface{} {
	switch v.kind {
	case kindBool:
		return v.b
	case kindNumber:
		if math.IsNaN(v.num) || math.IsInf(v.num, 0) {
			return nil
		}
		return v.num
	case kindString:
		return v.str
	case kindArray:
		n := v.arrayLen()
		out := make([]interface{}, n)
		for i := 0; i < n; i++ {
			out[i] = ToInterface(v.arrayAt(i))
		}
		return out
	case kindObject:
		keys := v.objectKeys()
		out := make(map[string]interface{}, len(keys))
		for _, k := range keys {
			val, _ := v.objectGet(k)
			out[k] = ToInterface(val)
		}
		return out
	default:
		return nil
	}
}

// maxConvertDepth bounds nesting when converting host data, so a hostile payload cannot
// exhaust the stack.
const maxConvertDepth = 64

// FromInterface converts decoded JSON (or similar plain Go data) to a value.
func FromInterface(x interface{}) (Value, error) {
	return fromInterface(x, 0)
}

func fromInterface(x interface{}, depth int) (Value, error) {
	if depth > maxConvertDepth {
		return Value{}, fmt.Errorf("value nested deeper than %d levels", maxConvertDepth)
	}
	switch v := x.(type) {
	case nil:
		return Nil(), nil
	case bool:
		return Bool(v), nil
	case float64:
		return Number(v), nil
	case float32:
		return Number(float64(v)), nil
	case int:
		return Number(float64(v)), nil
	case int64:
		return Number(float64(v)), nil
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return Value{}, err
		}
		return Number(f), nil
	case string:
		return String(v), nil
	case []interface{}:
		out := make([]Value, len(v))
		for i, e := range v {
			ev, err := fromInterface(e, depth+1)
			if err != nil {
				return Value{}, err
			}
			out[i] = ev
		}
		return Array(out), nil
	case map[string]interface{}:
		out := make(map[string]Value, len(v))
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			ev, err := fromInterface(v[k], depth+1)
			if err != nil {
				return Value{}, err
			}
			out[k] = ev
		}
		return Object(out), nil
	default:
		// Anything else (structs, typed slices) goes through JSON once.
		b, err := json.Marshal(v)
		if err != nil {
			return Value{}, fmt.Errorf("unsupported host value %T", x)
		}
		var decoded interface{}
		if err := json.Unmarshal(b, &decoded); err != nil {
			return Value{}, err
		}
		return fromInterface(decoded, depth)
	}
}
