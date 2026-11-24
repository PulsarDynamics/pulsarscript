import { LspMessageReader, writeLspMessage, type JsonRpcRequest } from "./protocol";
import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
  getFormattingEdits,
  getHover,
  getSignatureHelp,
  type LspPosition,
} from "./analysis";

const documents = new Map<string, string>();
let shutdownRequested = false;

function publishDiagnostics(uri: string, text: string): void {
  writeLspMessage({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: getDiagnostics(uri, text),
    },
  });
}

function handleRequest(msg: JsonRpcRequest): void {
  const { id, method, params } = msg;
  const p = (params ?? {}) as Record<string, any>;

  if (id === undefined) {
    // Notification
    if (method === "exit") {
      process.exit(shutdownRequested ? 0 : 1);
    }
    if (method === "textDocument/didOpen") {
      const doc = p.textDocument;
      if (doc?.uri && typeof doc.text === "string") {
        documents.set(doc.uri, doc.text);
        publishDiagnostics(doc.uri, doc.text);
      }
    } else if (method === "textDocument/didChange") {
      const uri = p.textDocument?.uri;
      const changes = p.contentChanges;
      if (uri && Array.isArray(changes) && changes.length > 0) {
        const latest = changes[changes.length - 1];
        if (typeof latest.text === "string") {
          documents.set(uri, latest.text);
          publishDiagnostics(uri, latest.text);
        }
      }
    } else if (method === "textDocument/didSave") {
      const uri = p.textDocument?.uri;
      const text = typeof p.text === "string" ? p.text : documents.get(uri);
      if (uri && typeof text === "string") {
        documents.set(uri, text);
        publishDiagnostics(uri, text);
      }
    } else if (method === "textDocument/didClose") {
      const uri = p.textDocument?.uri;
      if (uri) {
        documents.delete(uri);
        writeLspMessage({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics: [] },
        });
      }
    }
    return;
  }

  let result: unknown = null;
  switch (method) {
    case "initialize":
      result = {
        capabilities: {
          textDocumentSync: 1,
          completionProvider: {
            resolveProvider: false,
            triggerCharacters: [".", "("],
          },
          hoverProvider: true,
          definitionProvider: true,
          signatureHelpProvider: {
            triggerCharacters: ["(", ","],
          },
          documentSymbolProvider: true,
          documentFormattingProvider: true,
        },
        serverInfo: {
          name: "pulsarscript-lsp",
          version: "1.2.0",
        },
      };
      break;
    case "shutdown":
      shutdownRequested = true;
      result = null;
      break;
    case "textDocument/completion": {
      const uri = p.textDocument?.uri as string;
      const pos = p.position as LspPosition;
      const text = documents.get(uri) ?? "";
      result = { isIncomplete: false, items: getCompletions(uri, text, pos) };
      break;
    }
    case "textDocument/hover": {
      const uri = p.textDocument?.uri as string;
      const pos = p.position as LspPosition;
      const text = documents.get(uri) ?? "";
      result = getHover(uri, text, pos);
      break;
    }
    case "textDocument/definition": {
      const uri = p.textDocument?.uri as string;
      const pos = p.position as LspPosition;
      const text = documents.get(uri) ?? "";
      result = getDefinition(uri, text, pos);
      break;
    }
    case "textDocument/signatureHelp": {
      const uri = p.textDocument?.uri as string;
      const pos = p.position as LspPosition;
      const text = documents.get(uri) ?? "";
      result = getSignatureHelp(uri, text, pos);
      break;
    }
    case "textDocument/documentSymbol": {
      const uri = p.textDocument?.uri as string;
      const text = documents.get(uri) ?? "";
      result = getDocumentSymbols(text);
      break;
    }
    case "textDocument/formatting": {
      const uri = p.textDocument?.uri as string;
      const text = documents.get(uri) ?? "";
      result = getFormattingEdits(text);
      break;
    }
    default:
      writeLspMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
  }

  writeLspMessage({ jsonrpc: "2.0", id, result });
}

const reader = new LspMessageReader();
process.stdin.on("data", (chunk: Buffer) => {
  for (const msg of reader.push(chunk)) {
    if ("method" in msg) {
      handleRequest(msg as JsonRpcRequest);
    }
  }
});
process.stdin.on("end", () => {
  process.exit(shutdownRequested ? 0 : 0);
});
