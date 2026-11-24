import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createVaultHost } from "./host";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function createVaultServer(port = Number(process.env.PORT ?? 4174)) {
  const vaultRoot = import.meta.dir;
  const uiRoot = resolve(vaultRoot, "ui");
  const host = createVaultHost({ seedOnCreate: true });
  const rpcHandlers = new Set(
    host.manifest.script.handlers.filter((h) => h.mode === "rpc").map((h) => h.name),
  );

  function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  function serveAsset(filePath: string): Response {
    if (!existsSync(filePath)) {
      return new Response("Not Found", { status: 404 });
    }
    const ext = extname(filePath);
    return new Response(readFileSync(filePath), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  return Bun.serve({
    port,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/api/health") {
        return jsonResponse({ ok: true, app: host.manifest.id, version: host.manifest.version });
      }

      if (req.method === "GET" && pathname === "/api/bundle-info") {
        return jsonResponse(host.getBundleInfo());
      }

      if (req.method === "GET" && pathname === "/api/files") {
        return jsonResponse({
          files: host.listFilesSnapshot(),
          kvKeys: host.listKvKeys(),
          quota: host.getQuota(),
          events: host.getRecentEvents(),
        });
      }

      if (req.method === "GET" && pathname === "/api/events") {
        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let closed = false;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const cleanup = () => {
              if (closed) return;
              closed = true;
              if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
              }
              if (heartbeat) {
                clearInterval(heartbeat);
                heartbeat = null;
              }
              try {
                controller.close();
              } catch {}
            };

            const send = (event: string, data: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              } catch {
                cleanup();
              }
            };

            send("ready", {
              app: host.manifest.id,
              recentEvents: host.getRecentEvents().slice(-10),
            });
            unsubscribe = host.subscribeWindowEvents((ev) => {
              send(ev.channel === "window" ? "script.event" : "host.event", ev);
            });
            heartbeat = setInterval(() => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch {
                cleanup();
              }
            }, 5_000);
            req.signal.addEventListener("abort", cleanup, { once: true });
          },
          cancel() {
            closed = true;
            if (unsubscribe) {
              unsubscribe();
              unsubscribe = null;
            }
            if (heartbeat) {
              clearInterval(heartbeat);
              heartbeat = null;
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (req.method === "POST" && pathname === "/api/rpc") {
        try {
          const body = (await req.json()) as { handler?: string; payload?: unknown };
          const handler = typeof body?.handler === "string" ? body.handler : "";
          if (!rpcHandlers.has(handler)) {
            return jsonResponse({ ok: false, error: `Unknown or non-RPC handler: ${handler}` }, 400);
          }
          const out = host.callRpc(handler, body.payload ?? {});
          return jsonResponse({ ok: true, result: out.result, telemetry: out.telemetry });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ ok: false, error: message }, 500);
        }
      }

      if (req.method === "POST" && pathname === "/api/watch-event") {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            mode?: string;
            path?: string;
            title?: string;
            body?: string;
            tags?: string[];
            folder?: string;
          };
          if (body.mode === "fs_change" && body.path) {
            const out = host.dispatchFsChange({ path: body.path, action: "modified", source: "manual" });
            return jsonResponse({ ok: true, ...out });
          }
          const out = host.simulateExternalSyncNote(body);
          return jsonResponse({ ok: true, ...out });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ ok: false, error: message }, 500);
        }
      }

      if (pathname === "/AppManifest.json" || pathname === "/manifest") {
        return jsonResponse(host.manifest);
      }

      if (pathname === "/icon.svg") {
        return serveAsset(resolve(vaultRoot, "icon.svg"));
      }

      const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const candidate = resolve(uiRoot, relPath);
      if (!candidate.startsWith(uiRoot)) {
        return new Response("Forbidden", { status: 403 });
      }
      return serveAsset(candidate);
    },
  });
}

if (import.meta.main) {
  const server = createVaultServer();
  console.log(`Pulsar Vault mock-host running at http://localhost:${server.port}/`);
}
