import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BytecodeCompiler } from "../../BytecodeCompiler";
import { SemanticAnalyzer } from "../../SemanticAnalyzer";
import { createVaultHost } from "../../examples/apps/pulsar-vault/host";
import { createVaultServer } from "../../examples/apps/pulsar-vault/server";

describe("Pulsar Vault E2E app suite (TS Interpreter + HTTP Host)", () => {
  const vaultDir = resolve(import.meta.dir, "../../examples/apps/pulsar-vault");

  test("manifest, module linker, compiler sourceMap, and registered handlers stay in sync", () => {
    const manifest = JSON.parse(readFileSync(resolve(vaultDir, "AppManifest.json"), "utf8")) as {
      id: string;
      ui: { entry: string };
      script: { handlers: Array<{ name: string; mode: string }> };
      permissions: { scopes: string[] };
    };
    expect(manifest.id).toBe("com.pulsaros.pulsar-vault");
    expect(manifest.ui.entry).toBe("ui/index.html");
    expect(manifest.permissions.scopes).toEqual(["fs.read", "fs.write", "kv", "events"]);

    const host = createVaultHost({ seedOnCreate: false });
    expect(host.linked.sources).toEqual(["main.puls", "format.puls", "index.puls", "storage.puls"]);

    const analyzer = new SemanticAnalyzer();
    analyzer.analyze(host.linked.statements);
    expect(analyzer.warnings).toEqual([]);

    const compiled = BytecodeCompiler.compile(host.linked.statements, host.linked.sources);
    expect(compiled.sources).toEqual(["main.puls", "format.puls", "index.puls", "storage.puls"]);
    expect(compiled.fileMap?.length).toBe(compiled.code.length);

    const declaredNames = manifest.script.handlers.map((h) => h.name).sort();
    expect(host.interp.handlerNames().sort()).toEqual(declaredNames);
    expect(host.interp.eventListenerNames()).toEqual(["fs.change"]);
  });

  test("seeds starter vault, persists notes with UTF-8 Base64 snapshots, sorts strings, filters tags, toggles tasks, paginates export, handles corrupt JSON, and reacts to fs.change", () => {
    const host = createVaultHost({ seedOnCreate: false });

    // 1. Seed starter notes + verify math telemetry + snapshots
    const init = host.callRpc<any>("initVault", {});
    expect(init.result.ok).toBe(true);
    expect(init.result.seeded).toBe(true);
    expect(init.result.lockIcon).toBe("\u{1F512}");
    expect(init.result.totalCount).toBe(4);
    expect(host.io.exists?.("index.json")).toBe(true);
    expect(host.io.exists?.("snapshots/latest.json")).toBe(true);
    expect(host.io.exists?.("snapshots/welcome-pulsar-vault.b64")).toBe(true);
    expect(init.result.stats.completionPct).toBeGreaterThanOrEqual(0);
    expect(init.result.stats.healthScore).toBeGreaterThan(0);
    expect(init.result.stats.telemetry.arcSin).toBeNumber();
    expect(init.result.stats.telemetry.balanceAngle).toBeGreaterThan(0);

    // 2. Save a new note containing UTF-8 emoji + inline tags + Markdown tasks
    const saved = host.callRpc<any>("saveNote", {
      note: {
        title: "Alpha Vault Spec \u{1F512}",
        kind: "task",
        folder: "specs",
        pinned: false,
        tags: ["alpha"],
        body: "Track #closures and #unicode\n- [ ] Verify UTF-8 Base64 snapshot\n- [x] Seed CoW index",
      },
    });
    expect(saved.result.ok).toBe(true);
    const createdNote = saved.result.savedNote;
    expect(createdNote.id).toMatch(/^pv-[a-z0-9-]+-\d+-001-\d{4}$/);
    expect(createdNote.tags).toEqual(["alpha", "closures", "unicode"]);
    expect(createdNote.tasks.length).toBe(2);

    const b64 = host.io.readFileBase64?.(`snapshots/${createdNote.id}.b64`);
    expect(typeof b64).toBe("string");
    const decodedJson = JSON.parse(Buffer.from(String(b64), "base64").toString("utf8")) as {
      title: string;
      id: string;
    };
    expect(decodedJson.id).toBe(createdNote.id);
    expect(decodedJson.title).toBe("Alpha Vault Spec \u{1F512}");

    // 3. String ordering (< / >) across non-pinned notes & CoW tag filters
    const asc = host.callRpc<any>("listNotes", { sortBy: "title_asc" });
    const unpinnedAsc = asc.result.notes.filter((n: any) => !n.pinned).map((n: any) => n.title);
    const desc = host.callRpc<any>("listNotes", { sortBy: "title_desc" });
    const unpinnedDesc = desc.result.notes.filter((n: any) => !n.pinned).map((n: any) => n.title);
    expect(unpinnedAsc).toEqual(["Alpha Vault Spec \u{1F512}", "CoW Tag Index & Closure Filter Snippet", "VM Budget & Telemetry Notes"]);
    expect(unpinnedDesc).toEqual([...unpinnedAsc].reverse());

    const closuresTag = host.callRpc<any>("listNotes", { tag: "closures" });
    expect(closuresTag.result.notes.map((n: any) => n.id)).toContain(createdNote.id);
    expect(closuresTag.result.notes.map((n: any) => n.id)).toContain("cow-closures-snippet");

    const searched = host.callRpc<any>("listNotes", { q: "Budget", kind: "note" });
    expect(searched.result.notes.length).toBe(1);
    expect(searched.result.notes[0].id).toBe("budget-telemetry-notes");

    // 4. Toggle task checkbox via toggleTask RPC & verify getNote
    const fetched = host.callRpc<any>("getNote", { id: createdNote.id });
    expect(fetched.result.ok).toBe(true);
    expect(fetched.result.note.summary.openTasks).toBe(1);

    const toggled = host.callRpc<any>("toggleTask", { id: createdNote.id, lineIndex: 1 });
    expect(toggled.result.ok).toBe(true);
    expect(toggled.result.toggledDone).toBe(true);
    expect(toggled.result.savedNote.summary.openTasks).toBe(0);
    expect(toggled.result.savedNote.summary.doneTasks).toBe(2);

    // 5. Preferences merge + objDelete via clearKeys + reset via kvDelete
    const prefsUpdated = host.callRpc<any>("savePrefs", {
      defaultKind: "task",
      pageSize: 2,
      experimentalFlag: "enabled",
    });
    expect(prefsUpdated.result.prefs.pageSize).toBe(2);
    expect(prefsUpdated.result.prefs.experimentalFlag).toBe("enabled");

    const prefsCleared = host.callRpc<any>("savePrefs", { clearKeys: ["experimentalFlag"] });
    expect("experimentalFlag" in prefsCleared.result.prefs).toBe(false);
    expect(prefsCleared.result.prefs.defaultKind).toBe("task");

    const prefsReset = host.callRpc<any>("savePrefs", { reset: true });
    expect(prefsReset.result.prefs.pageSize).toBe(4);
    expect(prefsReset.result.prefs.defaultKind).toBe("note");

    // 6. Cursor-paginated export in markdown, json, and base64
    const p1 = host.callRpc<any>("exportBundlePage", { format: "markdown", cursor: 0, pageSize: 3 });
    expect(p1.result.page).toBe(1);
    expect(p1.result.totalPages).toBe(2);
    expect(p1.result.done).toBe(false);
    expect(p1.result.signature).toBe("PV-01");
    expect(p1.result.content).toContain("# \u{1F512} Pulsar Vault Digest");
    expect(host.io.exists?.(p1.result.exportedPath)).toBe(true);

    const p2 = host.callRpc<any>("exportBundlePage", {
      format: "markdown",
      cursor: p1.result.nextCursor,
      pageSize: 3,
    });
    expect(p2.result.page).toBe(2);
    expect(p2.result.done).toBe(true);
    expect(p2.result.signature).toBe("PV-02");

    const b64Export = host.callRpc<any>("exportBundlePage", { format: "base64", cursor: 0, pageSize: 2 });
    const exportDecoded = JSON.parse(Buffer.from(b64Export.result.content, "base64").toString("utf8")) as {
      signature: string;
      notes: unknown[];
    };
    expect(exportDecoded.signature).toBe("PV-01");
    expect(exportDecoded.notes.length).toBe(2);

    // 7. Try/catch corrupt JSON quarantine + source-mapped call stack
    const injected = host.callRpc<any>("injectCorruptSample", {});
    expect(injected.result.corrupt.length).toBe(1);
    expect(injected.result.corrupt[0].file).toBe("notes/_corrupt_sample.json");
    const stackText = (injected.result.corrupt[0].stack as string[]).join("\n");
    expect(stackText).toContain("storage.puls");
    expect(stackText).toContain("main.puls");
    expect(injected.result.notes.length).toBe(5);

    const cleaned = host.callRpc<any>("clearCorruptSamples", {});
    expect(cleaned.result.corrupt.length).toBe(0);

    // 8. Delete custom note and verify tag bucket pruning
    const deleted = host.callRpc<any>("deleteNote", { id: createdNote.id });
    expect(deleted.result.deleted).toBe(true);
    expect("alpha" in deleted.result.tagIndex).toBe(false);
    expect(deleted.result.totalCount).toBe(4);

    // 9. External fs.change service event -> emit + notifyWindow
    const syncOut = host.simulateExternalSyncNote({
      title: "External Telemetry Sync",
      tags: ["external", "sync"],
    });
    expect(syncOut.emitted.length).toBe(2);
    expect(syncOut.emitted[0].channel).toBe("event");
    expect(syncOut.emitted[0].name).toBe("vault.sync");
    expect(syncOut.emitted[1].channel).toBe("window");
    expect(syncOut.emitted[1].name).toBe("vault.sync");

    const afterSync = host.callRpc<any>("listNotes", {});
    expect(afterSync.result.totalCount).toBe(5);
  });

  test("standalone Bun server exposes health, bundle info, files, RPC, and watch-event APIs", async () => {
    const server = createVaultServer(0);
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;

      const healthRes = await fetch(`${baseUrl}/api/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { ok: boolean; app: string };
      expect(health.ok).toBe(true);
      expect(health.app).toBe("com.pulsaros.pulsar-vault");

      const bundleRes = await fetch(`${baseUrl}/api/bundle-info`);
      const bundle = (await bundleRes.json()) as { bundleBytes: number; sources: string[] };
      expect(bundle.bundleBytes).toBeGreaterThan(0);
      expect(bundle.sources).toEqual(["main.puls", "format.puls", "index.puls", "storage.puls"]);

      const rpcRes = await fetch(`${baseUrl}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handler: "listNotes", payload: { sortBy: "title_asc" } }),
      });
      expect(rpcRes.status).toBe(200);
      const rpcJson = (await rpcRes.json()) as { ok: boolean; result: { totalCount: number } };
      expect(rpcJson.ok).toBe(true);
      expect(rpcJson.result.totalCount).toBe(4);

      const watchRes = await fetch(`${baseUrl}/api/watch-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Server SSE Check" }),
      });
      expect(watchRes.status).toBe(200);
      const watchJson = (await watchRes.json()) as { ok: boolean; emitted: Array<{ channel: string }> };
      expect(watchJson.ok).toBe(true);
      expect(watchJson.emitted.some((e) => e.channel === "window")).toBe(true);

      const filesRes = await fetch(`${baseUrl}/api/files`);
      const filesJson = (await filesRes.json()) as { files: Array<{ path: string }> };
      expect(filesJson.files.some((f) => f.path === "index.json")).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
