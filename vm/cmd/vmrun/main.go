// vmrun is a CLI tool for running PulsarScript bytecode with debugging options.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/ioutil"
	"os"
	"strings"
	"time"

	pulsarscriptvm "github.com/PulsarDynamics/pulsarscript/vm"
)

var (
	disasm      = flag.Bool("disasm", false, "Print bytecode disassembly and exit")
	step        = flag.Bool("step", false, "Step-by-step execution with prompts")
	inspect     = flag.Bool("inspect", false, "Run to handler registration then list handlers")
	sandboxRoot = flag.String("sandbox-root", "", "Root directory for filesystem operations")
	maxStack    = flag.Int("max-stack", 1024, "Maximum stack depth")
	seed        = flag.Int64("seed", 0, "Random seed for deterministic execution (0 = non-deterministic)")
	maxSteps    = flag.Int("max-steps", pulsarscriptvm.DefaultMaxSteps, "Instruction budget; 0 = unlimited")
	timeout     = flag.Duration("timeout", pulsarscriptvm.DefaultMaxDuration, "Wall-time budget; 0 = unlimited")
)

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: vmrun [options] <bytecode.json>\n\n")
		fmt.Fprintf(os.Stderr, "PulsarScript VM runner with debugging support.\n\n")
		fmt.Fprintf(os.Stderr, "Options:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  vmrun script.json              # Run script\n")
		fmt.Fprintf(os.Stderr, "  vmrun -disasm script.json      # Disassemble bytecode\n")
		fmt.Fprintf(os.Stderr, "  vmrun -inspect script.json     # List registered handlers\n")
		fmt.Fprintf(os.Stderr, "  vmrun -step script.json        # Step through execution\n")
	}
	flag.Parse()

	if flag.NArg() < 1 {
		flag.Usage()
		os.Exit(1)
	}

	filename := flag.Arg(0)
	data, err := ioutil.ReadFile(filename)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading file: %v\n", err)
		os.Exit(1)
	}

	mod, err := pulsarscriptvm.LoadModule(data)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading module: %v\n", err)
		os.Exit(1)
	}

	// Disassembly mode
	if *disasm {
		printDisassembly(mod)
		return
	}

	// Create VM with configuration
	// Budgets are on by default so a runaway script stops instead of hanging (D10);
	// pass -max-steps 0 / -timeout 0 to lift them. VMConfig uses negative for "unlimited".
	unlimitedIfZero := func(n int64) int64 {
		if n == 0 {
			return -1
		}
		return n
	}
	config := pulsarscriptvm.VMConfig{
		MaxStackDepth: *maxStack,
		MaxSteps:      int(unlimitedIfZero(int64(*maxSteps))),
		MaxDuration:   time.Duration(unlimitedIfZero(int64(*timeout))),
	}

	callbacks := pulsarscriptvm.HostCallbacks{
		Print: func(v pulsarscriptvm.Value) {
			fmt.Printf("[print] %s\n", v.String())
		},
		HostCall: createHostCallHandler(*sandboxRoot),
	}

	vm := pulsarscriptvm.NewVMWithConfig(mod, callbacks, config)

	if *seed != 0 {
		vm.SetSeed(*seed)
	}

	// Inspect mode - run to completion and show handlers
	if *inspect {
		if err := vm.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		handlers := vm.ListHandlers()
		fmt.Printf("\nRegistered handlers (%d):\n", len(handlers))
		for _, h := range handlers {
			fmt.Printf("  - %s (address: %d, arity: %d)\n", h.Name, h.Address, h.Arity)
		}
		return
	}

	// Step mode
	if *step {
		runStepMode(vm, mod)
		return
	}

	// Normal execution
	if err := vm.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Execution completed successfully.")
}

// printDisassembly outputs human-readable bytecode
func printDisassembly(mod pulsarscriptvm.Module) {
	fmt.Printf("=== Bytecode Disassembly ===\n")
	if mod.Version > 0 {
		fmt.Printf("Format: version %d, %s, source %s\n", mod.Version, mod.Compiler, mod.SourceHash)
	} else {
		fmt.Printf("Format: version 0 (no header)\n")
	}
	fmt.Printf("Constants: %d\n", len(mod.Constants))
	for i, c := range mod.Constants {
		fmt.Printf("  [%d] %v\n", i, c.String())
	}

	fmt.Printf("\nFunctions: %d\n", len(mod.Functions))
	for addr, fn := range mod.Functions {
		fmt.Printf("  %s @ %d (arity: %d, locals: %d)\n", fn.Name, addr, fn.Arity, fn.Locals)
	}

	fmt.Printf("\nCode: %d bytes\n", len(mod.Code))
	ip := 0
	for ip < len(mod.Code) {
		lineInfo := ""
		if ip < len(mod.LineMap) && mod.LineMap[ip] > 0 {
			lineInfo = fmt.Sprintf(" ; line %d", mod.LineMap[ip])
		}

		op := byte(mod.Code[ip])
		name, operands := opcodeName(op)
		if operands == 0 {
			fmt.Printf("  %04d: %s%s\n", ip, name, lineInfo)
			ip++
		} else if operands == 1 {
			if ip+1 < len(mod.Code) {
				fmt.Printf("  %04d: %s %d%s\n", ip, name, mod.Code[ip+1], lineInfo)
			} else {
				fmt.Printf("  %04d: %s ???%s\n", ip, name, lineInfo)
			}
			ip += 2
		} else {
			// 2 operands
			if ip+2 < len(mod.Code) {
				fmt.Printf("  %04d: %s %d %d%s\n", ip, name, mod.Code[ip+1], mod.Code[ip+2], lineInfo)
			} else {
				fmt.Printf("  %04d: %s ???%s\n", ip, name, lineInfo)
			}
			ip += 3
		}
	}
}

// opcodeName returns the name and operand count for an opcode, from the VM's own table so the
// listing always decodes operands the way the VM does (D9).
func opcodeName(op byte) (string, int) {
	name, operands, _ := pulsarscriptvm.OpcodeName(op)
	return name, operands
}

// runStepMode executes the VM one step at a time with user prompts
func runStepMode(vm *pulsarscriptvm.VM, mod pulsarscriptvm.Module) {
	fmt.Println("Step mode: Press Enter to execute next instruction, 'q' to quit, 's' for stack")

	for {
		ip := vm.IP()
		if ip >= len(mod.Code) {
			fmt.Println("End of code reached")
			break
		}

		op := byte(mod.Code[ip])
		name, _ := opcodeName(op)
		line := vm.CurrentLine()
		lineInfo := ""
		if line > 0 {
			lineInfo = fmt.Sprintf(" (line %d)", line)
		}

		fmt.Printf("[%04d] %s%s > ", ip, name, lineInfo)

		var input string
		fmt.Scanln(&input)
		input = strings.TrimSpace(input)

		switch input {
		case "q":
			fmt.Println("Quit")
			return
		case "s":
			fmt.Printf("Stack depth: %d\n", vm.StackDepth())
			continue
		}

		err := vm.Step()
		if err != nil {
			if err.Error() == "yielded" {
				fmt.Println("VM yielded")
				continue
			}
			fmt.Printf("Error: %v\n", err)
			return
		}

		if vm.Halted() {
			fmt.Println("VM halted")
			break
		}
	}
}

// createHostCallHandler creates a basic host call handler
func createHostCallHandler(sandboxRoot string) func(string, []pulsarscriptvm.Value) (pulsarscriptvm.Value, error) {
	return func(name string, args []pulsarscriptvm.Value) (pulsarscriptvm.Value, error) {
		switch name {
		// typeOf, string, concat, number, abs and clamp are implemented by the VM itself.
		case "fsRead":
			if sandboxRoot == "" || len(args) == 0 {
				return pulsarscriptvm.Nil(), nil
			}
			path := sandboxRoot + "/" + args[0].String()
			data, err := ioutil.ReadFile(path)
			if err != nil {
				return pulsarscriptvm.Nil(), nil
			}
			return pulsarscriptvm.String(string(data)), nil
		case "fsWrite":
			if sandboxRoot == "" || len(args) < 2 {
				return pulsarscriptvm.Bool(false), nil
			}
			path := sandboxRoot + "/" + args[0].String()
			err := ioutil.WriteFile(path, []byte(args[1].String()), 0644)
			return pulsarscriptvm.Bool(err == nil), nil
		case "fsList":
			if sandboxRoot == "" || len(args) == 0 {
				return pulsarscriptvm.Array(nil), nil
			}
			path := sandboxRoot + "/" + args[0].String()
			files, err := ioutil.ReadDir(path)
			if err != nil {
				return pulsarscriptvm.Array(nil), nil
			}
			items := make([]pulsarscriptvm.Value, len(files))
			for i, f := range files {
				items[i] = pulsarscriptvm.String(f.Name())
			}
			return pulsarscriptvm.Array(items), nil
		case "fsExists":
			if sandboxRoot == "" || len(args) == 0 {
				return pulsarscriptvm.Bool(false), nil
			}
			path := sandboxRoot + "/" + args[0].String()
			_, err := os.Stat(path)
			return pulsarscriptvm.Bool(err == nil), nil
		default:
			// Other "host" registry entries (kv*, ipc*, events, fsStat, fsDelete) have no
			// implementation in vmrun; they return nil.
			return pulsarscriptvm.Nil(), nil
		}
	}
}

// jsonString converts a value to JSON for debugging
func jsonString(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}
