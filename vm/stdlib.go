package vm

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxJSONDepth = 64

func indexOfRunes(s, sub string, hasStart bool, startNum float64) (int, error) {
	runes := []rune(s)
	subRunes := []rune(sub)
	startIdx := 0
	if hasStart {
		if math.IsNaN(startNum) || math.IsInf(startNum, 0) {
			return 0, fmt.Errorf("indexOf: start index must be a finite number")
		}
		startIdx = int(math.Trunc(startNum))
		if startIdx < 0 {
			startIdx = 0
		}
	}
	if startIdx > len(runes) {
		return -1, nil
	}
	if len(subRunes) == 0 {
		return startIdx, nil
	}
	limit := len(runes) - len(subRunes)
	for i := startIdx; i <= limit; i++ {
		match := true
		for j := 0; j < len(subRunes); j++ {
			if runes[i+j] != subRunes[j] {
				match = false
				break
			}
		}
		if match {
			return i, nil
		}
	}
	return -1, nil
}

func lastIndexOfRunes(s, sub string, hasStart bool, startNum float64) (int, error) {
	runes := []rune(s)
	subRunes := []rune(sub)
	maxIdx := len(runes)
	if hasStart {
		if math.IsNaN(startNum) || math.IsInf(startNum, 0) {
			return 0, fmt.Errorf("lastIndexOf: start index must be a finite number")
		}
		maxIdx = int(math.Trunc(startNum))
		if maxIdx < 0 {
			maxIdx = 0
		}
		if maxIdx > len(runes) {
			maxIdx = len(runes)
		}
	}
	if len(subRunes) == 0 {
		return maxIdx, nil
	}
	start := maxIdx
	if limit := len(runes) - len(subRunes); start > limit {
		start = limit
	}
	for i := start; i >= 0; i-- {
		match := true
		for j := 0; j < len(subRunes); j++ {
			if runes[i+j] != subRunes[j] {
				match = false
				break
			}
		}
		if match {
			return i, nil
		}
	}
	return -1, nil
}

func padStringRunes(vm *VM, fnName, s string, targetLenNum float64, fill string, padStart bool) (Value, error) {
	if math.IsNaN(targetLenNum) || math.IsInf(targetLenNum, 0) {
		return Value{}, vm.runtimeError("%s: length must be a finite number", fnName)
	}
	targetLen := int(math.Trunc(targetLenNum))
	sRunes := utf8.RuneCountInString(s)
	if targetLen <= sRunes || fill == "" {
		return String(s), nil
	}
	fillRunes := []rune(fill)
	need := targetLen - sRunes
	// Pre-check conservative max bytes before building huge strings.
	fullCopies := need / len(fillRunes)
	rem := need % len(fillRunes)
	if len(fill) > 0 && vm.maxStringBytes > 0 {
		// Upper bound: fullCopies*len(fill) + bytes of first rem runes + len(s)
		remBytes := 0
		for i := 0; i < rem; i++ {
			remBytes += utf8.RuneLen(fillRunes[i])
		}
		if fullCopies > (vm.maxStringBytes-len(s))/len(fill) {
			if err := vm.checkStringSize(vm.maxStringBytes + 1); err != nil {
				return Value{}, err
			}
		}
		if err := vm.checkStringSize(len(s) + fullCopies*len(fill) + remBytes); err != nil {
			return Value{}, err
		}
	}
	var pad strings.Builder
	for i := 0; i < fullCopies; i++ {
		pad.WriteString(fill)
	}
	for i := 0; i < rem; i++ {
		pad.WriteRune(fillRunes[i])
	}
	var out string
	if padStart {
		out = pad.String() + s
	} else {
		out = s + pad.String()
	}
	if err := vm.checkStringSize(len(out)); err != nil {
		return Value{}, err
	}
	return String(out), nil
}

func mergeSortValues(items []Value, less func(a, b Value) (bool, error)) ([]Value, error) {
	if len(items) <= 1 {
		out := make([]Value, len(items))
		copy(out, items)
		return out, nil
	}
	mid := len(items) / 2
	left, err := mergeSortValues(items[:mid], less)
	if err != nil {
		return nil, err
	}
	right, err := mergeSortValues(items[mid:], less)
	if err != nil {
		return nil, err
	}
	out := make([]Value, 0, len(items))
	i, j := 0, 0
	for i < len(left) && j < len(right) {
		// Compare right < left so equal elements preserve left-first stability.
		rightBeforeLeft, err := less(right[j], left[i])
		if err != nil {
			return nil, err
		}
		if rightBeforeLeft {
			out = append(out, right[j])
			j++
		} else {
			out = append(out, left[i])
			i++
		}
	}
	out = append(out, left[i:]...)
	out = append(out, right[j:]...)
	return out, nil
}

func defaultSortCompare(vm *VM, items []Value) ([]Value, error) {
	if len(items) == 0 {
		return []Value{}, nil
	}
	firstKind := items[0].kind
	if firstKind != kindNumber && firstKind != kindString {
		return nil, vm.runtimeError("arraySort: default order only supports numbers or strings, got %s", typeName(items[0]))
	}
	for _, it := range items[1:] {
		if it.kind != firstKind {
			return nil, vm.runtimeError("arraySort: cannot compare %s and %s without a comparator", typeName(items[0]), typeName(it))
		}
	}
	if firstKind == kindString {
		return mergeSortValues(items, func(a, b Value) (bool, error) {
			return a.str < b.str, nil
		})
	}
	return mergeSortValues(items, func(a, b Value) (bool, error) {
		aNaN, bNaN := math.IsNaN(a.num), math.IsNaN(b.num)
		if aNaN || bNaN {
			return !aNaN && bNaN, nil
		}
		return a.num < b.num, nil
	})
}

func parseJSONStrict(vm *VM, text string) (Value, error) {
	return parseJSONValue(vm, text)
}

func stringifyJSONValue(vm *VM, v Value) (string, error) {
	var sb strings.Builder
	if err := writeJSONValue(vm, &sb, v, 0); err != nil {
		return "", err
	}
	res := sb.String()
	if err := vm.checkStringSize(len(res)); err != nil {
		return "", err
	}
	return res, nil
}

func writeJSONString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			if r >= 0 && r < 0x20 {
				fmt.Fprintf(sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

func writeJSONValue(vm *VM, sb *strings.Builder, v Value, depth int) error {
	switch v.kind {
	case kindNil:
		sb.WriteString("null")
	case kindBool:
		if v.b {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case kindNumber:
		if math.IsNaN(v.num) || math.IsInf(v.num, 0) {
			return vm.runtimeError("jsonStringify: cannot serialize non-finite number")
		}
		if v.num == 0 {
			sb.WriteByte('0')
		} else {
			sb.WriteString(FormatNumber(v.num))
		}
	case kindString:
		writeJSONString(sb, v.str)
	case kindArray:
		if depth+1 > maxJSONDepth {
			return vm.runtimeError("jsonStringify: maximum nesting depth %d exceeded", maxJSONDepth)
		}
		sb.WriteByte('[')
		n := v.arrayLen()
		for i := 0; i < n; i++ {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := writeJSONValue(vm, sb, v.arrayAt(i), depth+1); err != nil {
				return err
			}
		}
		sb.WriteByte(']')
	case kindObject:
		if depth+1 > maxJSONDepth {
			return vm.runtimeError("jsonStringify: maximum nesting depth %d exceeded", maxJSONDepth)
		}
		sb.WriteByte('{')
		keys := v.objectKeys()
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeJSONString(sb, k)
			sb.WriteByte(':')
			val, _ := v.objectGet(k)
			if err := writeJSONValue(vm, sb, val, depth+1); err != nil {
				return err
			}
		}
		sb.WriteByte('}')
	case kindFunction:
		return vm.runtimeError("jsonStringify: cannot serialize function")
	default:
		return vm.runtimeError("jsonStringify: unsupported value kind")
	}
	if err := vm.checkStringSize(sb.Len()); err != nil {
		return err
	}
	return nil
}

func formatUTCDate(vm *VM, msNum float64, pattern string) (string, error) {
	if math.IsNaN(msNum) || math.IsInf(msNum, 0) || msNum < -8.64e15 || msNum > 8.64e15 {
		return "", vm.runtimeError("dateFormat: timestamp out of range")
	}
	msInt := int64(math.Trunc(msNum))
	sec := msInt / 1000
	remMs := msInt % 1000
	if remMs < 0 {
		sec--
		remMs += 1000
	}
	t := time.Unix(sec, remMs*1_000_000).UTC()
	year := fmt.Sprintf("%04d", t.Year())
	if t.Year() < 0 {
		year = fmt.Sprintf("-%04d", -t.Year())
	}
	month := fmt.Sprintf("%02d", int(t.Month()))
	day := fmt.Sprintf("%02d", t.Day())
	hour := fmt.Sprintf("%02d", t.Hour())
	min := fmt.Sprintf("%02d", t.Minute())
	secStr := fmt.Sprintf("%02d", t.Second())
	msStr := fmt.Sprintf("%03d", remMs)

	var sb strings.Builder
	for i := 0; i < len(pattern); {
		switch {
		case strings.HasPrefix(pattern[i:], "YYYY"):
			sb.WriteString(year)
			i += 4
		case strings.HasPrefix(pattern[i:], "MM"):
			sb.WriteString(month)
			i += 2
		case strings.HasPrefix(pattern[i:], "DD"):
			sb.WriteString(day)
			i += 2
		case strings.HasPrefix(pattern[i:], "HH"):
			sb.WriteString(hour)
			i += 2
		case strings.HasPrefix(pattern[i:], "mm"):
			sb.WriteString(min)
			i += 2
		case strings.HasPrefix(pattern[i:], "ss"):
			sb.WriteString(secStr)
			i += 2
		case strings.HasPrefix(pattern[i:], "SSS"):
			sb.WriteString(msStr)
			i += 3
		default:
			sb.WriteByte(pattern[i])
			i++
		}
	}
	out := sb.String()
	if err := vm.checkStringSize(len(out)); err != nil {
		return "", err
	}
	return out, nil
}

func daysInMonthUTC(year, month int) int {
	switch month {
	case 1, 3, 5, 7, 8, 10, 12:
		return 31
	case 4, 6, 9, 11:
		return 30
	case 2:
		if (year%4 == 0 && year%100 != 0) || year%400 == 0 {
			return 29
		}
		return 28
	default:
		return 0
	}
}

func parseASCIIDigits(s string, start, count int) (int, bool) {
	if start+count > len(s) {
		return 0, false
	}
	v := 0
	for i := 0; i < count; i++ {
		c := s[start+i]
		if c < '0' || c > '9' {
			return 0, false
		}
		v = v*10 + int(c-'0')
	}
	return v, true
}

func parseISODateStrict(s string) Value {
	if len(s) < 10 || s[4] != '-' || s[7] != '-' {
		return Nil()
	}
	year, okY := parseASCIIDigits(s, 0, 4)
	month, okM := parseASCIIDigits(s, 5, 2)
	day, okD := parseASCIIDigits(s, 8, 2)
	if !okY || !okM || !okD {
		return Nil()
	}
	if month < 1 || month > 12 || day < 1 || day > daysInMonthUTC(year, month) {
		return Nil()
	}
	hour, minute, second, milli := 0, 0, 0, 0
	offsetMs := int64(0)
	if len(s) > 10 {
		if s[10] != 'T' || len(s) < 17 || s[13] != ':' {
			return Nil()
		}
		var ok bool
		hour, ok = parseASCIIDigits(s, 11, 2)
		if !ok {
			return Nil()
		}
		minute, ok = parseASCIIDigits(s, 14, 2)
		if !ok {
			return Nil()
		}
		pos := 16
		if pos < len(s) && s[pos] == ':' {
			pos++
			second, ok = parseASCIIDigits(s, pos, 2)
			if !ok {
				return Nil()
			}
			pos += 2
			if pos < len(s) && s[pos] == '.' {
				pos++
				fracStart := pos
				for pos < len(s) && s[pos] >= '0' && s[pos] <= '9' && pos-fracStart < 3 {
					pos++
				}
				if pos == fracStart {
					return Nil()
				}
				frac := s[fracStart:pos]
				for len(frac) < 3 {
					frac += "0"
				}
				milli, _ = strconv.Atoi(frac)
			}
		}
		if hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 {
			return Nil()
		}
		tz := s[pos:]
		if tz == "Z" {
			// UTC offset 0
		} else if len(tz) == 6 && (tz[0] == '+' || tz[0] == '-') && tz[3] == ':' {
			tzH, okH := parseASCIIDigits(tz, 1, 2)
			tzM, okMin := parseASCIIDigits(tz, 4, 2)
			if !okH || !okMin || tzH > 23 || tzM > 59 {
				return Nil()
			}
			offsetMs = int64(tzH*60+tzM) * 60_000
			if tz[0] == '-' {
				offsetMs = -offsetMs
			}
		} else {
			return Nil()
		}
	}
	t := time.Date(year, time.Month(month), day, hour, minute, second, milli*1_000_000, time.UTC)
	return Number(float64(t.UnixMilli() - offsetMs))
}
