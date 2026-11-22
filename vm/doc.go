// Package vm is the PulsarScript bytecode virtual machine: the production runtime for
// PulsarScript (SPEC.md). It loads the JSON bytecode written by compile.ts, verifies it,
// and runs it with step, time, stack and call-depth limits.
//
// Hosts (such as the PulsarOS API) import it as a versioned Go module:
//
//	import pulsarscriptvm "github.com/PulsarDynamics/pulsarscript/vm"
//
// The compiler, this VM, the spec, the host-call registry (hostapi.json) and the
// conformance suite live in one repository and are released together (decision A7).
// Releases are tagged vm/vX.Y.Z.
package vm
