package vm

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

// D19: exceptions and `return` must unwind call frames and handlers correctly.
// The testdata chunks are compiled from the matching pulsarscript sources (see each test).

func runFixture(t *testing.T, name string) ([]string, error) {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	mod, err := LoadModule(data)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	vm := NewVM(mod, HostCallbacks{Print: func(v Value) { out = append(out, v.String()) }})
	return out, vm.Run()
}

// function boom() { var z = 1 / 0; return z; }
// function outer() { var a = 7; try { boom(); } catch (e) { print("caught in outer"); } return a; }
// print(outer()); print("done");
func TestErrorInNestedCallUnwindsToHandler(t *testing.T) {
	out, err := runFixture(t, "d19_deep.json")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if want := []string{"caught in outer", "7", "done"}; !reflect.DeepEqual(out, want) {
		t.Errorf("got %q, want %q", out, want)
	}
}

// function h() { try { return 1; } catch (e) { print("stale handler caught it"); } }
// h(); print("before"); var x = 1 / 0; print("after");
func TestReturnInsideTryDropsHandler(t *testing.T) {
	out, err := runFixture(t, "d19_stale.json")
	if err == nil || !strings.Contains(err.Error(), "division by zero") {
		t.Fatalf("want uncaught division by zero, got %v", err)
	}
	if want := []string{"before"}; !reflect.DeepEqual(out, want) {
		t.Errorf("got %q, want %q", out, want)
	}
}

// function f() { try { return 1; } catch (e) { return 2; } } print(f());
// function g() { try { return 10; } catch (e) { } } print(g());
// try { var z = 1 / 0; } catch (e) { print("caught"); }
func TestReturnInsideTryReturnsValue(t *testing.T) {
	out, err := runFixture(t, "d19_tryret.json")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if want := []string{"1", "10", "caught"}; !reflect.DeepEqual(out, want) {
		t.Errorf("got %q, want %q", out, want)
	}
}
