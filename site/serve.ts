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
  ".wasm": "application/wasm",
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
    const acceptEncoding = req.headers.get("accept-encoding") ?? "";
    if (/\bbr\b/i.test(acceptEncoding)) {
      const brFile = Bun.file(`${absPath}.br`);
      if (await brFile.exists()) {
        return new Response(brFile, {
          headers: {
            "Content-Type": mime,
            "Content-Encoding": "br",
            "Vary": "Accept-Encoding",
            "Cache-Control": "no-store",
          },
        });
      }
    }
    if (/\bgzip\b/i.test(acceptEncoding)) {
      const gzFile = Bun.file(`${absPath}.gz`);
      if (await gzFile.exists()) {
        return new Response(gzFile, {
          headers: {
            "Content-Type": mime,
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    return new Response(file, {
      headers: {
        "Content-Type": mime,
        "Vary": "Accept-Encoding",
        "Cache-Control": "no-store",
      },
    });
  },
});

console.log(`PulsarScript landing page: http://localhost:${server.port}`);
