(function () {
  "use strict";

  const state = {
    mode: "http",
    workspace: null,
    selectedNote: null,
    isDraft: false,
    activeTab: "editor",
    filter: {
      q: "",
      tag: "",
      kind: "all",
      folder: "all",
      pinnedOnly: false,
      sortBy: "updated_desc",
    },
    exportState: {
      cursor: 0,
      nextCursor: null,
      done: true,
      page: 1,
      totalPages: 1,
      format: "markdown",
    },
    bundleInfo: null,
    filesSnapshot: [],
    liveEvents: [],
    copyTimer: null,
  };

  const el = {
    hostModeBadge: document.getElementById("hostModeBadge"),
    bundleMetaLine: document.getElementById("bundleMetaLine"),
    topHealthBadge: document.getElementById("topHealthBadge"),
    topTaskBadge: document.getElementById("topTaskBadge"),
    topQuotaBadge: document.getElementById("topQuotaBadge"),
    newNoteBtn: document.getElementById("newNoteBtn"),
    simulateSyncBtn: document.getElementById("simulateSyncBtn"),
    openExportBtn: document.getElementById("openExportBtn"),
    openPrefsBtn: document.getElementById("openPrefsBtn"),
    themeToggleBtn: document.getElementById("themeToggleBtn"),
    themeIcon: document.getElementById("themeIcon"),

    liveBanner: document.getElementById("liveBanner"),
    liveBannerText: document.getElementById("liveBannerText"),
    dismissBannerBtn: document.getElementById("dismissBannerBtn"),

    searchInput: document.getElementById("searchInput"),
    kindButtons: Array.from(document.querySelectorAll(".pill-btn[data-kind]")),
    sortSelect: document.getElementById("sortSelect"),
    pinnedFilterBtn: document.getElementById("pinnedFilterBtn"),
    tagTotalLabel: document.getElementById("tagTotalLabel"),
    clearTagBtn: document.getElementById("clearTagBtn"),
    tagCloud: document.getElementById("tagCloud"),
    notesCountLabel: document.getElementById("notesCountLabel"),
    noteList: document.getElementById("noteList"),
    noteListEmpty: document.getElementById("noteListEmpty"),

    tabButtons: [
      document.getElementById("tabEditor"),
      document.getElementById("tabPreview"),
      document.getElementById("tabTelemetry"),
    ],
    panels: {
      editor: document.getElementById("panelEditor"),
      preview: document.getElementById("panelPreview"),
      telemetry: document.getElementById("panelTelemetry"),
    },
    corruptBadge: document.getElementById("corruptBadge"),
    lastRpcBadge: document.getElementById("lastRpcBadge"),

    noteForm: document.getElementById("noteForm"),
    noteTitleInput: document.getElementById("noteTitleInput"),
    noteKindSelect: document.getElementById("noteKindSelect"),
    noteFolderInput: document.getElementById("noteFolderInput"),
    folderDatalist: document.getElementById("folderDatalist"),
    noteTagsInput: document.getElementById("noteTagsInput"),
    notePinnedCheck: document.getElementById("notePinnedCheck"),
    noteBodyInput: document.getElementById("noteBodyInput"),
    taskPaneSummary: document.getElementById("taskPaneSummary"),
    taskChecklist: document.getElementById("taskChecklist"),
    taskChecklistEmpty: document.getElementById("taskChecklistEmpty"),
    activeIdBadge: document.getElementById("activeIdBadge"),
    snapshotStatusBadge: document.getElementById("snapshotStatusBadge"),
    deleteNoteBtn: document.getElementById("deleteNoteBtn"),
    saveNoteBtn: document.getElementById("saveNoteBtn"),

    previewArticle: document.getElementById("previewArticle"),

    injectCorruptBtn: document.getElementById("injectCorruptBtn"),
    clearCorruptBtn: document.getElementById("clearCorruptBtn"),
    corruptList: document.getElementById("corruptList"),
    corruptEmpty: document.getElementById("corruptEmpty"),
    statsCards: document.getElementById("statsCards"),
    quotaProgress: document.getElementById("quotaProgress"),
    quotaText: document.getElementById("quotaText"),
    bundleSummaryGrid: document.getElementById("bundleSummaryGrid"),
    sandboxFilesList: document.getElementById("sandboxFilesList"),
    eventStreamList: document.getElementById("eventStreamList"),

    exportDialog: document.getElementById("exportDialog"),
    exportFormatSelect: document.getElementById("exportFormatSelect"),
    exportPageSizeInput: document.getElementById("exportPageSizeInput"),
    refreshExportBtn: document.getElementById("refreshExportBtn"),
    exportMetaText: document.getElementById("exportMetaText"),
    exportPathText: document.getElementById("exportPathText"),
    exportOutputText: document.getElementById("exportOutputText"),
    exportFirstBtn: document.getElementById("exportFirstBtn"),
    exportNextBtn: document.getElementById("exportNextBtn"),
    copyExportBtn: document.getElementById("copyExportBtn"),
    copyExportTip: document.getElementById("copyExportTip"),

    prefsDialog: document.getElementById("prefsDialog"),
    prefsForm: document.getElementById("prefsForm"),
    prefDefaultKindSelect: document.getElementById("prefDefaultKindSelect"),
    prefSortSelect: document.getElementById("prefSortSelect"),
    prefPageSizeInput: document.getElementById("prefPageSizeInput"),
    prefAutoSnapshotCheck: document.getElementById("prefAutoSnapshotCheck"),

    deleteDialog: document.getElementById("deleteDialog"),
    deleteDialogMessage: document.getElementById("deleteDialogMessage"),
  };

  // Dual-mode bridge: uses PulsarOS postMessage SDK when embedded in PulsarOS, otherwise standalone Bun HTTP host
  function hasPulsarSdk() {
    return typeof window.Pulsar === "object" && window.Pulsar !== null && typeof window.Pulsar.call === "function";
  }

  async function invokeScript(handler, payload) {
    if (hasPulsarSdk()) {
      state.mode = "pulsar-sdk";
      const start = performance.now();
      const result = await window.Pulsar.call("script.call", {
        handler: handler,
        args: [payload || {}],
      });
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      return {
        result: result,
        telemetry: { handler: handler, durationMs: durationMs },
      };
    }

    state.mode = "http";
    const resp = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handler: handler, payload: payload || {} }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || "RPC call failed: " + handler);
    }
    return data;
  }

  function showBanner(message) {
    el.liveBannerText.textContent = message;
    el.liveBanner.hidden = false;
  }

  function formatTelemetryLabel(telemetry) {
    if (!telemetry) return "Ready";
    return `${telemetry.handler} \u2022 ${telemetry.durationMs} ms`;
  }

  // Theme toggle following dark-mode-toggle rules (preserves system preference when matching OS)
  function getOsPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function isCurrentlyDark() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const content = meta ? meta.getAttribute("content") : "light dark";
    if (content === "dark") return true;
    if (content === "light") return false;
    return getOsPrefersDark();
  }

  function syncThemeButton() {
    const dark = isCurrentlyDark();
    el.themeToggleBtn.setAttribute("aria-pressed", dark ? "true" : "false");
    el.themeIcon.textContent = dark ? "\u2600" : "\u263E";
  }

  function toggleTheme() {
    const nextDark = !isCurrentlyDark();
    const nextMode = nextDark ? "dark" : "light";
    const osMode = getOsPrefersDark() ? "dark" : "light";
    const meta = document.querySelector('meta[name="color-scheme"]');

    try {
      if (nextMode === osMode) {
        localStorage.removeItem("pulsar-vault-theme");
        if (meta) meta.setAttribute("content", "light dark");
      } else {
        localStorage.setItem("pulsar-vault-theme", nextMode);
        if (meta) meta.setAttribute("content", nextMode);
      }
    } catch (_err) {
      if (meta) meta.setAttribute("content", nextMode);
    }
    syncThemeButton();
  }

  function parseTagInput(raw) {
    return raw
      .split(",")
      .map((s) => s.trim().replace(/^#/, "").toLowerCase())
      .filter((s, idx, arr) => s.length > 0 && arr.indexOf(s) === idx);
  }

  function setTab(tabName) {
    state.activeTab = tabName;
    const mapping = [
      { id: "editor", btn: el.tabButtons[0], panel: el.panels.editor },
      { id: "preview", btn: el.tabButtons[1], panel: el.panels.preview },
      { id: "telemetry", btn: el.tabButtons[2], panel: el.panels.telemetry },
    ];
    for (const item of mapping) {
      const active = item.id === tabName;
      item.btn.classList.toggle("is-active", active);
      item.btn.setAttribute("aria-selected", active ? "true" : "false");
      item.panel.hidden = !active;
    }
    if (tabName === "preview") {
      renderPreview();
    } else if (tabName === "telemetry") {
      refreshFilesSnapshot();
    }
  }

  function renderSidebar() {
    const ws = state.workspace;
    if (!ws) return;

    el.hostModeBadge.textContent = state.mode === "pulsar-sdk" ? "PulsarOS SDK" : "Live Mock Host";

    const stats = ws.stats || {};
    el.topHealthBadge.textContent = `Health ${stats.healthScore ?? "--"}`;
    el.topTaskBadge.textContent = `${stats.doneTasks ?? 0}/${stats.totalTasks ?? 0} tasks`;
    const kb = Math.max(0, Math.round(((stats.quotaUsedBytes || 0) / 1024) * 10) / 10);
    el.topQuotaBadge.textContent = `${kb} KB used`;

    for (const btn of el.kindButtons) {
      const active = btn.dataset.kind === state.filter.kind;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    el.pinnedFilterBtn.setAttribute("aria-pressed", state.filter.pinnedOnly ? "true" : "false");
    el.sortSelect.value = state.filter.sortBy;

    // Folder datalist suggestions
    el.folderDatalist.replaceChildren();
    for (const folder of ws.folders || []) {
      const opt = document.createElement("option");
      opt.value = folder;
      el.folderDatalist.appendChild(opt);
    }

    // Tag cloud
    const tags = ws.tags || [];
    const tagCounts = ws.tagCounts || {};
    el.tagTotalLabel.textContent = String(tags.length);
    el.clearTagBtn.hidden = !state.filter.tag;
    el.tagCloud.replaceChildren();
    for (const tag of tags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip" + (state.filter.tag === tag ? " is-active" : "");
      btn.textContent = `#${tag} (${tagCounts[tag] || 0})`;
      btn.setAttribute("aria-pressed", state.filter.tag === tag ? "true" : "false");
      btn.addEventListener("click", () => {
        state.filter.tag = state.filter.tag === tag ? "" : tag;
        refreshWorkspaceList();
      });
      el.tagCloud.appendChild(btn);
    }

    // Notes list
    const notes = ws.notes || [];
    el.notesCountLabel.textContent = `${notes.length}/${ws.totalCount ?? notes.length}`;
    el.noteList.replaceChildren();
    el.noteListEmpty.hidden = notes.length > 0;

    const activeId = state.selectedNote ? state.selectedNote.id : null;
    for (const item of notes) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "note-item-btn" + (!state.isDraft && activeId === item.id ? " is-active" : "");
      btn.dataset.noteId = item.id;

      const top = document.createElement("div");
      top.className = "note-item-top";

      const titleSpan = document.createElement("span");
      titleSpan.className = "note-item-title";
      titleSpan.textContent = (item.pinned ? "\u2605 " : "") + item.title;

      const kindSpan = document.createElement("span");
      kindSpan.className = "kind-badge";
      kindSpan.textContent = item.kind;

      top.append(titleSpan, kindSpan);

      const meta = document.createElement("div");
      meta.className = "note-item-meta";
      const taskText = item.taskCount > 0 ? `${item.doneTasks}/${item.taskCount} tasks` : `${item.wordCount} words`;
      meta.textContent = `${item.folder} \u2022 ${taskText} \u2022 ${item.readingMinutes}m read`;

      btn.append(top, meta);
      btn.addEventListener("click", () => selectNoteById(item.id));
      li.appendChild(btn);
      el.noteList.appendChild(li);
    }

    // Corrupt badge & quarantine list
    const corrupt = ws.corrupt || [];
    el.corruptBadge.hidden = corrupt.length === 0;
    el.corruptBadge.textContent = String(corrupt.length);
    renderTelemetry();
  }

  function renderEditor() {
    const note = state.selectedNote;
    if (!note) {
      el.noteTitleInput.value = "";
      el.noteKindSelect.value = state.workspace?.prefs?.defaultKind || "note";
      el.noteFolderInput.value = "inbox";
      el.noteTagsInput.value = "";
      el.notePinnedCheck.checked = false;
      el.noteBodyInput.value = "";
      el.activeIdBadge.textContent = "Draft (unsaved)";
      el.snapshotStatusBadge.textContent = "";
      el.deleteNoteBtn.hidden = true;
      renderChecklist([]);
      return;
    }

    el.noteTitleInput.value = note.title || "";
    el.noteKindSelect.value = note.kind || "note";
    el.noteFolderInput.value = note.folder || "inbox";
    el.noteTagsInput.value = Array.isArray(note.tags) ? note.tags.join(", ") : "";
    el.notePinnedCheck.checked = note.pinned === true;
    el.noteBodyInput.value = note.body || "";

    if (state.isDraft) {
      el.activeIdBadge.textContent = "New draft (ID assigned by PulsarScript closure on save)";
      el.snapshotStatusBadge.textContent = "";
      el.deleteNoteBtn.hidden = true;
    } else {
      el.activeIdBadge.textContent = `id: ${note.id} \u2022 rev ${note.revision || 1}`;
      el.snapshotStatusBadge.textContent = note.hasSnapshot ? "Base64 snapshot synced" : "";
      el.deleteNoteBtn.hidden = false;
    }

    renderChecklist(note.tasks || []);
    if (state.activeTab === "preview") {
      renderPreview();
    }
  }

  function renderChecklist(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const openCount = list.filter((t) => !t.done).length;
    el.taskPaneSummary.textContent = `${openCount} open / ${list.length} total`;
    el.taskChecklist.replaceChildren();
    el.taskChecklistEmpty.hidden = list.length > 0;

    for (const task of list) {
      const li = document.createElement("li");
      li.className = "task-row" + (task.done ? " is-done" : "");

      const checkboxId = `task-line-${task.lineIndex}`;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = checkboxId;
      cb.checked = task.done === true;
      cb.disabled = state.isDraft || !state.selectedNote;
      cb.addEventListener("change", () => {
        if (!state.isDraft && state.selectedNote) {
          handleToggleTask(state.selectedNote.id, task.lineIndex);
        }
      });

      const label = document.createElement("label");
      label.htmlFor = checkboxId;
      label.textContent = task.label;

      li.append(cb, label);
      el.taskChecklist.appendChild(li);
    }
  }

  function renderPreview() {
    const title = el.noteTitleInput.value.trim() || "Untitled Vault Entry";
    const kind = el.noteKindSelect.value;
    const folder = el.noteFolderInput.value.trim() || "inbox";
    const tags = parseTagInput(el.noteTagsInput.value);
    const body = el.noteBodyInput.value || "";

    el.previewArticle.replaceChildren();

    const header = document.createElement("div");
    header.className = "preview-header";

    const h2 = document.createElement("h2");
    h2.className = "preview-title";
    h2.textContent = title;

    const meta = document.createElement("p");
    meta.className = "mono-meta";
    const tagStr = tags.length > 0 ? tags.map((t) => "#" + t).join(" ") : "(no tags)";
    meta.textContent = `kind: ${kind} \u2022 folder: ${folder} \u2022 tags: ${tagStr}`;

    header.append(h2, meta);

    const pre = document.createElement("pre");
    pre.className = "preview-body";
    pre.textContent = body || "(empty body)";

    el.previewArticle.append(header, pre);
  }

  function renderTelemetry() {
    const ws = state.workspace;
    if (!ws) return;

    const corrupt = ws.corrupt || [];
    el.clearCorruptBtn.hidden = corrupt.length === 0;
    el.corruptEmpty.hidden = corrupt.length > 0;
    el.corruptList.replaceChildren();

    for (const item of corrupt) {
      const li = document.createElement("li");
      li.className = "corrupt-item";

      const head = document.createElement("div");
      head.className = "note-item-top";
      const fileEl = document.createElement("strong");
      fileEl.textContent = item.file || "unknown";
      const lineEl = document.createElement("span");
      lineEl.className = "mono-meta";
      lineEl.textContent = `kind=${item.kind || "runtime"} line=${item.line ?? "?"}`;
      head.append(fileEl, lineEl);

      const msgEl = document.createElement("p");
      msgEl.className = "hint-text";
      msgEl.textContent = item.message || "Malformed JSON";

      const stackPre = document.createElement("pre");
      stackPre.className = "corrupt-stack";
      stackPre.textContent = Array.isArray(item.stack) && item.stack.length > 0
        ? item.stack.join("\n")
        : "(no stack frames)";

      li.append(head, msgEl, stackPre);
      el.corruptList.appendChild(li);
    }

    const stats = ws.stats || {};
    const trig = stats.telemetry || {};
    const tiles = [
      { label: "Vault Health Score", value: `${stats.healthScore ?? 0}/100` },
      { label: "Task Completion", value: `${stats.completionPct ?? 0}%` },
      { label: "RMS Word Spread", value: String(stats.rmsWordSpread ?? 0) },
      { label: "Trig Arc (sin/atan2)", value: `${trig.arcSin ?? 0} / ${trig.balanceAngle ?? 0}` },
    ];
    el.statsCards.replaceChildren();
    for (const tile of tiles) {
      const box = document.createElement("div");
      box.className = "stat-tile";
      const valEl = document.createElement("span");
      valEl.className = "stat-value";
      valEl.textContent = tile.value;
      const lblEl = document.createElement("span");
      lblEl.className = "stat-label";
      lblEl.textContent = tile.label;
      box.append(valEl, lblEl);
      el.statsCards.appendChild(box);
    }

    const quotaPct = Math.max(0, Math.min(100, Number(stats.quotaPct || 0)));
    el.quotaProgress.value = quotaPct;
    el.quotaProgress.textContent = `${quotaPct}%`;
    const usedKb = Math.round(((stats.quotaUsedBytes || 0) / 1024) * 10) / 10;
    const maxKb = Math.round(((stats.quotaMaxBytes || 1048576) / 1024) * 10) / 10;
    el.quotaText.textContent = `${usedKb} / ${maxKb} KB (${quotaPct}%)`;

    if (state.bundleInfo) {
      const b = state.bundleInfo;
      el.bundleMetaLine.textContent = `${b.sources.length} modules \u2022 ${Math.round(b.bundleBytes / 1024)} KB bytecode \u2022 v1.2`;
      el.bundleSummaryGrid.replaceChildren();
      const summaryRows = [
        ["Linked Modules", b.sources.join(", ")],
        ["Registered Handlers", `${b.registeredHandlers.length} RPC + service`],
        ["Bytecode Ops", `${b.instructions} instr / ${b.sourceMapEntries} map`],
        ["Manifest Scopes", b.scopes.join(", ")],
      ];
      for (const [k, v] of summaryRows) {
        const card = document.createElement("div");
        card.className = "stat-tile";
        const lbl = document.createElement("span");
        lbl.className = "stat-label";
        lbl.textContent = k;
        const val = document.createElement("span");
        val.className = "mono-meta";
        val.textContent = v;
        card.append(lbl, val);
        el.bundleSummaryGrid.appendChild(card);
      }
    }

    el.sandboxFilesList.replaceChildren();
    for (const file of state.filesSnapshot.slice(0, 20)) {
      const li = document.createElement("li");
      li.className = "mono-row";
      const pathSpan = document.createElement("span");
      pathSpan.textContent = file.path;
      const metaSpan = document.createElement("span");
      metaSpan.textContent = `${file.size} B (${file.encoding})`;
      li.append(pathSpan, metaSpan);
      el.sandboxFilesList.appendChild(li);
    }

    el.eventStreamList.replaceChildren();
    if (state.liveEvents.length === 0) {
      const li = document.createElement("li");
      li.className = "mono-row";
      li.textContent = "Waiting for emit() or notifyWindow() events...";
      el.eventStreamList.appendChild(li);
    } else {
      for (const ev of state.liveEvents.slice().reverse().slice(0, 12)) {
        const li = document.createElement("li");
        li.className = "mono-row";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = `[${ev.channel}] ${ev.name}`;
        const detailSpan = document.createElement("span");
        detailSpan.textContent = typeof ev.payload === "object" && ev.payload !== null
          ? (ev.payload.path || ev.payload.id || "event")
          : String(ev.payload);
        li.append(nameSpan, detailSpan);
        el.eventStreamList.appendChild(li);
      }
    }
  }

  async function refreshFilesSnapshot() {
    if (hasPulsarSdk()) return;
    try {
      const resp = await fetch("/api/files");
      if (!resp.ok) return;
      const data = await resp.json();
      state.filesSnapshot = data.files || [];
      if (Array.isArray(data.events) && data.events.length > 0 && state.liveEvents.length === 0) {
        state.liveEvents = data.events;
      }
      renderTelemetry();
    } catch (_err) {}
  }

  async function refreshBundleInfo() {
    if (hasPulsarSdk()) return;
    try {
      const resp = await fetch("/api/bundle-info");
      if (!resp.ok) return;
      state.bundleInfo = await resp.json();
      renderTelemetry();
    } catch (_err) {}
  }

  async function refreshWorkspaceList() {
    const out = await invokeScript("listNotes", state.filter);
    state.workspace = out.result;
    el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
    renderSidebar();
    await refreshFilesSnapshot();
  }

  async function selectNoteById(id) {
    const out = await invokeScript("getNote", { id: id });
    el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
    if (out.result && out.result.ok && out.result.note) {
      state.selectedNote = out.result.note;
      state.isDraft = false;
      renderSidebar();
      renderEditor();
    }
  }

  function startNewDraft() {
    const defaultKind = state.workspace?.prefs?.defaultKind || "note";
    state.isDraft = true;
    state.selectedNote = {
      id: "",
      title: "",
      kind: defaultKind,
      folder: "inbox",
      tags: [],
      pinned: false,
      body: defaultKind === "task" ? "- [ ] First action item\n" : "",
      tasks: [],
    };
    renderSidebar();
    renderEditor();
    setTab("editor");
    el.noteTitleInput.focus();
  }

  async function handleSaveNote(event) {
    event.preventDefault();
    el.saveNoteBtn.disabled = true;
    try {
      const notePayload = {
        title: el.noteTitleInput.value.trim() || "Untitled Vault Entry",
        kind: el.noteKindSelect.value,
        folder: el.noteFolderInput.value.trim() || "inbox",
        tags: parseTagInput(el.noteTagsInput.value),
        pinned: el.notePinnedCheck.checked,
        body: el.noteBodyInput.value,
      };
      if (!state.isDraft && state.selectedNote && state.selectedNote.id) {
        notePayload.id = state.selectedNote.id;
      }

      const out = await invokeScript("saveNote", {
        note: notePayload,
        filter: state.filter,
      });
      state.workspace = out.result;
      if (out.result.savedNote) {
        state.selectedNote = out.result.savedNote;
        state.isDraft = false;
      }
      el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
      renderSidebar();
      renderEditor();
      await refreshFilesSnapshot();
    } catch (err) {
      showBanner(`Save failed: ${err.message}`);
    } finally {
      el.saveNoteBtn.disabled = false;
    }
  }

  async function handleToggleTask(noteId, lineIndex) {
    try {
      const out = await invokeScript("toggleTask", {
        id: noteId,
        lineIndex: lineIndex,
        filter: state.filter,
      });
      if (!out.result.ok) {
        showBanner(out.result.error || "Could not toggle task.");
        return;
      }
      state.workspace = out.result;
      if (out.result.savedNote) {
        state.selectedNote = out.result.savedNote;
      }
      el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
      renderSidebar();
      renderEditor();
    } catch (err) {
      showBanner(`Task toggle failed: ${err.message}`);
    }
  }

  async function handleDeleteConfirmed() {
    if (state.isDraft || !state.selectedNote) return;
    const id = state.selectedNote.id;
    const out = await invokeScript("deleteNote", {
      id: id,
      filter: state.filter,
    });
    state.workspace = out.result;
    el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);

    const remaining = out.result.notes || [];
    if (remaining.length > 0) {
      await selectNoteById(remaining[0].id);
    } else {
      startNewDraft();
    }
    await refreshFilesSnapshot();
  }

  async function loadExportPage(cursor) {
    const format = el.exportFormatSelect.value;
    const pageSize = Math.max(1, Math.min(12, Number(el.exportPageSizeInput.value) || 3));
    const out = await invokeScript("exportBundlePage", {
      format: format,
      cursor: cursor,
      pageSize: pageSize,
    });
    el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
    const res = out.result;
    state.exportState = {
      cursor: res.cursor || 0,
      nextCursor: res.nextCursor,
      done: Boolean(res.done),
      page: res.page || 1,
      totalPages: res.totalPages || 1,
      format: format,
    };
    el.exportMetaText.textContent = `${res.signature || "PV"} \u2022 Page ${res.page} of ${res.totalPages} (${res.noteCount} entries on page, ${res.totalNotes} total)`;
    el.exportPathText.textContent = res.exportedPath ? `Saved to ${res.exportedPath}` : "";
    el.exportOutputText.value = res.content || "";
    el.exportFirstBtn.disabled = res.page <= 1;
    el.exportNextBtn.disabled = Boolean(res.done) || res.nextCursor == null;
    await refreshFilesSnapshot();
  }

  async function handleSimulateSync() {
    el.simulateSyncBtn.disabled = true;
    try {
      if (hasPulsarSdk()) {
        await invokeScript("listNotes", state.filter);
        showBanner("PulsarOS runtime active: awaiting real host fs.change event.");
      } else {
        const resp = await fetch("/api/watch-event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `Watcher Sync Note (${new Date().toLocaleTimeString()})`,
            tags: ["sync", "watcher", "events"],
          }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || "Sync trigger failed");
        }
        let sawWindowNotify = false;
        if (Array.isArray(data.emitted)) {
          for (const ev of data.emitted) {
            if (ev.channel === "window") sawWindowNotify = true;
            pushLiveEvent(ev);
          }
        }
        el.lastRpcBadge.textContent = formatTelemetryLabel(data.telemetry);
        if (!sawWindowNotify) {
          showBanner(`fs.change handled \u2192 synced "${data.note?.title || data.path}"`);
        }
        await refreshWorkspaceList();
      }
    } catch (err) {
      showBanner(`Watcher error: ${err.message}`);
    } finally {
      el.simulateSyncBtn.disabled = false;
    }
  }

  function pushLiveEvent(ev) {
    if (!ev) return;
    if (state.liveEvents.some((item) => item.id && item.id === ev.id)) return;
    state.liveEvents.push(ev);
    if (state.liveEvents.length > 50) {
      state.liveEvents.splice(0, state.liveEvents.length - 50);
    }
    if (ev.channel === "window" && ev.payload && ev.payload.type === "vault.sync") {
      showBanner(`Live notifyWindow: ${ev.payload.path} synced (${ev.payload.totalCount} total notes, health ${ev.payload.healthScore})`);
    }
    renderTelemetry();
  }

  function subscribeLiveEvents() {
    if (hasPulsarSdk() && typeof window.Pulsar.onEvent === "function") {
      window.Pulsar.onEvent("script.event", (payload) => {
        pushLiveEvent({ id: Date.now(), channel: "window", name: "vault.sync", payload: payload });
        refreshWorkspaceList();
      });
      return;
    }
    if (typeof EventSource === "function") {
      const es = new EventSource("/api/events");
      es.addEventListener("script.event", (e) => {
        try {
          const ev = JSON.parse(e.data);
          pushLiveEvent(ev);
          refreshWorkspaceList();
        } catch (_err) {}
      });
      es.addEventListener("host.event", (e) => {
        try {
          pushLiveEvent(JSON.parse(e.data));
        } catch (_err) {}
      });
      window.addEventListener("pagehide", () => {
        es.close();
      });
    }
  }

  function openPrefsDialog() {
    const prefs = state.workspace?.prefs || {};
    el.prefDefaultKindSelect.value = prefs.defaultKind || "note";
    el.prefSortSelect.value = prefs.sortBy || "updated_desc";
    el.prefPageSizeInput.value = String(prefs.pageSize || 4);
    el.prefAutoSnapshotCheck.checked = prefs.autoSnapshot !== false;
    el.prefsDialog.showModal();
  }

  function bindEvents() {
    el.themeToggleBtn.addEventListener("click", toggleTheme);
    el.dismissBannerBtn.addEventListener("click", () => {
      el.liveBanner.hidden = true;
    });

    el.newNoteBtn.addEventListener("click", startNewDraft);
    el.simulateSyncBtn.addEventListener("click", handleSimulateSync);
    el.noteForm.addEventListener("submit", handleSaveNote);

    el.searchInput.addEventListener("input", () => {
      state.filter.q = el.searchInput.value;
      refreshWorkspaceList();
    });
    el.searchInput.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        state.filter.q = el.searchInput.value;
        refreshWorkspaceList();
      }
    });

    for (const btn of el.kindButtons) {
      btn.addEventListener("click", () => {
        state.filter.kind = btn.dataset.kind || "all";
        refreshWorkspaceList();
      });
    }

    el.sortSelect.addEventListener("change", () => {
      state.filter.sortBy = el.sortSelect.value;
      refreshWorkspaceList();
    });

    el.pinnedFilterBtn.addEventListener("click", () => {
      state.filter.pinnedOnly = !state.filter.pinnedOnly;
      refreshWorkspaceList();
    });

    el.clearTagBtn.addEventListener("click", () => {
      state.filter.tag = "";
      refreshWorkspaceList();
    });

    el.tabButtons[0].addEventListener("click", () => setTab("editor"));
    el.tabButtons[1].addEventListener("click", () => setTab("preview"));
    el.tabButtons[2].addEventListener("click", () => setTab("telemetry"));

    for (const closeBtn of document.querySelectorAll("[data-close-dialog]")) {
      closeBtn.addEventListener("click", () => {
        const dlg = closeBtn.closest("dialog");
        if (dlg && dlg.open) {
          dlg.close("cancel");
        }
      });
    }

    el.openExportBtn.addEventListener("click", async () => {
      el.exportPageSizeInput.value = String(state.workspace?.prefs?.pageSize || 3);
      await loadExportPage(0);
      el.exportDialog.showModal();
    });
    el.refreshExportBtn.addEventListener("click", () => loadExportPage(0));
    el.exportFormatSelect.addEventListener("change", () => loadExportPage(0));
    el.exportFirstBtn.addEventListener("click", () => loadExportPage(0));
    el.exportNextBtn.addEventListener("click", () => {
      if (state.exportState.nextCursor != null) {
        loadExportPage(state.exportState.nextCursor);
      }
    });
    el.exportDialog.addEventListener("close", () => {
      el.exportDialog.returnValue = "";
    });

    el.copyExportBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(el.exportOutputText.value);
        el.copyExportTip.classList.add("is-visible");
        clearTimeout(state.copyTimer);
        state.copyTimer = setTimeout(() => {
          el.copyExportTip.classList.remove("is-visible");
        }, 1600);
      } catch (_err) {
        el.exportOutputText.select();
      }
    });

    el.openPrefsBtn.addEventListener("click", openPrefsDialog);
    el.prefsDialog.addEventListener("close", async () => {
      const action = el.prefsDialog.returnValue;
      el.prefsDialog.returnValue = "";
      if (action === "save") {
        const out = await invokeScript("savePrefs", {
          defaultKind: el.prefDefaultKindSelect.value,
          sortBy: el.prefSortSelect.value,
          pageSize: Math.max(1, Math.min(12, Number(el.prefPageSizeInput.value) || 4)),
          autoSnapshot: el.prefAutoSnapshotCheck.checked,
        });
        state.workspace = out.result;
        state.filter.sortBy = out.result.prefs.sortBy;
        el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
        await refreshWorkspaceList();
        showBanner("Preferences merged & persisted to PulsarOS kvSet.");
      } else if (action === "reset") {
        const out = await invokeScript("savePrefs", { reset: true });
        state.workspace = out.result;
        state.filter.sortBy = out.result.prefs.sortBy;
        el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
        await refreshWorkspaceList();
        showBanner("KV preferences deleted and reset to defaults via kvDelete.");
      }
    });

    el.deleteNoteBtn.addEventListener("click", () => {
      if (!state.selectedNote || state.isDraft) return;
      el.deleteDialogMessage.textContent = `Delete "${state.selectedNote.title}" (${state.selectedNote.id})? This removes its JSON file and Base64 snapshot.`;
      el.deleteDialog.showModal();
    });
    el.deleteDialog.addEventListener("close", () => {
      const action = el.deleteDialog.returnValue;
      el.deleteDialog.returnValue = "";
      if (action === "confirm") {
        handleDeleteConfirmed();
      }
    });

    el.injectCorruptBtn.addEventListener("click", async () => {
      const out = await invokeScript("injectCorruptSample", state.filter);
      state.workspace = out.result;
      el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
      renderSidebar();
      await refreshFilesSnapshot();
      showBanner("Corrupt JSON quarantined via try/catch — multi-file stack trace captured in Sandbox & Telemetry.");
    });

    el.clearCorruptBtn.addEventListener("click", async () => {
      const out = await invokeScript("clearCorruptSamples", state.filter);
      state.workspace = out.result;
      el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
      renderSidebar();
      await refreshFilesSnapshot();
      showBanner("Quarantined corrupt sample files removed.");
    });
  }

  async function init() {
    syncThemeButton();
    bindEvents();
    subscribeLiveEvents();
    await refreshBundleInfo();

    const out = await invokeScript("initVault", {});
    state.workspace = out.result;
    if (out.result.prefs && out.result.prefs.sortBy) {
      state.filter.sortBy = out.result.prefs.sortBy;
    }
    el.lastRpcBadge.textContent = formatTelemetryLabel(out.telemetry);
    renderSidebar();

    const notes = out.result.notes || [];
    if (notes.length > 0) {
      await selectNoteById(notes[0].id);
    } else {
      startNewDraft();
    }
    await refreshFilesSnapshot();
  }

  init().catch((err) => {
    showBanner(`Initialization error: ${err.message}`);
  });
})();
