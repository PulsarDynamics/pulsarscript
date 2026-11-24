//go:build !(js && wasm)

package vm

import (
	"encoding/json"
	"fmt"
)

func fromInterfaceFallback(x interface{}, depth int) (Value, error) {
	if n, ok := x.(json.Number); ok {
		f, err := n.Float64()
		if err != nil {
			return Value{}, err
		}
		return Number(f), nil
	}
	// Anything else (structs, typed slices) goes through JSON once.
	b, err := json.Marshal(x)
	if err != nil {
		return Value{}, fmt.Errorf("unsupported host value %T", x)
	}
	var decoded interface{}
	if err := json.Unmarshal(b, &decoded); err != nil {
		return Value{}, err
	}
	return fromInterface(decoded, depth)
}
