import type { Token } from "./interfaces/Token";

export class ErrorReporter {
  private source: string;
  private lines: string[];

  constructor(source: string) {
    this.source = source;
    this.lines = source.split('\n');
  }

  /**
   * Format a runtime or semantic error with source context
   */
  formatError(token: Token, message: string, errorType: 'Runtime' | 'Semantic' | 'Parse'): string {
    const parts: string[] = [];
    
    // Header
    parts.push(token.line > 0 ? `\n${errorType} Error at line ${token.line}:` : `\n${errorType} Error:`);
    parts.push(message);
    parts.push('');
    
    // Show the line with the error
    if (token.line > 0 && token.line <= this.lines.length) {
      const lineIndex = token.line - 1;
      const errorLine = this.lines[lineIndex];
      
      // Show context: previous line if available
      if (lineIndex > 0) {
        parts.push(`  ${String(token.line - 1).padStart(4, ' ')} | ${this.lines[lineIndex - 1]}`);
      }
      
      // Show the error line
      parts.push(`> ${String(token.line).padStart(4, ' ')} | ${errorLine}`);
      
      // Calculate the column position for the caret
      const column = this.findColumnInLine(errorLine, token.lexeme);
      if (column >= 0) {
        // Add caret indicator
        const padding = ' '.repeat(8 + column); // 8 = "  #### | ".length
        const carets = '^'.repeat(Math.max(1, token.lexeme.length));
        parts.push(`${padding}${carets}`);
      }
      
      // Show context: next line if available
      if (lineIndex < this.lines.length - 1) {
        parts.push(`  ${String(token.line + 1).padStart(4, ' ')} | ${this.lines[lineIndex + 1]}`);
      }
    }
    
    parts.push('');
    return parts.join('\n');
  }

  /**
   * Find the column position of the lexeme in the line
   * Returns -1 if not found
   */
  private findColumnInLine(line: string, lexeme: string): number {
    // For empty lexeme or special tokens, return the start
    if (!lexeme) return 0;
    
    // Try to find exact match
    let index = line.indexOf(lexeme);
    if (index >= 0) return index;
    
    // For tokens that might be transformed (e.g., keywords), try fuzzy match
    // Just return 0 as fallback
    return 0;
  }

  /**
   * Format a general error without token context
   */
  static formatGeneralError(message: string, errorType: string = 'Error'): string {
    return `\n${errorType}: ${message}\n`;
  }

  /**
   * Format a parser error with line context
   */
  formatParseError(line: number, where: string, message: string): string {
    const parts: string[] = [];
    
    parts.push(`\nParse Error at line ${line}${where ? ` ${where}` : ''}:`);
    parts.push(message);
    parts.push('');
    
    // Show the line with the error
    if (line > 0 && line <= this.lines.length) {
      const lineIndex = line - 1;
      const errorLine = this.lines[lineIndex];
      
      // Show context
      if (lineIndex > 0) {
        parts.push(`  ${String(line - 1).padStart(4, ' ')} | ${this.lines[lineIndex - 1]}`);
      }
      
      parts.push(`> ${String(line).padStart(4, ' ')} | ${errorLine}`);
      
      if (lineIndex < this.lines.length - 1) {
        parts.push(`  ${String(line + 1).padStart(4, ' ')} | ${this.lines[lineIndex + 1]}`);
      }
    }
    
    parts.push('');
    return parts.join('\n');
  }
}

/**
 * Stack frame for call stack tracking
 */
export interface CallFrame {
  functionName: string;
  line: number;
}

/**
 * Format a call stack trace
 */
export function formatCallStack(frames: CallFrame[]): string {
  if (frames.length === 0) return '';
  
  const parts: string[] = [];
  parts.push('\nCall stack:');
  
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    const prefix = i === frames.length - 1 ? '  at' : '  in';
    parts.push(`${prefix} ${frame.functionName} (line ${frame.line})`);
  }
  
  parts.push('');
  return parts.join('\n');
}
