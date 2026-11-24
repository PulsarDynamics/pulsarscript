import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { EventBridge } from "../../../Interpreter";
import { Interpreter } from "../../../Interpreter";
import { linkModule } from "../../../Linker";
import { fromHost, toHost } from "../../../Values";
import type { FileEntry, IOBridge } from "../../../interfaces/IO";

export interface VaultTelemetry {
  handler: string;
  durationMs: number;
  quotaUsed: number;
  quotaMax: number;
  eventCount: number;
}

export interface VaultHostFileSnapshot {
  path: string;
  size: number;
  modified: number;
  encoding: "utf8" | "base64";
}

export interface VaultWindowEvent {
  id: number;
  channel: "window" | "event";
  name: string;
  payload: unknown;
  timestamp: number;
}

export interface VaultHostOptions {
  quotaMax?: number;
  seedOnCreate?: boolean;
}

interface StoredFile {
  text?: string;
  bytes: Uint8Array;
  modified: number;
}

function normalizePath(raw: string): string {
  const cleaned = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned === ".") return "";
  const parts: string[] = [];
  for (const seg of cleaned.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      throw new Error(`Path traversal not allowed outside sandbox: ${raw}`);
    }
    parts.push(seg);
  }
  return parts.join("/");
}

function baseName(path: string): string {
  if (!path) return "";
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

export function createVaultHost(options: VaultHostOptions = {}) {
  const vaultRoot = import.meta.dir;
  const manifestPath = resolve(vaultRoot, "AppManifest.json");
  const entryPulsPath = resolve(vaultRoot, "scripts/main.puls");
  const bundleJsonPath = resolve(vaultRoot, "scripts/main.json");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    script: {
      bundle: string;
      source: string;
      handlers: Array<{ name: string; mode: string; description?: string }>;
    };
    permissions: { scopes: string[] };
  };

  const quotaMax = options.quotaMax ?? 1024 * 1024;
  const files = new Map<string, StoredFile>();
  const dirs = new Set<string>([""]);
  const kvStore = new Map<string, unknown>();
  const eventQueue: unknown[] = [];
  const recentEvents: VaultWindowEvent[] = [];
  const windowListeners = new Set<(ev: VaultWindowEvent) => void>();
  let nextEventSeq = 1;

  function ensureDirsFor(path: string): void {
    let cur = "";
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      dirs.add(cur);
    }
  }

  function totalUsedBytes(): number {
    let total = 0;
    for (const file of files.values()) {
      total += file.bytes.byteLength;
    }
    return total;
  }

  function enforceQuota(path: string, incomingLen: number): void {
    const prevLen = files.get(path)?.bytes.byteLength ?? 0;
    const projected = totalUsedBytes() - prevLen + incomingLen;
    if (projected > quotaMax) {
      throw new Error(`Storage quota exceeded (${projected} > ${quotaMax} bytes)`);
    }
  }

  function recordEvent(channel: "window" | "event", name: string, payload: unknown): VaultWindowEvent {
    const entry: VaultWindowEvent = {
      id: nextEventSeq++,
      channel,
      name,
      payload,
      timestamp: Date.now(),
    };
    recentEvents.push(entry);
    if (recentEvents.length > 80) {
      recentEvents.splice(0, recentEvents.length - 80);
    }
    for (const cb of windowListeners) {
      try {
        cb(entry);
      } catch {
        // Ignore broken listener
      }
    }
    return entry;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  const io: IOBridge = {
    readFile(rawPath: string): string | null {
      const p = normalizePath(rawPath);
      const item = files.get(p);
      if (!item) return null;
      return item.text ?? decoder.decode(item.bytes);
    },
    writeFile(rawPath: string, data: string): boolean {
      const p = normalizePath(rawPath);
      const bytes = encoder.encode(data);
      enforceQuota(p, bytes.byteLength);
      const parent = parentDir(p);
      if (parent) ensureDirsFor(parent);
      files.set(p, { text: data, bytes, modified: Date.now() });
      return true;
    },
    listDir(rawPath: string): Array<FileEntry & { dir: boolean; modified: number }> {
      const dir = normalizePath(rawPath);
      const prefix = dir ? `${dir}/` : "";
      const seen = new Map<string, FileEntry & { dir: boolean; modified: number }>();

      for (const d of dirs) {
        if (!d || d === dir) continue;
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        seen.set(rest, { name: rest, isDir: true, dir: true, size: 0, modified: Date.now() });
      }

      for (const [fPath, file] of files) {
        if (!fPath.startsWith(prefix)) continue;
        const rest = fPath.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        seen.set(rest, {
          name: rest,
          isDir: false,
          dir: false,
          size: file.bytes.byteLength,
          modified: file.modified,
        });
      }

      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    stat(rawPath: string) {
      const p = normalizePath(rawPath);
      const file = files.get(p);
      if (file) {
        return {
          name: baseName(p),
          dir: false,
          size: file.bytes.byteLength,
          modified: file.modified,
        };
      }
      if (dirs.has(p)) {
        return {
          name: baseName(p) || ".",
          dir: true,
          size: 0,
          modified: Date.now(),
        };
      }
      return null;
    },
    exists(rawPath: string): boolean {
      const p = normalizePath(rawPath);
      return files.has(p) || dirs.has(p);
    },
    deleteFile(rawPath: string): boolean {
      const p = normalizePath(rawPath);
      let deleted = false;
      if (files.delete(p)) deleted = true;
      const prefix = `${p}/`;
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) {
          files.delete(key);
          deleted = true;
        }
      }
      for (const d of [...dirs]) {
        if (d === p || d.startsWith(prefix)) {
          dirs.delete(d);
          deleted = true;
        }
      }
      return deleted;
    },
    mkdir(rawPath: string): boolean {
      const p = normalizePath(rawPath);
      if (p) ensureDirsFor(p);
      return true;
    },
    rename(fromRaw: string, toRaw: string): boolean {
      const from = normalizePath(fromRaw);
      const to = normalizePath(toRaw);
      const item = files.get(from);
      if (!item) {
        if (!dirs.has(from)) return false;
        const prefix = `${from}/`;
        for (const [k, v] of [...files.entries()]) {
          if (k.startsWith(prefix)) {
            const target = `${to}/${k.slice(prefix.length)}`;
            const parent = parentDir(target);
            if (parent) ensureDirsFor(parent);
            files.delete(k);
            files.set(target, { ...v, modified: Date.now() });
          }
        }
        dirs.delete(from);
        ensureDirsFor(to);
        return true;
      }
      const toParent = parentDir(to);
      if (toParent) ensureDirsFor(toParent);
      files.delete(from);
      files.set(to, { ...item, modified: Date.now() });
      return true;
    },
    copy(fromRaw: string, toRaw: string): boolean {
      const from = normalizePath(fromRaw);
      const to = normalizePath(toRaw);
      const item = files.get(from);
      if (item) {
        enforceQuota(to, item.bytes.byteLength);
        const parent = parentDir(to);
        if (parent) ensureDirsFor(parent);
        files.set(to, {
          text: item.text,
          bytes: new Uint8Array(item.bytes),
          modified: Date.now(),
        });
        return true;
      }
      if (!dirs.has(from)) return false;
      ensureDirsFor(to);
      const prefix = `${from}/`;
      for (const [k, v] of files.entries()) {
        if (k.startsWith(prefix)) {
          const target = `${to}/${k.slice(prefix.length)}`;
          enforceQuota(target, v.bytes.byteLength);
          const pDir = parentDir(target);
          if (pDir) ensureDirsFor(pDir);
          files.set(target, {
            text: v.text,
            bytes: new Uint8Array(v.bytes),
            modified: Date.now(),
          });
        }
      }
      return true;
    },
    quota() {
      return { used: totalUsedBytes(), max: quotaMax };
    },
    readFileBase64(rawPath: string): string | null {
      const p = normalizePath(rawPath);
      const item = files.get(p);
      if (!item) return null;
      return Buffer.from(item.bytes).toString("base64");
    },
    writeFileBase64(rawPath: string, data: string): boolean {
      const p = normalizePath(rawPath);
      const decoded = Buffer.from(data, "base64");
      const bytes = new Uint8Array(decoded);
      enforceQuota(p, bytes.byteLength);
      const parent = parentDir(p);
      if (parent) ensureDirsFor(parent);
      files.set(p, { bytes, modified: Date.now() });
      return true;
    },
    kvGet(key: string): unknown {
      return kvStore.has(key) ? kvStore.get(key) : null;
    },
    kvSet(key: string, value: unknown): boolean {
      kvStore.set(key, structuredClone(value));
      return true;
    },
    kvDelete(key: string): boolean {
      return kvStore.delete(key);
    },
  };

  const events: EventBridge = {
    emit(payload: unknown): unknown {
      eventQueue.push(payload);
      const obj = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
      const name = typeof obj?.name === "string" ? obj.name : "script.event";
      const data = obj && "payload" in obj ? obj.payload : payload;
      recordEvent("event", name, data);
      return null;
    },
    poll(): unknown {
      return eventQueue.length > 0 ? eventQueue.shift() : null;
    },
    notifyWindow(payload: unknown): unknown {
      const obj = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
      const type = typeof obj?.type === "string" ? obj.type : "script.event";
      recordEvent("window", type, payload);
      return null;
    },
  };

  const linked = linkModule(entryPulsPath);
  const interp = new Interpreter({
    io,
    events,
    limits: {
      maxSteps: 250_000,
      timeoutMs: 1_500,
      maxCallDepth: 256,
    },
  });
  interp.interpret(linked.statements, linked.sources);

  function callRpc<T = Record<string, unknown>>(handler: string, payload: unknown = {}): {
    result: T;
    telemetry: VaultTelemetry;
  } {
    const start = performance.now();
    const raw = interp.callHandler(handler, [fromHost(payload ?? {})]);
    const result = toHost(raw) as T;
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    return {
      result,
      telemetry: {
        handler,
        durationMs,
        quotaUsed: totalUsedBytes(),
        quotaMax,
        eventCount: recentEvents.length,
      },
    };
  }

  function dispatchFsChange(payload: Record<string, unknown> = {}) {
    const beforeLen = recentEvents.length;
    const start = performance.now();
    interp.dispatchEvent("fs.change", fromHost(payload));
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    return {
      durationMs,
      emitted: recentEvents.slice(beforeLen),
      telemetry: {
        handler: "on(fs.change)",
        durationMs,
        quotaUsed: totalUsedBytes(),
        quotaMax,
        eventCount: recentEvents.length,
      },
    };
  }

  function simulateExternalSyncNote(custom?: { title?: string; body?: string; tags?: string[]; folder?: string }) {
    const id = `sync-${Date.now()}`;
    const note = {
      id,
      title: custom?.title?.trim() || "Synced Sensor Log",
      kind: "note",
      folder: custom?.folder?.trim() || "sync",
      tags: custom?.tags?.length ? custom.tags : ["sync", "watcher", "events"],
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      body:
        custom?.body?.trim() ||
        "Arrived via simulated external PulsarOS fs.change event.\n\n- [ ] Review synced telemetry item\n- [x] Verify notifyWindow SSE delivery",
    };
    const path = `notes/${id}.json`;
    io.writeFile(path, JSON.stringify(note));
    const dispatchResult = dispatchFsChange({ path, action: "created", source: "external-sync" });
    return { path, note, ...dispatchResult };
  }

  function getBundleInfo() {
    let bundleBytes = 0;
    let instructions = 0;
    let sourceMapEntries = 0;
    if (existsSync(bundleJsonPath)) {
      bundleBytes = statSync(bundleJsonPath).size;
      const parsed = JSON.parse(readFileSync(bundleJsonPath, "utf8")) as {
        code?: unknown[];
        sourceMap?: unknown[];
      };
      instructions = Array.isArray(parsed.code) ? parsed.code.length : 0;
      sourceMapEntries = Array.isArray(parsed.sourceMap) ? parsed.sourceMap.length : 0;
    }
    return {
      appId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      sources: linked.sources,
      handlers: manifest.script.handlers,
      registeredHandlers: interp.handlerNames(),
      eventListeners: interp.eventListenerNames(),
      scopes: manifest.permissions.scopes,
      bundleBytes,
      instructions,
      sourceMapEntries,
    };
  }

  function listFilesSnapshot(): VaultHostFileSnapshot[] {
    return [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, entry]) => ({
        path,
        size: entry.bytes.byteLength,
        modified: entry.modified,
        encoding: entry.text !== undefined ? "utf8" : "base64",
      }));
  }

  if (options.seedOnCreate) {
    callRpc("initVault", {});
  }

  return {
    manifest,
    interp,
    io,
    kvStore,
    linked,
    callRpc,
    dispatchFsChange,
    simulateExternalSyncNote,
    getBundleInfo,
    listFilesSnapshot,
    listKvKeys: () => [...kvStore.keys()].sort(),
    getQuota: () => ({ used: totalUsedBytes(), max: quotaMax }),
    getRecentEvents: () => [...recentEvents],
    subscribeWindowEvents(listener: (ev: VaultWindowEvent) => void): () => void {
      windowListeners.add(listener);
      return () => {
        windowListeners.delete(listener);
      };
    },
  };
}
