package vm

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Breakpoint represents a source-level breakpoint. An empty File matches any file at Line.
type Breakpoint struct {
	File string `json:"file,omitempty"`
	Line int    `json:"line"`
}

func (b Breakpoint) AppendJSON(dst []byte) []byte {
	dst = append(dst, '{')
	if b.File != "" {
		dst = append(dst, `"file":`...)
		dst = AppendJSONString(dst, b.File)
		dst = append(dst, ',')
	}
	dst = append(dst, `"line":`...)
	dst = strconv.AppendInt(dst, int64(b.Line), 10)
	return append(dst, '}')
}

// DebugVar is a JSON-serializable variable binding for debugger inspection (DX-05).
type DebugVar struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

func (v DebugVar) AppendJSON(dst []byte) []byte {
	dst = append(dst, `{"name":`...)
	dst = AppendJSONString(dst, v.Name)
	dst = append(dst, `,"type":`...)
	dst = AppendJSONString(dst, v.Type)
	dst = append(dst, `,"value":`...)
	dst = AppendJSONString(dst, v.Value)
	return append(dst, '}')
}

// DebugFrame describes one active call frame on the VM call stack.
type DebugFrame struct {
	Index       int              `json:"index"`
	Name        string           `json:"name"`
	File        string           `json:"file,omitempty"`
	Line        int              `json:"line"`
	IP          int              `json:"ip"`
	Locals      []DebugVar       `json:"locals"`
	Upvalues    []DebugVar       `json:"upvalues,omitempty"`
	LocalValues map[string]Value `json:"-"`
}

func (f DebugFrame) AppendJSON(dst []byte) []byte {
	dst = append(dst, `{"index":`...)
	dst = strconv.AppendInt(dst, int64(f.Index), 10)
	dst = append(dst, `,"name":`...)
	dst = AppendJSONString(dst, f.Name)
	if f.File != "" {
		dst = append(dst, `,"file":`...)
		dst = AppendJSONString(dst, f.File)
	}
	dst = append(dst, `,"line":`...)
	dst = strconv.AppendInt(dst, int64(f.Line), 10)
	dst = append(dst, `,"ip":`...)
	dst = strconv.AppendInt(dst, int64(f.IP), 10)
	dst = append(dst, `,"locals":`...)
	dst = AppendJSONSlice(dst, f.Locals)
	if len(f.Upvalues) > 0 {
		dst = append(dst, `,"upvalues":`...)
		dst = AppendJSONSlice(dst, f.Upvalues)
	}
	return append(dst, '}')
}

// DebugSnapshot captures the complete debugger state when paused or halted (DX-05).
type DebugSnapshot struct {
	Reason         string           `json:"reason"`
	IP             int              `json:"ip"`
	Line           int              `json:"line"`
	File           string           `json:"file,omitempty"`
	Opcode         string           `json:"opcode,omitempty"`
	Steps          int              `json:"steps"`
	MaxSteps       int              `json:"maxSteps"`
	ElapsedMs      float64          `json:"elapsedMs"`
	MaxDurationMs  float64          `json:"maxDurationMs"`
	MemBytes       int64            `json:"memBytes"`
	MaxMemoryBytes int64            `json:"maxMemoryBytes"`
	HeapObjects    int              `json:"heapObjects"`
	Halted         bool             `json:"halted"`
	Yielded        bool             `json:"yielded,omitempty"`
	Suspended      bool             `json:"suspended,omitempty"`
	Error          string           `json:"error,omitempty"`
	StackDepth     int              `json:"stackDepth"`
	Frames         []DebugFrame     `json:"frames"`
	Globals        []DebugVar       `json:"globals"`
	GlobalValues   map[string]Value `json:"-"`
}

func (s DebugSnapshot) AppendJSON(dst []byte) []byte {
	dst = append(dst, `{"reason":`...)
	dst = AppendJSONString(dst, s.Reason)
	dst = append(dst, `,"ip":`...)
	dst = strconv.AppendInt(dst, int64(s.IP), 10)
	dst = append(dst, `,"line":`...)
	dst = strconv.AppendInt(dst, int64(s.Line), 10)
	if s.File != "" {
		dst = append(dst, `,"file":`...)
		dst = AppendJSONString(dst, s.File)
	}
	if s.Opcode != "" {
		dst = append(dst, `,"opcode":`...)
		dst = AppendJSONString(dst, s.Opcode)
	}
	dst = append(dst, `,"steps":`...)
	dst = strconv.AppendInt(dst, int64(s.Steps), 10)
	dst = append(dst, `,"maxSteps":`...)
	dst = strconv.AppendInt(dst, int64(s.MaxSteps), 10)
	dst = append(dst, `,"elapsedMs":`...)
	dst = AppendJSONAny(dst, s.ElapsedMs)
	dst = append(dst, `,"maxDurationMs":`...)
	dst = AppendJSONAny(dst, s.MaxDurationMs)
	dst = append(dst, `,"memBytes":`...)
	dst = strconv.AppendInt(dst, s.MemBytes, 10)
	dst = append(dst, `,"maxMemoryBytes":`...)
	dst = strconv.AppendInt(dst, s.MaxMemoryBytes, 10)
	dst = append(dst, `,"heapObjects":`...)
	dst = strconv.AppendInt(dst, int64(s.HeapObjects), 10)
	dst = append(dst, `,"halted":`...)
	dst = AppendJSONAny(dst, s.Halted)
	if s.Yielded {
		dst = append(dst, `,"yielded":true`...)
	}
	if s.Suspended {
		dst = append(dst, `,"suspended":true`...)
	}
	if s.Error != "" {
		dst = append(dst, `,"error":`...)
		dst = AppendJSONString(dst, s.Error)
	}
	dst = append(dst, `,"stackDepth":`...)
	dst = strconv.AppendInt(dst, int64(s.StackDepth), 10)
	dst = append(dst, `,"frames":`...)
	dst = AppendJSONSlice(dst, s.Frames)
	dst = append(dst, `,"globals":`...)
	dst = AppendJSONSlice(dst, s.Globals)
	return append(dst, '}')
}

// Debugger wraps a VM with line-map breakpoints, step in/over/out, local inspection,
// and paused wall-time budgets while stopped at a breakpoint (DX-05).
type Debugger struct {
	vm                  *VM
	breakpoints         []Breakpoint
	steps               int
	elapsed             time.Duration
	maxSteps            int
	maxDuration         time.Duration
	stoppedAtBreakpoint bool
	lastErr             error
}

// NewDebugger attaches a source debugger to vm using the VM's configured budgets.
func NewDebugger(vm *VM) *Debugger {
	maxSteps, maxDur, _, _ := vm.BudgetConfig()
	return &Debugger{
		vm:          vm,
		maxSteps:    maxSteps,
		maxDuration: maxDur,
	}
}

// AddBreakpoint registers a breakpoint at (file, line). Empty file matches any source file.
func (d *Debugger) AddBreakpoint(file string, line int) {
	if line <= 0 {
		return
	}
	for _, bp := range d.breakpoints {
		if bp.Line == line && bp.File == file {
			return
		}
	}
	d.breakpoints = append(d.breakpoints, Breakpoint{File: file, Line: line})
}

// RemoveBreakpoint removes a matching breakpoint.
func (d *Debugger) RemoveBreakpoint(file string, line int) bool {
	for i, bp := range d.breakpoints {
		if bp.Line == line && (file == "" || bp.File == file) {
			d.breakpoints = append(d.breakpoints[:i], d.breakpoints[i+1:]...)
			return true
		}
	}
	return false
}

// ClearBreakpoints removes all breakpoints.
func (d *Debugger) ClearBreakpoints() {
	d.breakpoints = d.breakpoints[:0]
}

// Breakpoints returns a sorted copy of registered breakpoints.
func (d *Debugger) Breakpoints() []Breakpoint {
	out := make([]Breakpoint, len(d.breakpoints))
	copy(out, d.breakpoints)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Line != out[j].Line {
			return out[i].Line < out[j].Line
		}
		return out[i].File < out[j].File
	})
	return out
}

// VM returns the underlying VM instance.
func (d *Debugger) VM() *VM { return d.vm }

// ResetBudgets resets accumulated step and active elapsed wall-time counters.
func (d *Debugger) ResetBudgets() {
	d.steps = 0
	d.elapsed = 0
	d.lastErr = nil
	d.stoppedAtBreakpoint = false
}

func (d *Debugger) matchesBreakpoint(file string, line int) bool {
	if line <= 0 || len(d.breakpoints) == 0 {
		return false
	}
	for _, bp := range d.breakpoints {
		if bp.Line != line {
			continue
		}
		if bp.File == "" || bp.File == file || strings.HasSuffix(file, "/"+bp.File) || strings.HasSuffix(bp.File, "/"+file) {
			return true
		}
	}
	return false
}

func (d *Debugger) stepOne(burstStart time.Time) (bool, error) {
	if d.maxSteps > 0 && d.steps >= d.maxSteps {
		return false, ErrStepBudgetExceeded
	}
	if d.maxDuration > 0 && d.steps&63 == 0 {
		if d.elapsed+time.Since(burstStart) >= d.maxDuration {
			return false, ErrTimeBudgetExceeded
		}
	}
	if err := d.vm.Step(); err != nil {
		if isUncatchable(err) {
			return false, err
		}
		if d.vm.handleException(err) {
			d.steps++
			d.vm.activeSteps = d.steps
			return true, nil
		}
		return false, err
	}
	d.steps++
	d.vm.activeSteps = d.steps
	return false, nil
}

func (d *Debugger) beginBurst() time.Time {
	d.lastErr = nil
	now := time.Now()
	d.vm.budgetActive = true
	d.vm.activeSteps = d.steps
	d.vm.activeMaxStp = d.maxSteps
	d.vm.activeStart = now.Add(-d.elapsed)
	d.vm.activeMaxDur = d.maxDuration
	return now
}

func (d *Debugger) endBurst(burstStart time.Time) {
	d.elapsed += time.Since(burstStart)
	d.vm.budgetActive = false
}

// Continue resumes execution until halt, error, yield, suspend, or a breakpoint.
func (d *Debugger) Continue() DebugSnapshot {
	if d.vm.halted {
		return d.Snapshot("halted")
	}
	burstStart := d.beginBurst()
	defer d.endBurst(burstStart)

	startLine := d.vm.LineAtIP(d.vm.ip)
	startFile := d.vm.FileAtIP(d.vm.ip)
	startDepth := len(d.vm.frames)
	skipStart := d.stoppedAtBreakpoint

	for !d.vm.halted && d.vm.ip < len(d.vm.module.Code) {
		curLine := d.vm.LineAtIP(d.vm.ip)
		curFile := d.vm.FileAtIP(d.vm.ip)
		curDepth := len(d.vm.frames)
		if skipStart && (curDepth < startDepth || (curDepth == startDepth && (curLine != startLine || curFile != startFile))) {
			skipStart = false
		}
		isSameStartBp := skipStart && curDepth == startDepth && curLine == startLine && curFile == startFile
		if !isSameStartBp && d.matchesBreakpoint(curFile, curLine) {
			d.stoppedAtBreakpoint = true
			return d.Snapshot("breakpoint")
		}
		prevIP := d.vm.ip
		if _, err := d.stepOne(burstStart); err != nil {
			d.stoppedAtBreakpoint = false
			d.lastErr = err
			return d.Snapshot(reasonForErr(err))
		}
		if skipStart && len(d.vm.frames) == startDepth && d.vm.ip < prevIP {
			skipStart = false
		}
	}
	d.stoppedAtBreakpoint = false
	d.vm.halted = true
	return d.Snapshot("halted")
}

// StepInstruction executes a single bytecode instruction.
func (d *Debugger) StepInstruction() DebugSnapshot {
	if d.vm.halted {
		return d.Snapshot("halted")
	}
	burstStart := d.beginBurst()
	defer d.endBurst(burstStart)

	if _, err := d.stepOne(burstStart); err != nil {
		d.stoppedAtBreakpoint = false
		d.lastErr = err
		return d.Snapshot(reasonForErr(err))
	}
	if d.vm.halted || d.vm.ip >= len(d.vm.module.Code) {
		d.vm.halted = true
		d.stoppedAtBreakpoint = false
		return d.Snapshot("halted")
	}
	d.stoppedAtBreakpoint = d.matchesBreakpoint(d.vm.FileAtIP(d.vm.ip), d.vm.LineAtIP(d.vm.ip))
	return d.Snapshot("step")
}

// StepIn advances execution until entering the next source line or a called function.
func (d *Debugger) StepIn() DebugSnapshot {
	return d.stepLine(true)
}

// StepOver advances execution until the next source line in the current or caller frame,
// stepping over callees unless a breakpoint inside a callee triggers.
func (d *Debugger) StepOver() DebugSnapshot {
	return d.stepLine(false)
}

// StepOut advances execution until returning from the current call frame (or hitting a breakpoint).
func (d *Debugger) StepOut() DebugSnapshot {
	if d.vm.halted {
		return d.Snapshot("halted")
	}
	startDepth := len(d.vm.frames)
	if startDepth == 0 {
		return d.Continue()
	}
	burstStart := d.beginBurst()
	defer d.endBurst(burstStart)

	startLine := d.vm.LineAtIP(d.vm.ip)
	startFile := d.vm.FileAtIP(d.vm.ip)
	skipStart := d.stoppedAtBreakpoint

	for !d.vm.halted && d.vm.ip < len(d.vm.module.Code) {
		prevIP := d.vm.ip
		if _, err := d.stepOne(burstStart); err != nil {
			d.stoppedAtBreakpoint = false
			d.lastErr = err
			return d.Snapshot(reasonForErr(err))
		}
		if d.vm.halted || d.vm.ip >= len(d.vm.module.Code) {
			break
		}
		curLine := d.vm.LineAtIP(d.vm.ip)
		curFile := d.vm.FileAtIP(d.vm.ip)
		curDepth := len(d.vm.frames)
		if skipStart && (curDepth < startDepth || (curDepth == startDepth && ((curLine != startLine || curFile != startFile) || d.vm.ip < prevIP))) {
			skipStart = false
		}
		isSameStartBp := skipStart && curDepth == startDepth && curLine == startLine && curFile == startFile
		if !isSameStartBp && d.matchesBreakpoint(curFile, curLine) {
			d.stoppedAtBreakpoint = true
			return d.Snapshot("breakpoint")
		}
		if curDepth < startDepth && curLine > 0 {
			d.stoppedAtBreakpoint = false
			return d.Snapshot("step")
		}
	}
	d.vm.halted = true
	d.stoppedAtBreakpoint = false
	return d.Snapshot("halted")
}

func (d *Debugger) stepLine(stepInto bool) DebugSnapshot {
	if d.vm.halted {
		return d.Snapshot("halted")
	}
	burstStart := d.beginBurst()
	defer d.endBurst(burstStart)

	startLine := d.vm.LineAtIP(d.vm.ip)
	startFile := d.vm.FileAtIP(d.vm.ip)
	startDepth := len(d.vm.frames)
	skipStart := d.stoppedAtBreakpoint

	for !d.vm.halted && d.vm.ip < len(d.vm.module.Code) {
		prevIP := d.vm.ip
		if _, err := d.stepOne(burstStart); err != nil {
			d.stoppedAtBreakpoint = false
			d.lastErr = err
			return d.Snapshot(reasonForErr(err))
		}
		if d.vm.halted || d.vm.ip >= len(d.vm.module.Code) {
			break
		}
		curLine := d.vm.LineAtIP(d.vm.ip)
		curFile := d.vm.FileAtIP(d.vm.ip)
		curDepth := len(d.vm.frames)
		if skipStart && (curDepth < startDepth || (curDepth == startDepth && ((curLine != startLine || curFile != startFile) || d.vm.ip < prevIP))) {
			skipStart = false
		}
		isSameStartBp := skipStart && curDepth == startDepth && curLine == startLine && curFile == startFile
		if !isSameStartBp && d.matchesBreakpoint(curFile, curLine) {
			d.stoppedAtBreakpoint = true
			return d.Snapshot("breakpoint")
		}
		if curLine <= 0 {
			continue
		}
		if stepInto {
			if curLine != startLine || curFile != startFile || curDepth != startDepth {
				d.stoppedAtBreakpoint = false
				return d.Snapshot("step")
			}
		} else {
			if curDepth < startDepth || (curDepth == startDepth && (curLine != startLine || curFile != startFile)) {
				d.stoppedAtBreakpoint = false
				return d.Snapshot("step")
			}
		}
	}
	d.vm.halted = true
	d.stoppedAtBreakpoint = false
	return d.Snapshot("halted")
}

func reasonForErr(err error) string {
	switch {
	case errors.Is(err, ErrYielded):
		return "yielded"
	case errors.Is(err, ErrSuspended):
		return "suspended"
	case errors.Is(err, ErrStepBudgetExceeded), errors.Is(err, ErrTimeBudgetExceeded):
		return "budget"
	case errors.Is(err, ErrMemoryLimit):
		return "memory"
	default:
		return "error"
	}
}

// Snapshot inspects the current VM instruction pointer, call stack, locals, upvalues,
// globals, and paused budget/memory meters without advancing execution.
func (d *Debugger) Snapshot(reason string) DebugSnapshot {
	vm := d.vm
	line := vm.LineAtIP(vm.ip)
	file := vm.FileAtIP(vm.ip)
	opName := ""
	if vm.ip >= 0 && vm.ip < len(vm.module.Code) {
		opName, _, _ = OpcodeName(byte(vm.module.Code[vm.ip]))
	}
	memBytes, heapObjs := vm.LiveMemory()
	maxSteps, maxDur, maxMem, _ := vm.BudgetConfig()

	frames := make([]DebugFrame, 0, len(vm.frames)+1)
	for i := len(vm.frames) - 1; i >= 0; i-- {
		fr := vm.frames[i]
		frameIP := vm.ip
		frameLine := line
		frameFile := file
		if i < len(vm.frames)-1 {
			callerNext := vm.frames[i+1]
			frameIP = callerNext.returnIP
			frameLine = callerNext.callLine
			frameFile = callerNext.callFile
		}
		var fnInfo FunctionInfo
		var hasInfo bool
		if fr.cl != nil {
			fnInfo = fr.cl.fn
			hasInfo = true
		} else if info, ok := vm.module.Functions[fr.fnAddr]; ok {
			fnInfo = info
			hasInfo = true
		}

		locals := make([]DebugVar, 0, fr.locals)
		localMap := make(map[string]Value, fr.locals)
		for slot := 0; slot < fr.locals && fr.base+slot < len(vm.stack); slot++ {
			name := fmt.Sprintf("local_%d", slot)
			if hasInfo && slot < len(fnInfo.LocalNames) && fnInfo.LocalNames[slot] != "" {
				name = fnInfo.LocalNames[slot]
			}
			val := vm.stack[fr.base+slot]
			locals = append(locals, DebugVar{
				Name:  name,
				Type:  typeName(val),
				Value: val.String(),
			})
			localMap[name] = val
		}

		var upvals []DebugVar
		if fr.cl != nil {
			for uIdx, uv := range fr.cl.upvalues {
				var val Value
				if uv.location >= 0 && uv.location < len(vm.stack) {
					val = vm.stack[uv.location]
				} else {
					val = uv.closed
				}
				upvals = append(upvals, DebugVar{
					Name:  fmt.Sprintf("upvalue_%d", uIdx),
					Type:  typeName(val),
					Value: val.String(),
				})
			}
		}

		frames = append(frames, DebugFrame{
			Index:       len(frames),
			Name:        displayFuncName(fr.name),
			File:        frameFile,
			Line:        frameLine,
			IP:          frameIP,
			Locals:      locals,
			Upvalues:    upvals,
			LocalValues: localMap,
		})
	}

	// Root <script> frame
	scriptLine := line
	scriptFile := file
	scriptIP := vm.ip
	if len(vm.frames) > 0 {
		scriptIP = vm.frames[0].returnIP
		scriptLine = vm.frames[0].callLine
		scriptFile = vm.frames[0].callFile
	}
	rootLocals := make([]DebugVar, 0, vm.rootLocals)
	rootLocalMap := make(map[string]Value, vm.rootLocals)
	for slot := 0; slot < vm.rootLocals && slot < len(vm.stack); slot++ {
		val := vm.stack[slot]
		name := fmt.Sprintf("local_%d", slot)
		rootLocals = append(rootLocals, DebugVar{Name: name, Type: typeName(val), Value: val.String()})
		rootLocalMap[name] = val
	}
	frames = append(frames, DebugFrame{
		Index:       len(frames),
		Name:        "<script>",
		File:        scriptFile,
		Line:        scriptLine,
		IP:          scriptIP,
		Locals:      rootLocals,
		LocalValues: rootLocalMap,
	})

	globalVals := vm.GlobalsSnapshot()
	gNames := make([]string, 0, len(globalVals))
	for k := range globalVals {
		gNames = append(gNames, k)
	}
	sort.Strings(gNames)
	globals := make([]DebugVar, 0, len(gNames))
	for _, k := range gNames {
		v := globalVals[k]
		globals = append(globals, DebugVar{Name: k, Type: typeName(v), Value: v.String()})
	}

	errStr := ""
	if d.lastErr != nil {
		errStr = d.lastErr.Error()
	}

	return DebugSnapshot{
		Reason:         reason,
		IP:             vm.ip,
		Line:           line,
		File:           file,
		Opcode:         opName,
		Steps:          d.steps,
		MaxSteps:       maxSteps,
		ElapsedMs:      float64(d.elapsed.Microseconds()) / 1000.0,
		MaxDurationMs:  float64(maxDur.Microseconds()) / 1000.0,
		MemBytes:       memBytes,
		MaxMemoryBytes: maxMem,
		HeapObjects:    heapObjs,
		Halted:         vm.halted,
		Yielded:        vm.yielded,
		Suspended:      vm.suspended,
		Error:          errStr,
		StackDepth:     vm.StackDepth(),
		Frames:         frames,
		Globals:        globals,
		GlobalValues:   globalVals,
	}
}
