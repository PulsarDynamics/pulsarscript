// Minimal static preview server for PulsarScript's landing page under site/.
// Run: bun run site
import { extname, normalize, resolve } from "node:path";

const siteRoot = resolve(import.meta.dir);
const port = Number(process.env.PORT ?? 4173);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let relPath = decodeURIComponent(url.pathname);
    if (relPath === "/") relPath = "/index.html";

    const cleanRel = normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    const absPath = resolve(siteRoot, `.${cleanRel.startsWith("/") ? "" : "/"}${cleanRel}`);
    if (!absPath.startsWith(siteRoot)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(absPath);
    if (!(await file.exists())) {
      return new Response("Not Found", { status: 404 });
    }

    const mime = MIME_TYPES[extname(absPath)] ?? "application/octet-stream";
    return new Response(file, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-store",
      },
    });
  },
});

console.log(`PulsarScript landing page: http://localhost:${server.port}`);
