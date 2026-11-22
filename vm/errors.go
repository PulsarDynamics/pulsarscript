package vm

import "fmt"

// ErrorCode provides deterministic error codes for script error handling.
type ErrorCode string

// Standard error codes for script error handling.
const (
	ErrPermission ErrorCode = "ERR_PERMISSION" // Access denied to resource
	ErrQuota      ErrorCode = "ERR_QUOTA"      // Resource quota exceeded
	ErrNotFound   ErrorCode = "ERR_NOT_FOUND"  // Resource not found
	ErrType       ErrorCode = "ERR_TYPE"       // Type mismatch
	ErrRateLimit  ErrorCode = "ERR_RATE_LIMIT" // Rate limit exceeded
	ErrQueueFull  ErrorCode = "ERR_QUEUE_FULL" // Event queue at capacity
	ErrIOError    ErrorCode = "ERR_IO"         // I/O operation failed
	ErrTimeout    ErrorCode = "ERR_TIMEOUT"    // Operation timed out
	ErrInvalid    ErrorCode = "ERR_INVALID"    // Invalid argument or state
)

// ScriptError is a structured error with a code and message.
type ScriptError struct {
	Code    ErrorCode
	Message string
}

// Error implements the error interface.
func (e *ScriptError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// NewScriptError creates a new ScriptError with the given code and message.
func NewScriptError(code ErrorCode, message string) *ScriptError {
	return &ScriptError{Code: code, Message: message}
}

// NewScriptErrorf creates a new ScriptError with formatted message.
func NewScriptErrorf(code ErrorCode, format string, args ...any) *ScriptError {
	return &ScriptError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AsScriptError converts a generic error to a ScriptError if possible.
// If the error is already a ScriptError, returns it directly.
// Otherwise, wraps it with ErrIOError code.
func AsScriptError(err error) *ScriptError {
	if se, ok := err.(*ScriptError); ok {
		return se
	}
	return NewScriptError(ErrIOError, err.Error())
}
