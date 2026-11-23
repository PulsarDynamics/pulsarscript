package vm

// Persistent copy-on-write arrays and objects using Conchon–Filliâtre rerooting (LANG-17, A23).
//
// Invariant: values preserve strict PulsarScript value semantics (D15). Unshared linear
// sequences of writes/appends execute in O(1) amortized time by mutating the current root
// in place and replacing the old node with an inverse diff. Switching back to an older
// snapshot reroots once; any subsequent ping-pong detaches into an independent copy so
// alternating accesses between aliases stay O(1) after the first switch.

type pArrKind uint8

const (
	pArrRoot pArrKind = iota
	pArrSet
	pArrPush
	pArrPop
)

const cowMinChainCap = 64

type pArray struct {
	kind       pArrKind
	idx        int
	val        Value
	elems      []Value
	parent     *pArray
	chainDepth int
	rerooted   bool
	frozen     bool // module-constant slices never mutate in place
}

func newPArray(elems []Value) *pArray {
	if elems == nil {
		elems = []Value{}
	}
	return &pArray{kind: pArrRoot, elems: elems}
}

func (a *pArray) len() int {
	a.ensureRoot()
	return len(a.elems)
}

func (a *pArray) at(i int) Value {
	a.ensureRoot()
	return a.elems[i]
}

// snapshot returns an independent slice copy of a's current elements.
func (a *pArray) snapshot() []Value {
	a.ensureRoot()
	out := make([]Value, len(a.elems))
	copy(out, a.elems)
	return out
}

// set returns a new *pArray with element i set to val (or appended when i == len).
// copied reports whether a full slice clone occurred (for memory accounting).
func (a *pArray) set(i int, val Value) (next *pArray, copied bool) {
	a.ensureRoot()
	capLimit := len(a.elems)
	if capLimit < cowMinChainCap {
		capLimit = cowMinChainCap
	}
	if a.frozen || a.chainDepth >= capLimit {
		newLen := len(a.elems)
		if i == newLen {
			newLen++
		}
		out := make([]Value, len(a.elems), newLen)
		copy(out, a.elems)
		if i == len(out) {
			out = append(out, val)
		} else {
			out[i] = val
		}
		return &pArray{kind: pArrRoot, elems: out}, true
	}

	if i == len(a.elems) {
		newElems := append(a.elems, val)
		next = &pArray{
			kind:       pArrRoot,
			elems:      newElems,
			chainDepth: a.chainDepth + 1,
			rerooted:   a.rerooted,
		}
		a.kind = pArrPop
		a.idx = 0
		a.val = Value{}
		a.elems = nil
		a.parent = next
		a.rerooted = false
		return next, false
	}

	old := a.elems[i]
	a.elems[i] = val
	next = &pArray{
		kind:       pArrRoot,
		elems:      a.elems,
		chainDepth: a.chainDepth + 1,
		rerooted:   a.rerooted,
	}
	a.kind = pArrSet
	a.idx = i
	a.val = old
	a.elems = nil
	a.parent = next
	a.rerooted = false
	return next, false
}

func (a *pArray) pushMany(vals []Value) (*pArray, bool) {
	if len(vals) == 0 {
		return a, false
	}
	cur := a
	anyCopied := false
	for _, v := range vals {
		var copied bool
		cur, copied = cur.set(cur.len(), v)
		if copied {
			anyCopied = true
		}
	}
	return cur, anyCopied
}

func (a *pArray) ensureRoot() {
	if a.kind == pArrRoot {
		return
	}
	var path []*pArray
	cur := a
	for cur.kind != pArrRoot {
		path = append(path, cur)
		cur = cur.parent
	}
	root := cur
	if root.rerooted || len(path) >= maxChainCap(len(root.elems)) {
		// Detach cleanly into an independent root without disturbing root.
		extra := 0
		for i := len(path) - 1; i >= 0; i-- {
			if path[i].kind == pArrPush {
				extra++
			}
		}
		elems := make([]Value, len(root.elems), len(root.elems)+extra)
		copy(elems, root.elems)
		for i := len(path) - 1; i >= 0; i-- {
			m := path[i]
			switch m.kind {
			case pArrSet:
				elems[m.idx] = m.val
			case pArrPop:
				elems[len(elems)-1] = Value{}
				elems = elems[:len(elems)-1]
			case pArrPush:
				elems = append(elems, m.val)
			}
		}
		a.kind = pArrRoot
		a.elems = elems
		a.parent = nil
		a.idx = 0
		a.val = Value{}
		a.chainDepth = 0
		a.rerooted = false
		return
	}

	// Reverse the chain in place so ownership of root.elems moves to a.
	curRoot := root
	for i := len(path) - 1; i >= 0; i-- {
		m := path[i]
		elems := curRoot.elems
		var invKind pArrKind
		var invIdx int
		var invVal Value
		switch m.kind {
		case pArrSet:
			invKind = pArrSet
			invIdx = m.idx
			invVal = elems[m.idx]
			elems[m.idx] = m.val
		case pArrPop:
			invKind = pArrPush
			invVal = elems[len(elems)-1]
			elems[len(elems)-1] = Value{}
			elems = elems[:len(elems)-1]
		case pArrPush:
			invKind = pArrPop
			elems = append(elems, m.val)
		}
		depth := curRoot.chainDepth
		curRoot.kind = invKind
		curRoot.idx = invIdx
		curRoot.val = invVal
		curRoot.elems = nil
		curRoot.parent = m
		curRoot.rerooted = false

		m.kind = pArrRoot
		m.idx = 0
		m.val = Value{}
		m.elems = elems
		m.parent = nil
		m.chainDepth = depth
		curRoot = m
	}
	a.rerooted = true
}

func maxChainCap(length int) int {
	if length < cowMinChainCap {
		return cowMinChainCap
	}
	return length
}

// Persistent copy-on-write objects.
type pObjKind uint8

const (
	pObjRoot pObjKind = iota
	pObjDiff
)

type pObject struct {
	kind       pObjKind
	key        string
	hadOld     bool
	oldVal     Value
	props      map[string]Value
	parent     *pObject
	chainDepth int
	rerooted   bool
	frozen     bool
}

func newPObject(props map[string]Value) *pObject {
	if props == nil {
		props = map[string]Value{}
	}
	return &pObject{kind: pObjRoot, props: props}
}

func (o *pObject) len() int {
	o.ensureRoot()
	return len(o.props)
}

func (o *pObject) get(key string) (Value, bool) {
	o.ensureRoot()
	v, ok := o.props[key]
	return v, ok
}

func (o *pObject) keys() []string {
	o.ensureRoot()
	return sortedKeys(o.props)
}

func (o *pObject) has(key string) bool {
	o.ensureRoot()
	_, ok := o.props[key]
	return ok
}

func (o *pObject) set(key string, val Value) (next *pObject, copied bool) {
	o.ensureRoot()
	oldVal, hadOld := o.props[key]
	if o.frozen || o.chainDepth >= maxChainCap(len(o.props)) {
		nextProps := make(map[string]Value, len(o.props)+1)
		for k, v := range o.props {
			nextProps[k] = v
		}
		nextProps[key] = val
		return &pObject{kind: pObjRoot, props: nextProps}, true
	}
	o.props[key] = val
	next = &pObject{
		kind:       pObjRoot,
		props:      o.props,
		chainDepth: o.chainDepth + 1,
		rerooted:   o.rerooted,
	}
	o.kind = pObjDiff
	o.key = key
	o.hadOld = hadOld
	o.oldVal = oldVal
	o.props = nil
	o.parent = next
	o.rerooted = false
	return next, false
}

func (o *pObject) deleteKey(key string) (next *pObject, deleted bool, copied bool) {
	o.ensureRoot()
	oldVal, hadOld := o.props[key]
	if !hadOld {
		return o, false, false
	}
	if o.frozen || o.chainDepth >= maxChainCap(len(o.props)) {
		nextProps := make(map[string]Value, len(o.props))
		for k, v := range o.props {
			if k != key {
				nextProps[k] = v
			}
		}
		return &pObject{kind: pObjRoot, props: nextProps}, true, true
	}
	delete(o.props, key)
	next = &pObject{
		kind:       pObjRoot,
		props:      o.props,
		chainDepth: o.chainDepth + 1,
		rerooted:   o.rerooted,
	}
	o.kind = pObjDiff
	o.key = key
	o.hadOld = true
	o.oldVal = oldVal
	o.props = nil
	o.parent = next
	o.rerooted = false
	return next, true, false
}

func (o *pObject) ensureRoot() {
	if o.kind == pObjRoot {
		return
	}
	var path []*pObject
	cur := o
	for cur.kind != pObjRoot {
		path = append(path, cur)
		cur = cur.parent
	}
	root := cur
	if root.rerooted || len(path) >= maxChainCap(len(root.props)) {
		props := make(map[string]Value, len(root.props)+len(path))
		for k, v := range root.props {
			props[k] = v
		}
		for i := len(path) - 1; i >= 0; i-- {
			m := path[i]
			if m.hadOld {
				props[m.key] = m.oldVal
			} else {
				delete(props, m.key)
			}
		}
		o.kind = pObjRoot
		o.props = props
		o.parent = nil
		o.key = ""
		o.hadOld = false
		o.oldVal = Value{}
		o.chainDepth = 0
		o.rerooted = false
		return
	}

	curRoot := root
	for i := len(path) - 1; i >= 0; i-- {
		m := path[i]
		props := curRoot.props
		invOldVal, invHadOld := props[m.key]
		if m.hadOld {
			props[m.key] = m.oldVal
		} else {
			delete(props, m.key)
		}
		depth := curRoot.chainDepth
		curRoot.kind = pObjDiff
		curRoot.key = m.key
		curRoot.hadOld = invHadOld
		curRoot.oldVal = invOldVal
		curRoot.props = nil
		curRoot.parent = m
		curRoot.rerooted = false

		m.kind = pObjRoot
		m.key = ""
		m.hadOld = false
		m.oldVal = Value{}
		m.props = props
		m.parent = nil
		m.chainDepth = depth
		curRoot = m
	}
	o.rerooted = true
}
