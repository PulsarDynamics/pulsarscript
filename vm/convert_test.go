package vm

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestJSONRoundTrip(t *testing.T) {
	src := `{"path":"/Docs","n":3,"ok":true,"tags":["a",null,{"x":1.5}]}`
	var decoded interface{}
	if err := json.Unmarshal([]byte(src), &decoded); err != nil {
		t.Fatal(err)
	}
	v, err := FromInterface(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := v.String(), `{n: 3, ok: true, path: "/Docs", tags: ["a", nil, {x: 1.5}]}`; got != want {
		t.Errorf("value = %s, want %s", got, want)
	}
	back, _ := json.Marshal(ToInterface(v))
	if string(back) != `{"n":3,"ok":true,"path":"/Docs","tags":["a",null,{"x":1.5}]}` {
		t.Errorf("json = %s", back)
	}
}

func TestToInterfaceNonFinite(t *testing.T) {
	if ToInterface(Number(math.Inf(1))) != nil || ToInterface(Number(math.NaN())) != nil {
		t.Error("non-finite numbers must become nil")
	}
}

func TestFromInterfaceDepthLimit(t *testing.T) {
	var x interface{} = "leaf"
	for i := 0; i < 100; i++ {
		x = []interface{}{x}
	}
	if _, err := FromInterface(x); err == nil || !strings.Contains(err.Error(), "nested deeper") {
		t.Fatalf("want depth error, got %v", err)
	}
}

func TestFromInterfaceStructs(t *testing.T) {
	type net struct {
		SSID   string `json:"ssid"`
		Signal int    `json:"signal"`
	}
	v, err := FromInterface([]net{{"pulsar", 72}})
	if err != nil {
		t.Fatal(err)
	}
	if got := v.String(); got != `[{signal: 72, ssid: "pulsar"}]` {
		t.Errorf("got %s", got)
	}
}
