export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/** Encode an LSP JSON-RPC payload with UTF-8 Content-Length framing. */
export function encodeLspMessage(payload: JsonRpcMessage): Buffer {
  const json = JSON.stringify(payload);
  const byteLen = Buffer.byteLength(json, "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${byteLen}\r\n\r\n`, "ascii"),
    Buffer.from(json, "utf8"),
  ]);
}

/**
 * Incremental parser for Content-Length framed JSON-RPC 2.0 streams.
 * Handles partial headers/bodies and multiple messages arriving in one chunk.
 */
export class LspMessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): JsonRpcMessage[] {
    const next = Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next]);
    const messages: JsonRpcMessage[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerStr = this.buffer.subarray(0, headerEnd).toString("ascii");
      let contentLength = -1;
      for (const line of headerStr.split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        if (name === "content-length") {
          contentLength = Number.parseInt(line.slice(idx + 1).trim(), 10);
        }
      }

      if (!Number.isFinite(contentLength) || contentLength < 0) {
        // Skip malformed header frame cleanly.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) break;

      const bodyText = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      try {
        messages.push(JSON.parse(bodyText) as JsonRpcMessage);
      } catch {
        // Ignore malformed JSON body.
      }
    }

    return messages;
  }
}

export function writeLspMessage(msg: JsonRpcMessage, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(encodeLspMessage(msg));
}
