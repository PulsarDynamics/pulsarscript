//go:build js && wasm

package vm

import "fmt"

func fromInterfaceFallback(x interface{}, depth int) (Value, error) {
	switch v := x.(type) {
	case float32:
		return Number(float64(v)), nil
	case uint:
		return Number(float64(v)), nil
	case uint64:
		return Number(float64(v)), nil
	case []string:
		out := make([]Value, len(v))
		for i, s := range v {
			out[i] = String(s)
		}
		return Array(out), nil
	case []float64:
		out := make([]Value, len(v))
		for i, n := range v {
			out[i] = Number(n)
		}
		return Array(out), nil
	case []int:
		out := make([]Value, len(v))
		for i, n := range v {
			out[i] = Number(float64(n))
		}
		return Array(out), nil
	case map[string]string:
		out := make(map[string]Value, len(v))
		for k, s := range v {
			out[k] = String(s)
		}
		return Object(out), nil
	case map[string]bool:
		out := make(map[string]Value, len(v))
		for k, b := range v {
			out[k] = Bool(b)
		}
		return Object(out), nil
	default:
		_ = depth
		return Value{}, fmt.Errorf("unsupported host value %T", x)
	}
}
