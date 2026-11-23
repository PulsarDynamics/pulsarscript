import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { linkModule } from "../../Linker";
import { SemanticAnalyzer } from "../../SemanticAnalyzer";
import { BytecodeCompiler } from "../../BytecodeCompiler";
import { Interpreter } from "../../Interpreter";
import { toHost } from "../../Values";

describe("LANG-13 file-manager reference script", () => {
  const refPath = resolve(import.meta.dir, "../../examples/file-manager-reference.puls");

  test("links cleanly, compiles, and runs RPC handlers and event watcher on Interpreter", () => {
    const linked = linkModule(refPath);
    expect(linked.sources).toEqual(["file-manager-reference.puls", "file-manager-utils.puls"]);

    const analyzer = new SemanticAnalyzer();
    analyzer.analyze(linked.statements);
    expect(analyzer.warnings).toEqual([]);

    const chunk = BytecodeCompiler.compile(linked.statements, linked.sources);
    expect(chunk.sources).toEqual(linked.sources);
    expect(chunk.fileMap?.length).toBe(chunk.code.length);

    const files = new Map<string, string>([
      ["/docs/note.txt", "hello"],
      ["/docs/draft.txt", "world"],
      ["/docs/image.png", "png"],
    ]);
    const renames: [string, string][] = [];
    const emitted: any[] = [];

    const interp = new Interpreter({
      io: {
        readFile: (p) => files.get(p) ?? null,
        writeFile: (p, d) => { files.set(p, d); return true; },
        listDir: () => [
          { name: "note.txt", isDir: false, size: 50 },
          { name: "assets", isDir: true, size: 0 },
          { name: "draft.txt", isDir: false, size: 20 },
        ],
        rename: (from, to) => { renames.push([from, to]); return true; },
      },
      events: {
        emit: (e) => { emitted.push(e); return null; },
        poll: () => null,
      },
    });

    interp.interpret(linked.statements, linked.sources);
    expect(interp.handlerNames().sort()).toEqual(["applyRenamePage", "listSorted", "planRename"]);
    expect(interp.eventListenerNames()).toEqual(["fs.change"]);

    const sorted = toHost(interp.callHandler("listSorted", ["/docs", "name", true]));
    expect(sorted.map((e: any) => e.name)).toEqual(["assets", "draft.txt", "note.txt"]);

    const plan = toHost(interp.callHandler("planRename", ["/docs", ".txt", ".md", "v2_"]));
    expect(plan).toEqual([
      { from: "/docs/note.txt", to: "/docs/v2_note.md", changed: true },
      { from: "/docs/draft.txt", to: "/docs/v2_draft.md", changed: true },
    ]);

    const p1 = toHost(interp.callHandler("applyRenamePage", [plan, 0, 1]));
    expect(p1).toEqual({ moved: 1, nextCursor: 1, done: false });
    const p2 = toHost(interp.callHandler("applyRenamePage", [plan, 1, 1]));
    expect(p2).toEqual({ moved: 1, nextCursor: 2, done: true });
    expect(renames.length).toBe(2);

    interp.dispatchEvent("fs.change", { name: ".tmp", size: 10, flush: false });
    interp.dispatchEvent("fs.change", { name: "report.md", size: 2048, flush: true });
    expect(emitted.length).toBe(1);
    expect(emitted[0].name).toBe("watcher.summary");
    expect(emitted[0].payload.count).toBe(1);
    expect(emitted[0].payload.totalLabel).toBe("2 KB");
    expect(emitted[0].payload.names).toEqual(["report.md"]);
  });
});
