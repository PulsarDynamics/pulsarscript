package vm

import (
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxGenericJSONDepth = 128
	hexDigitsLower      = "0123456789abcdef"
)

// JSONAppender is implemented by types that append their JSON object representation directly
// without reflection so cmd/vmwasm does not pull encoding/json or reflect into WebAssembly.
type JSONAppender interface {
	AppendJSON(dst []byte) []byte
}

// ParseJSON decodes strict RFC 8259 JSON into nil, bool, float64, string, []any, or map[string]any.
func ParseJSON(data []byte) (any, error) {
	p := miniJSONParser{src: string(data)}
	p.skipWS()
	val, err := p.parseAny(0)
	if err != nil {
		return nil, err
	}
	p.skipWS()
	if p.pos < len(p.src) {
		return nil, errors.New("unexpected trailing JSON token")
	}
	return val, nil
}

// parseJSONValue parses strict RFC 8259 JSON straight into a VM Value while enforcing VM
// string, collection, nesting-depth, and live-heap budgets.
func parseJSONValue(vm *VM, text string) (Value, error) {
	p := miniJSONParser{src: text, vm: vm}
	p.skipWS()
	val, err := p.parseVMValue(0)
	if err != nil {
		if _, isRE := err.(*RuntimeError); isRE || errors.Is(err, ErrMemoryLimit) {
			return Value{}, err
		}
		return Value{}, vm.runtimeError("jsonParse: %v", err)
	}
	p.skipWS()
	if p.pos < len(p.src) {
		return Value{}, vm.runtimeError("jsonParse: unexpected trailing token at offset %d", p.pos)
	}
	return val, nil
}

// MarshalJSONAny serializes plain Go values and JSONAppender structs to JSON without reflection.
func MarshalJSONAny(v any) string {
	return string(AppendJSONAny(make([]byte, 0, 128), v))
}

// AppendJSONString appends a double-quoted RFC 8259 JSON string without HTML escaping.
func AppendJSONString(dst []byte, s string) []byte {
	dst = append(dst, '"')
	for i := 0; i < len(s); {
		b := s[i]
		if b < utf8.RuneSelf {
			switch b {
			case '"':
				dst = append(dst, '\\', '"')
			case '\\':
				dst = append(dst, '\\', '\\')
			case '\b':
				dst = append(dst, '\\', 'b')
			case '\f':
				dst = append(dst, '\\', 'f')
			case '\n':
				dst = append(dst, '\\', 'n')
			case '\r':
				dst = append(dst, '\\', 'r')
			case '\t':
				dst = append(dst, '\\', 't')
			default:
				if b < 0x20 {
					dst = append(dst, '\\', 'u', '0', '0', hexDigitsLower[b>>4], hexDigitsLower[b&0x0f])
				} else {
					dst = append(dst, b)
				}
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			dst = append(dst, `\ufffd`...)
			i++
			continue
		}
		// Escape U+2028 and U+2029 like encoding/json for JS embedding safety.
		if r == '\u2028' || r == '\u2029' {
			dst = append(dst, '\\', 'u', '2', '0', '2', hexDigitsLower[r&0x0f])
			i += size
			continue
		}
		dst = append(dst, s[i:i+size]...)
		i += size
	}
	return append(dst, '"')
}

// AppendJSONAny appends a JSON serialization for plain Go types and JSONAppender values.
func AppendJSONAny(dst []byte, v any) []byte {
	if v == nil {
		return append(dst, "null"...)
	}
	switch x := v.(type) {
	case JSONAppender:
		return x.AppendJSON(dst)
	case bool:
		if x {
			return append(dst, "true"...)
		}
		return append(dst, "false"...)
	case int:
		return strconv.AppendInt(dst, int64(x), 10)
	case int64:
		return strconv.AppendInt(dst, x, 10)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return append(dst, "null"...)
		}
		return append(dst, FormatNumber(x)...)
	case string:
		return AppendJSONString(dst, x)
	case []string:
		dst = append(dst, '[')
		for i, item := range x {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = AppendJSONString(dst, item)
		}
		return append(dst, ']')
	case []int:
		dst = append(dst, '[')
		for i, item := range x {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = strconv.AppendInt(dst, int64(item), 10)
		}
		return append(dst, ']')
	case []any:
		dst = append(dst, '[')
		for i, item := range x {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = AppendJSONAny(dst, item)
		}
		return append(dst, ']')
	case map[string]any:
		dst = append(dst, '{')
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for i, k := range keys {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = AppendJSONString(dst, k)
			dst = append(dst, ':')
			dst = AppendJSONAny(dst, x[k])
		}
		return append(dst, '}')
	case map[string]bool:
		dst = append(dst, '{')
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for i, k := range keys {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = AppendJSONString(dst, k)
			dst = append(dst, ':')
			if x[k] {
				dst = append(dst, "true"...)
			} else {
				dst = append(dst, "false"...)
			}
		}
		return append(dst, '}')
	default:
		return append(dst, "null"...)
	}
}

// AppendJSONSlice appends a JSON array of elements implementing JSONAppender.
func AppendJSONSlice[T JSONAppender](dst []byte, items []T) []byte {
	dst = append(dst, '[')
	for i := range items {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = items[i].AppendJSON(dst)
	}
	return append(dst, ']')
}

type miniJSONParser struct {
	src string
	pos int
	vm  *VM
}

func (p *miniJSONParser) skipWS() {
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *miniJSONParser) expectLiteral(lit string) error {
	if !strings.HasPrefix(p.src[p.pos:], lit) {
		return errors.New("invalid JSON literal")
	}
	p.pos += len(lit)
	return nil
}

func parseHex4(s string, pos int) (rune, bool) {
	if pos+4 > len(s) {
		return 0, false
	}
	var val rune
	for i := 0; i < 4; i++ {
		c := s[pos+i]
		val <<= 4
		switch {
		case c >= '0' && c <= '9':
			val |= rune(c - '0')
		case c >= 'a' && c <= 'f':
			val |= rune(c-'a') + 10
		case c >= 'A' && c <= 'F':
			val |= rune(c-'A') + 10
		default:
			return 0, false
		}
	}
	return val, true
}

func (p *miniJSONParser) readString() (string, error) {
	if p.pos >= len(p.src) || p.src[p.pos] != '"' {
		return "", errors.New("expected string")
	}
	p.pos++
	start := p.pos
	var sb strings.Builder
	hasEscape := false

	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '"' {
			if !hasEscape {
				out := p.src[start:p.pos]
				p.pos++
				return out, nil
			}
			sb.WriteString(p.src[start:p.pos])
			p.pos++
			return sb.String(), nil
		}
		if c < 0x20 {
			return "", errors.New("unescaped control character in string")
		}
		if c == '\\' {
			if !hasEscape {
				hasEscape = true
			}
			sb.WriteString(p.src[start:p.pos])
			p.pos++
			if p.pos >= len(p.src) {
				return "", errors.New("unterminated escape sequence")
			}
			esc := p.src[p.pos]
			p.pos++
			switch esc {
			case '"', '\\', '/':
				sb.WriteByte(esc)
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			case 'u':
				r1, ok := parseHex4(p.src, p.pos)
				if !ok {
					return "", errors.New("invalid \\u escape")
				}
				p.pos += 4
				if r1 >= 0xD800 && r1 <= 0xDBFF {
					if p.pos+6 <= len(p.src) && p.src[p.pos] == '\\' && p.src[p.pos+1] == 'u' {
						if r2, ok2 := parseHex4(p.src, p.pos+2); ok2 && r2 >= 0xDC00 && r2 <= 0xDFFF {
							p.pos += 6
							combined := 0x10000 + ((r1 - 0xD800) << 10) + (r2 - 0xDC00)
							sb.WriteRune(combined)
							start = p.pos
							continue
						}
					}
					sb.WriteRune(utf8.RuneError)
				} else if r1 >= 0xDC00 && r1 <= 0xDFFF {
					sb.WriteRune(utf8.RuneError)
				} else {
					sb.WriteRune(r1)
				}
			default:
				return "", errors.New("invalid escape character in string")
			}
			start = p.pos
			continue
		}
		if c >= utf8.RuneSelf {
			r, size := utf8.DecodeRuneInString(p.src[p.pos:])
			if r == utf8.RuneError && size == 1 {
				if !hasEscape {
					hasEscape = true
				}
				sb.WriteString(p.src[start:p.pos])
				sb.WriteRune(utf8.RuneError)
				p.pos++
				start = p.pos
				continue
			}
			p.pos += size
			continue
		}
		p.pos++
	}
	return "", errors.New("unterminated string literal")
}

func (p *miniJSONParser) readNumber() (float64, error) {
	start := p.pos
	if p.pos < len(p.src) && p.src[p.pos] == '-' {
		p.pos++
	}
	if p.pos >= len(p.src) {
		return 0, errors.New("invalid JSON number")
	}
	if p.src[p.pos] == '0' {
		p.pos++
		if p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			return 0, errors.New("leading zero in JSON number")
		}
	} else if p.src[p.pos] >= '1' && p.src[p.pos] <= '9' {
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			p.pos++
		}
	} else {
		return 0, errors.New("invalid JSON number")
	}
	if p.pos < len(p.src) && p.src[p.pos] == '.' {
		p.pos++
		if p.pos >= len(p.src) || p.src[p.pos] < '0' || p.src[p.pos] > '9' {
			return 0, errors.New("invalid JSON fraction")
		}
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			p.pos++
		}
	}
	if p.pos < len(p.src) && (p.src[p.pos] == 'e' || p.src[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.src) && (p.src[p.pos] == '+' || p.src[p.pos] == '-') {
			p.pos++
		}
		if p.pos >= len(p.src) || p.src[p.pos] < '0' || p.src[p.pos] > '9' {
			return 0, errors.New("invalid JSON exponent")
		}
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			p.pos++
		}
	}
	raw := p.src[start:p.pos]
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, errors.New("JSON number out of range")
	}
	return f, nil
}

func (p *miniJSONParser) parseAny(depth int) (any, error) {
	p.skipWS()
	if p.pos >= len(p.src) {
		return nil, errors.New("unexpected end of JSON input")
	}
	switch p.src[p.pos] {
	case 'n':
		return nil, p.expectLiteral("null")
	case 't':
		if err := p.expectLiteral("true"); err != nil {
			return nil, err
		}
		return true, nil
	case 'f':
		if err := p.expectLiteral("false"); err != nil {
			return nil, err
		}
		return false, nil
	case '"':
		return p.readString()
	case '[':
		if depth+1 > maxGenericJSONDepth {
			return nil, errors.New("JSON nesting depth exceeded")
		}
		p.pos++
		p.skipWS()
		out := make([]any, 0)
		if p.pos < len(p.src) && p.src[p.pos] == ']' {
			p.pos++
			return out, nil
		}
		for {
			el, err := p.parseAny(depth + 1)
			if err != nil {
				return nil, err
			}
			out = append(out, el)
			p.skipWS()
			if p.pos >= len(p.src) {
				return nil, errors.New("expected ']'")
			}
			if p.src[p.pos] == ']' {
				p.pos++
				return out, nil
			}
			if p.src[p.pos] != ',' {
				return nil, errors.New("expected ',' or ']'")
			}
			p.pos++
		}
	case '{':
		if depth+1 > maxGenericJSONDepth {
			return nil, errors.New("JSON nesting depth exceeded")
		}
		p.pos++
		p.skipWS()
		out := make(map[string]any)
		if p.pos < len(p.src) && p.src[p.pos] == '}' {
			p.pos++
			return out, nil
		}
		for {
			p.skipWS()
			key, err := p.readString()
			if err != nil {
				return nil, errors.New("object key must be string")
			}
			p.skipWS()
			if p.pos >= len(p.src) || p.src[p.pos] != ':' {
				return nil, errors.New("expected ':' after object key")
			}
			p.pos++
			val, err := p.parseAny(depth + 1)
			if err != nil {
				return nil, err
			}
			out[key] = val
			p.skipWS()
			if p.pos >= len(p.src) {
				return nil, errors.New("expected '}'")
			}
			if p.src[p.pos] == '}' {
				p.pos++
				return out, nil
			}
			if p.src[p.pos] != ',' {
				return nil, errors.New("expected ',' or '}'")
			}
			p.pos++
		}
	default:
		return p.readNumber()
	}
}

func (p *miniJSONParser) parseVMValue(depth int) (Value, error) {
	p.skipWS()
	if p.pos >= len(p.src) {
		return Value{}, errors.New("unexpected end of JSON")
	}
	switch p.src[p.pos] {
	case 'n':
		if err := p.expectLiteral("null"); err != nil {
			return Value{}, err
		}
		return Nil(), nil
	case 't':
		if err := p.expectLiteral("true"); err != nil {
			return Value{}, err
		}
		return Bool(true), nil
	case 'f':
		if err := p.expectLiteral("false"); err != nil {
			return Value{}, err
		}
		return Bool(false), nil
	case '"':
		s, err := p.readString()
		if err != nil {
			return Value{}, err
		}
		if err := p.vm.checkStringSize(len(s)); err != nil {
			return Value{}, err
		}
		return String(s), nil
	case '[':
		if depth+1 > maxJSONDepth {
			return Value{}, p.vm.runtimeError("jsonParse: maximum nesting depth %d exceeded", maxJSONDepth)
		}
		p.pos++
		p.skipWS()
		elems := make([]Value, 0)
		if p.pos < len(p.src) && p.src[p.pos] == ']' {
			p.pos++
			if err := p.vm.accountAlloc(estCollectionHeader, 1); err != nil {
				return Value{}, err
			}
			return Array(elems), nil
		}
		for {
			el, err := p.parseVMValue(depth + 1)
			if err != nil {
				return Value{}, err
			}
			if err := p.vm.checkCollectionSize(len(elems) + 1); err != nil {
				return Value{}, err
			}
			elems = append(elems, el)
			p.skipWS()
			if p.pos >= len(p.src) {
				return Value{}, p.vm.runtimeError("jsonParse: expected ']'")
			}
			if p.src[p.pos] == ']' {
				p.pos++
				break
			}
			if p.src[p.pos] != ',' {
				return Value{}, p.vm.runtimeError("jsonParse: expected ',' or ']'")
			}
			p.pos++
		}
		if err := p.vm.accountAlloc(estCollectionHeader+int64(len(elems))*estElementSlot, 1); err != nil {
			return Value{}, err
		}
		return Array(elems), nil
	case '{':
		if depth+1 > maxJSONDepth {
			return Value{}, p.vm.runtimeError("jsonParse: maximum nesting depth %d exceeded", maxJSONDepth)
		}
		p.pos++
		p.skipWS()
		m := make(map[string]Value)
		if p.pos < len(p.src) && p.src[p.pos] == '}' {
			p.pos++
			if err := p.vm.accountAlloc(estCollectionHeader, 1); err != nil {
				return Value{}, err
			}
			return Object(m), nil
		}
		for {
			p.skipWS()
			k, err := p.readString()
			if err != nil {
				return Value{}, p.vm.runtimeError("jsonParse: object key must be string")
			}
			if err := p.vm.checkStringSize(len(k)); err != nil {
				return Value{}, err
			}
			p.skipWS()
			if p.pos >= len(p.src) || p.src[p.pos] != ':' {
				return Value{}, p.vm.runtimeError("jsonParse: expected ':'")
			}
			p.pos++
			val, err := p.parseVMValue(depth + 1)
			if err != nil {
				return Value{}, err
			}
			if _, exists := m[k]; !exists {
				if err := p.vm.checkCollectionSize(len(m) + 1); err != nil {
					return Value{}, err
				}
			}
			m[k] = val
			p.skipWS()
			if p.pos >= len(p.src) {
				return Value{}, p.vm.runtimeError("jsonParse: expected '}'")
			}
			if p.src[p.pos] == '}' {
				p.pos++
				break
			}
			if p.src[p.pos] != ',' {
				return Value{}, p.vm.runtimeError("jsonParse: expected ',' or '}'")
			}
			p.pos++
		}
		if err := p.vm.accountAlloc(estCollectionHeader+int64(len(m))*estObjectEntry, 1); err != nil {
			return Value{}, err
		}
		return Object(m), nil
	default:
		f, err := p.readNumber()
		if err != nil {
			return Value{}, err
		}
		return Number(f), nil
	}
}
