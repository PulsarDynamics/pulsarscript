(function () {
  "use strict";

  var STORAGE_KEY = "color-scheme";
  var COPY_RESET_MS = 2000;
  var LIVE_DEBOUNCE_MS = 300;

  var KEYWORDS = new Set([
    "var", "const", "function", "return", "if", "else", "while", "for",
    "break", "continue", "print", "try", "catch", "true", "false", "nil",
    "import", "export", "of", "from", "as"
  ]);

  var BUILTIN_NAMES = new Set();

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlightPulsar(source) {
    var tokenRe =
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b0[xX][0-9a-fA-F]+\b|\b(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
    var out = [];
    var last = 0;
    var match;

    while ((match = tokenRe.exec(source)) !== null) {
      if (match.index > last) {
        out.push(escapeHtml(source.slice(last, match.index)));
      }
      var tok = match[0];
      if (tok.startsWith("//") || tok.startsWith("/*")) {
        out.push('<span class="tok-cmt">' + escapeHtml(tok) + "</span>");
      } else if (tok.startsWith('"') || tok.startsWith("`")) {
        out.push('<span class="tok-str">' + escapeHtml(tok) + "</span>");
      } else if (/^(?:0[xX]|\d|\.)/.test(tok)) {
        out.push('<span class="tok-num">' + escapeHtml(tok) + "</span>");
      } else if (KEYWORDS.has(tok)) {
        out.push('<span class="tok-kw">' + escapeHtml(tok) + "</span>");
      } else if (BUILTIN_NAMES.has(tok)) {
        out.push('<span class="tok-fn">' + escapeHtml(tok) + "</span>");
      } else {
        out.push(escapeHtml(tok));
      }
      last = tokenRe.lastIndex;
    }

    if (last < source.length) {
      out.push(escapeHtml(source.slice(last)));
    }
    return out.join("");
  }

  function countLines(source) {
    return source === "" ? 1 : String(source).split(/\r?\n/).length;
  }

  function renderNumberedHighlighted(source) {
    var highlighted = highlightPulsar(source);
    var rawLines = highlighted.split("\n");
    var openSpan = null;
    return rawLines
      .map(function (line) {
        var prefix = openSpan ? '<span class="' + openSpan + '">' : "";
        var re = /<span class="([^"]+)">|<\/span>/g;
        var m;
        while ((m = re.exec(line)) !== null) {
          openSpan = m[1] ? m[1] : null;
        }
        var suffix = openSpan ? "</span>" : "";
        return '<span class="code-line">' + prefix + line + suffix + "</span>";
      })
      .join("");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return Math.max(0, Math.round(bytes || 0)) + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
  }

  function stageLabel(stage) {
    switch (stage) {
      case "ok":
        return "OK";
      case "memory":
        return "MEMORY CAGE";
      case "budget":
        return "STEP / TIME BUDGET";
      case "capability":
        return "CAPABILITY DENIED";
      case "parse":
        return "SYNTAX ERROR";
      case "semantic":
        return "SEMANTIC ERROR";
      default:
        return "RUNTIME ERROR";
    }
  }

  // --- 1. Color scheme toggle (dark-mode-toggle guide) ---
  function initColorSchemeToggle() {
    var meta = document.querySelector('meta[name="color-scheme"]');
    var button = document.getElementById("theme-toggle");
    if (!meta || !button) return;

    var mql = window.matchMedia("(prefers-color-scheme: dark)");

    function getStored() {
      try {
        var val = localStorage.getItem(STORAGE_KEY);
        return val === "light" || val === "dark" ? val : null;
      } catch (_err) {
        return null;
      }
    }

    function applyScheme(value) {
      meta.setAttribute("content", value === "light" || value === "dark" ? value : "light dark");
    }

    applyScheme(getStored());

    button.addEventListener("click", function () {
      var stored = getStored();
      var systemScheme = mql.matches ? "dark" : "light";
      var rendered = stored || systemScheme;
      var target = rendered === "dark" ? "light" : "dark";

      if (target === systemScheme) {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch (_err) {
          // Ignore storage restrictions; still update the active meta content.
        }
        applyScheme(null);
      } else {
        try {
          localStorage.setItem(STORAGE_KEY, target);
        } catch (_err) {
          // Ignore storage restrictions; still update the active meta content.
        }
        applyScheme(target);
      }
    });

    window.addEventListener("storage", function (event) {
      if (event.key === STORAGE_KEY) {
        applyScheme(getStored());
      }
    });
  }

  // --- 2. Responsive Navbar (navbar guide) ---
  function initNavbar() {
    var header = document.getElementById("site-header");
    var inner = document.getElementById("header-inner");
    var menu = document.getElementById("site-menu");
    if (!header || !inner || !menu) return;

    var lastCollapsedWidth = 0;

    function syncNavLayout() {
      var wasOpen = false;
      try {
        wasOpen = menu.hasAttribute("popover") && menu.matches(":popover-open");
      } catch (_err) {
        wasOpen = false;
      }

      header.classList.add("is-measuring");
      header.classList.add("is-wide");
      menu.removeAttribute("popover");

      var wide = inner.scrollWidth <= inner.clientWidth;

      if (wide) {
        header.classList.add("is-wide");
        menu.removeAttribute("popover");
        lastCollapsedWidth = 0;
      } else {
        header.classList.remove("is-wide");
        menu.setAttribute("popover", "auto");
        lastCollapsedWidth = header.getBoundingClientRect().width;
        if (wasOpen && typeof menu.showPopover === "function") {
          try {
            menu.showPopover();
          } catch (_err) {
            // Popover may already be transitioning or unsupported.
          }
        }
      }

      requestAnimationFrame(function () {
        header.classList.remove("is-measuring");
      });
    }

    syncNavLayout();

    if (typeof ResizeObserver === "function") {
      var ro = new ResizeObserver(function () {
        var width = header.getBoundingClientRect().width;
        if (header.classList.contains("is-wide") || width > lastCollapsedWidth) {
          syncNavLayout();
        }
      });
      ro.observe(header);
      ro.observe(menu);
    } else {
      window.addEventListener("resize", syncNavLayout);
    }

    menu.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var link = target.closest("a[href]");
      if (!link) return;

      for (var item of menu.querySelectorAll("a[aria-current]")) {
        item.removeAttribute("aria-current");
      }
      link.setAttribute("aria-current", "location");

      if (!header.classList.contains("is-wide") && typeof menu.hidePopover === "function") {
        try {
          if (menu.matches(":popover-open")) menu.hidePopover();
        } catch (_err) {
          // Ignore when native :popover-open is unavailable.
        }
      }
    });
  }

  // --- 3. Hero Quick-Try Interactive Runner ---
  function initHeroRunner(data, runtime, studioBridge) {
    var codeEl = document.getElementById("hero-code-preview");
    var outputEl = document.getElementById("hero-output");
    var statusPill = document.getElementById("hero-status-pill");
    var linesPill = document.getElementById("hero-lines-pill");
    var stepsPill = document.getElementById("hero-steps-pill");
    var timePill = document.getElementById("hero-time-pill");
    var runBtn = document.getElementById("hero-run-btn");
    var studioLink = document.getElementById("hero-open-studio");
    var presetBtns = Array.from(document.querySelectorAll("[data-hero-preset]"));

    if (!codeEl || !outputEl || !presetBtns.length) return;

    var HERO_SNIPPETS = {
      closures:
        'function makeCounter(start, step) {\n' +
        '  var value = start;\n' +
        '  return function() {\n' +
        '    var current = value;\n' +
        '    value += step;\n' +
        '    return current;\n' +
        '  };\n' +
        '}\n\n' +
        'var nextId = makeCounter(100, 10);\n' +
        'var ids = arrayMap([0, 0, 0], function(_) {\n' +
        '  return nextId();\n' +
        '});\n' +
        'print("ids: " + jsonStringify(ids));',
      cow:
        'var state = { tags: ["rpc"], count: 1 };\n' +
        'var snap = state; // D15 snapshot preserved\n\n' +
        'state.tags[len(state.tags)] = "cow";\n' +
        'state.count = 42;\n\n' +
        'print("snap:  " + jsonStringify(snap));\n' +
        'print("state: " + jsonStringify(state));',
      cage:
        '// Even try/catch cannot bypass a budget\n' +
        'try {\n' +
        '  var blob = "pulsar-";\n' +
        '  for (var i = 0; i < 40; i += 1) {\n' +
        '    blob = blob + blob;\n' +
        '  }\n' +
        '} catch (e) {\n' +
        '  print("caught: " + e.message);\n' +
        '}'
    };

    var activePreset = "closures";

    function renderHeroOutput(res) {
      var label = "$ pulsar run · live browser runtime";
      var body = res.ok
        ? res.output
        : (res.output ? res.output + "\n" : "") + (res.error || "Execution stopped");

      outputEl.dataset.stage = res.stage;
      outputEl.innerHTML = '<span class="output-label">' + escapeHtml(label) + "</span>" + escapeHtml(body);

      if (statusPill) statusPill.textContent = "Status: " + stageLabel(res.stage);
      if (stepsPill) stepsPill.textContent = "Steps: " + res.stats.steps;
      if (timePill) timePill.textContent = res.stats.durationMs + " ms";
    }

    function runHeroPreset() {
      var src = HERO_SNIPPETS[activePreset] || HERO_SNIPPETS.closures;
      var lineCount = countLines(src);
      codeEl.innerHTML = "<code>" + renderNumberedHighlighted(src) + "</code>";
      if (linesPill) linesPill.textContent = lineCount + (lineCount === 1 ? " line" : " lines");

      if (runtime && typeof runtime.compileAndRun === "function") {
        var res = runtime.compileAndRun(src, {
          maxSteps: 50000,
          timeoutMs: 500,
          maxStringBytes: 262144,
          maxMemoryBytes: 2097152
        });
        renderHeroOutput(res);
        return;
      }

      if (data && Array.isArray(data.examples)) {
        var fallbackEx = data.examples.find(function (e) {
          return e.id === activePreset;
        });
        if (fallbackEx) {
          outputEl.dataset.stage = activePreset === "cage" ? "memory" : "ok";
          outputEl.innerHTML =
            '<span class="output-label">$ pulsar run · verified output</span>' + escapeHtml(fallbackEx.output);
        }
      }
    }

    presetBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        activePreset = btn.dataset.heroPreset || "closures";
        presetBtns.forEach(function (b) {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        runHeroPreset();
      });
    });

    if (runBtn) {
      runBtn.addEventListener("click", runHeroPreset);
    }

    if (studioLink && studioBridge) {
      studioLink.addEventListener("click", function () {
        studioBridge.selectPreset(activePreset, HERO_SNIPPETS[activePreset]);
      });
    }

    runHeroPreset();
  }

  // --- 4. Lazy Go WASM VM Loader & Live Interactive Script Studio (#playground) ---
  var STUDIO_DRAFT_KEY = "pulsarscript-studio-draft";
  var wasmLoadPromise = null;

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-wasm-support="' + src + '"]');
      if (existing) {
        if (typeof globalThis.Go === "function") {
          resolve();
          return;
        }
        existing.addEventListener("load", function () { resolve(); }, { once: true });
        existing.addEventListener("error", function () { reject(new Error("Failed to load " + src)); }, { once: true });
        return;
      }
      var el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.setAttribute("data-wasm-support", src);
      el.addEventListener("load", function () { resolve(); }, { once: true });
      el.addEventListener("error", function () { reject(new Error("Failed to load " + src)); }, { once: true });
      document.head.appendChild(el);
    });
  }

  function loadWasmVM(engineBadge) {
    if (globalThis.PulsarWasmVM) {
      if (engineBadge) {
        engineBadge.textContent = "Engine: Go VM · WebAssembly (" + globalThis.PulsarWasmVM.version + ")";
        engineBadge.dataset.ready = "true";
      }
      return Promise.resolve(globalThis.PulsarWasmVM);
    }
    if (wasmLoadPromise) return wasmLoadPromise;

    if (engineBadge) {
      engineBadge.textContent = "Engine: Go VM · WebAssembly (loading…)";
      engineBadge.dataset.ready = "false";
    }

    wasmLoadPromise = (async function () {
      try {
        if (typeof globalThis.Go !== "function") {
          await loadScriptOnce("./wasm_exec.js");
        }
        if (typeof globalThis.Go !== "function") {
          throw new Error("Go WASM runtime support unavailable");
        }
        var go = new globalThis.Go();
        var instantiated;
        if (typeof WebAssembly.instantiateStreaming === "function") {
          try {
            instantiated = await WebAssembly.instantiateStreaming(fetch("./pulsarvm.wasm"), go.importObject);
          } catch (_streamErr) {
            var res = await fetch("./pulsarvm.wasm");
            if (!res.ok) throw new Error("Failed to fetch pulsarvm.wasm: HTTP " + res.status);
            instantiated = await WebAssembly.instantiate(await res.arrayBuffer(), go.importObject);
          }
        } else {
          var res2 = await fetch("./pulsarvm.wasm");
          if (!res2.ok) throw new Error("Failed to fetch pulsarvm.wasm: HTTP " + res2.status);
          instantiated = await WebAssembly.instantiate(await res2.arrayBuffer(), go.importObject);
        }

        // Go's wasm main() intentionally blocks forever via select{}; do not await go.run().
        go.run(instantiated.instance);

        var started = performance.now();
        while (!globalThis.PulsarWasmVM && performance.now() - started < 3000) {
          await new Promise(function (r) { setTimeout(r, 10); });
        }
        if (!globalThis.PulsarWasmVM) {
          throw new Error("PulsarWasmVM did not initialize in time");
        }
        if (engineBadge) {
          engineBadge.textContent = "Engine: Go VM · WebAssembly (" + globalThis.PulsarWasmVM.version + ")";
          engineBadge.dataset.ready = "true";
        }
        return globalThis.PulsarWasmVM;
      } catch (err) {
        wasmLoadPromise = null;
        if (engineBadge) {
          engineBadge.textContent = "Engine: JS Fallback (WASM unavailable)";
          engineBadge.dataset.ready = "false";
        }
        void err;
        return null;
      }
    })();

    return wasmLoadPromise;
  }

  function initStudio(data, runtime, tabsController) {
    var presetBtns = Array.from(document.querySelectorAll("#studio-presets [data-preset]"));
    var capBtns = Array.from(document.querySelectorAll("[data-cap-toggle]"));
    var titleEl = document.getElementById("studio-title");
    var summaryEl = document.getElementById("studio-summary");
    var fileLabelEl = document.getElementById("studio-file-label");
    var engineBadge = document.getElementById("studio-engine-badge");
    var lintPill = document.getElementById("studio-lint-pill");
    var lineCountEl = document.getElementById("studio-line-count");
    var gutterEl = document.getElementById("studio-gutter");
    var gutterInnerEl = document.getElementById("studio-gutter-inner");
    var editorEl = document.getElementById("sandbox-code");
    var runBtn = document.getElementById("studio-run-btn");
    var debugToolbarBtn = document.getElementById("studio-debug-btn");
    var fmtBtn = document.getElementById("studio-fmt-btn");
    var lintBtn = document.getElementById("studio-lint-btn");
    var resetBtn = document.getElementById("studio-reset-btn");
    var stageBadge = document.getElementById("studio-stage-badge");
    var outputEl = document.getElementById("studio-output");
    var stepsText = document.getElementById("studio-steps-text");
    var stepsBar = document.getElementById("studio-steps-bar");
    var timeText = document.getElementById("studio-time-text");
    var timeBar = document.getElementById("studio-time-bar");
    var memText = document.getElementById("studio-mem-text");
    var memBar = document.getElementById("studio-mem-bar");
    var liveStatus = document.getElementById("studio-live-status");
    var bcMetaEl = document.getElementById("studio-bc-meta");
    var disasmEl = document.getElementById("studio-disasm");

    var lintSummaryEl = document.getElementById("studio-lint-summary");
    var lintListEl = document.getElementById("studio-lint-list");
    var mockCallsEl = document.getElementById("studio-mock-calls");

    var bpInput = document.getElementById("debug-breakpoints");
    var dbgStartBtn = document.getElementById("debug-start-btn");
    var dbgContBtn = document.getElementById("debug-continue-btn");
    var dbgOverBtn = document.getElementById("debug-over-btn");
    var dbgInBtn = document.getElementById("debug-in-btn");
    var dbgOutBtn = document.getElementById("debug-out-btn");
    var dbgStopBtn = document.getElementById("debug-stop-btn");
    var dbgStateText = document.getElementById("debug-state-text");
    var dbgPausedBadge = document.getElementById("debug-paused-badge");
    var dbgStackEl = document.getElementById("debug-stack");
    var dbgLocalsEl = document.getElementById("debug-locals");
    var dbgGlobalsEl = document.getElementById("debug-globals");

    if (!editorEl || !outputEl || !disasmEl || !data || !Array.isArray(data.examples)) {
      return null;
    }

    var examplesById = new Map();
    data.examples.forEach(function (ex) {
      examplesById.set(ex.id, ex);
    });

    var activePresetId = "closures";
    var activeDebugId = null;
    var activeWasmRef = null;
    var pausedDebugLine = null;
    var lastGutterKey = "";
    var debugBusy = false;
    var caps = {
      "fs.read": true,
      "fs.write": true,
      kv: true,
      events: true
    };

    function activateStudioTab(tabId) {
      if (tabsController && typeof tabsController.activateTab === "function") {
        tabsController.activateTab("studio", tabId);
      }
    }

    function syncCapButtons() {
      capBtns.forEach(function (btn) {
        var name = btn.dataset.capToggle;
        var enabled = name ? caps[name] !== false : true;
        btn.setAttribute("aria-pressed", enabled ? "true" : "false");
        var stateSpan = btn.querySelector(".cap-state");
        if (stateSpan) stateSpan.textContent = enabled ? "ON" : "OFF";
      });
    }

    function setDebugButtonsEnabled(paused) {
      if (dbgContBtn) dbgContBtn.disabled = !paused;
      if (dbgOverBtn) dbgOverBtn.disabled = !paused;
      if (dbgInBtn) dbgInBtn.disabled = !paused;
      if (dbgOutBtn) dbgOutBtn.disabled = !paused;
      if (dbgStopBtn) dbgStopBtn.disabled = activeDebugId === null;
    }

    function syncStudioGutter() {
      var src = editorEl.value;
      var total = countLines(src);
      var bps = parseBreakpoints();
      var bpSet = new Set(bps.map(function (b) { return b.line; }));

      if (lineCountEl) {
        var caretPos = typeof editorEl.selectionStart === "number" ? editorEl.selectionStart : 0;
        var prefixLines = src.slice(0, caretPos).split(/\r?\n/);
        var curLine = prefixLines.length;
        var curCol = prefixLines[prefixLines.length - 1].length + 1;
        lineCountEl.textContent =
          total + (total === 1 ? " line" : " lines") + " · Ln " + curLine + ", Col " + curCol;
      }

      if (gutterEl && gutterInnerEl) {
        if (editorEl.clientHeight > 0) {
          gutterEl.style.height = editorEl.clientHeight + "px";
        }
        gutterInnerEl.style.transform = "translateY(" + (-editorEl.scrollTop) + "px)";

        var bpKey = Array.from(bpSet).sort(function (a, b) { return a - b; }).join(",");
        var nextKey = total + "|" + bpKey + "|" + (pausedDebugLine || 0);
        if (nextKey !== lastGutterKey) {
          lastGutterKey = nextKey;
          var html = [];
          for (var lineNum = 1; lineNum <= total; lineNum++) {
            var isBp = bpSet.has(lineNum);
            var isActive = pausedDebugLine === lineNum;
            var cls = "gutter-line" + (isBp ? " is-bp" : "") + (isActive ? " is-active-line" : "");
            html.push(
              '<button type="button" class="' +
                cls +
                '" data-line="' +
                lineNum +
                '" title="Toggle breakpoint at line ' +
                lineNum +
                '" aria-pressed="' +
                (isBp ? "true" : "false") +
                '">' +
                lineNum +
                "</button>"
            );
          }
          gutterInnerEl.innerHTML = html.join("");
        }
      }
    }

    function disposeDebugSession() {
      if (activeDebugId !== null && activeWasmRef && typeof activeWasmRef.debugDispose === "function") {
        try {
          activeWasmRef.debugDispose(activeDebugId);
        } catch (_err) {
          // Ignore disposal failures.
        }
      }
      activeDebugId = null;
      pausedDebugLine = null;
      if (dbgPausedBadge) dbgPausedBadge.hidden = true;
      setDebugButtonsEnabled(false);
      syncStudioGutter();
    }

    function renderVarTable(rows, emptyText, isFrames) {
      if (!rows || !rows.length) {
        return "<p>" + escapeHtml(emptyText) + "</p>";
      }
      if (isFrames) {
        return (
          '<table class="debug-table"><thead><tr><th>#</th><th>Function</th><th>Location</th><th>IP</th></tr></thead><tbody>' +
          rows
            .map(function (f) {
              return (
                "<tr><td>" +
                escapeHtml(f.index) +
                "</td><td>" +
                escapeHtml(f.name) +
                "</td><td>" +
                escapeHtml((f.file || "sandbox.puls") + ":" + f.line) +
                "</td><td>" +
                escapeHtml(f.ip) +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table>"
        );
      }
      return (
        '<table class="debug-table"><thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead><tbody>' +
        rows
          .map(function (v) {
            return (
              "<tr><td><code>" +
              escapeHtml(v.name) +
              "</code></td><td>" +
              escapeHtml(v.type) +
              "</td><td><code>" +
              escapeHtml(v.value) +
              "</code></td></tr>"
            );
          })
          .join("") +
        "</tbody></table>"
      );
    }

    function updateTelemetryMeters(stats, stage) {
      var maxSteps = (stats && stats.maxSteps) || 50000;
      var steps = (stats && stats.steps) || 0;
      if (stepsText) {
        stepsText.textContent = steps.toLocaleString() + " / " + maxSteps.toLocaleString();
      }
      if (stepsBar) {
        stepsBar.max = maxSteps;
        stepsBar.value = Math.min(steps, maxSteps);
        stepsBar.dataset.danger = stage === "budget" ? "true" : "false";
      }

      var maxDur = (stats && stats.maxDurationMs) || 500;
      var dur = (stats && stats.durationMs) || 0;
      if (timeText) {
        timeText.textContent = dur.toFixed(1) + " ms / " + maxDur + " ms";
      }
      if (timeBar) {
        timeBar.max = maxDur;
        timeBar.value = Math.min(dur, maxDur);
        timeBar.dataset.danger = stage === "budget" ? "true" : "false";
      }

      var maxMem = (stats && stats.maxMemoryBytes) || 2097152;
      var mem = (stats && stats.memBytes) || 0;
      if (memText) {
        memText.textContent = formatBytes(mem) + " / " + formatBytes(maxMem);
      }
      if (memBar) {
        memBar.max = maxMem;
        memBar.value = Math.min(mem, maxMem);
        memBar.dataset.danger = stage === "memory" ? "true" : "false";
      }
    }

    function renderMockHostCalls(calls, deniedCalls) {
      if (!mockCallsEl) return;
      var items = [];
      if (Array.isArray(calls)) {
        for (var i = 0; i < calls.length; i++) {
          var c = calls[i];
          var capLabel = c.capability ? "[" + c.capability + "]" : "[core]";
          items.push(
            '<li class="lint-item"><strong>MOCK</strong> ' +
              escapeHtml(capLabel) +
              " <code>" +
              escapeHtml(c.name) +
              "(" +
              escapeHtml(JSON.stringify(c.args || [])) +
              ")</code> &rarr; <code>" +
              escapeHtml(JSON.stringify(c.result)) +
              "</code></li>",
          );
        }
      }
      if (Array.isArray(deniedCalls)) {
        for (var j = 0; j < deniedCalls.length; j++) {
          items.push(
            '<li class="lint-item" data-severity="error"><strong>DENIED</strong> ' +
              escapeHtml(deniedCalls[j]) +
              "</li>",
          );
        }
      }
      mockCallsEl.innerHTML = items.length ? items.join("") : "<li>No mock host calls recorded in this run.</li>";
    }

    function runLintCheck(switchToTab) {
      if (!runtime || typeof runtime.lintSource !== "function") return;
      var res = runtime.lintSource(editorEl.value, caps);
      var total = res.diagnostics.length;
      if (lintPill) {
        lintPill.textContent =
          total === 0 ? "Lint: 0 issues" : "Lint: " + res.errors + " err · " + res.warnings + " warn";
        lintPill.className = res.errors > 0 ? "badge badge-cap" : "badge badge-core";
      }
      if (lintSummaryEl) {
        lintSummaryEl.textContent =
          total === 0
            ? "No lint issues found against active capability toggles."
            : res.errors + " error(s), " + res.warnings + " warning(s) reported by PulsarScript linter:";
      }
      if (lintListEl) {
        lintListEl.innerHTML = total
          ? res.diagnostics
              .map(function (d) {
                return (
                  '<li class="lint-item" data-severity="' +
                  escapeHtml(d.severity) +
                  '"><strong>' +
                  escapeHtml(d.severity.toUpperCase()) +
                  "</strong> Line " +
                  escapeHtml(d.line) +
                  ":" +
                  escapeHtml(d.column) +
                  " [" +
                  escapeHtml(d.rule) +
                  "] — " +
                  escapeHtml(d.message) +
                  "</li>"
                );
              })
              .join("")
          : '<li class="lint-item">All clear: no unused variables, shadowing, unknown host calls, or scope mismatches.</li>';
      }
      if (switchToTab) {
        activateStudioTab("studio-tab-lint");
      }
    }

    function applyResultToUI(res, metaText) {
      if (stageBadge) {
        stageBadge.textContent = stageLabel(res.stage);
        stageBadge.dataset.ok = res.ok ? "true" : "false";
      }

      var lines = [];
      if (res.output) lines.push(res.output);
      if (res.events && res.events.length > 0) {
        for (var i = 0; i < res.events.length; i++) {
          lines.push("[event emitted] " + res.events[i]);
        }
      }
      if (res.error) {
        lines.push(res.error);
      }
      if (res.deniedCalls && res.deniedCalls.length > 0) {
        lines.push("Blocked calls: " + res.deniedCalls.join(", "));
      }

      var outputText = lines.join("\n") || "(Program completed cleanly with no printed output.)";
      outputEl.dataset.stage = res.stage;
      outputEl.innerHTML = '<span class="output-label">Stdout / Host Result</span>' + escapeHtml(outputText);

      updateTelemetryMeters(res.stats, res.stage);
      renderMockHostCalls(res.mockHostCalls || [], res.deniedCalls || []);

      if (res.disassembly) {
        disasmEl.innerHTML = "<code>" + escapeHtml(res.disassembly) + "</code>";
      }
      if (bcMetaEl) {
        bcMetaEl.textContent =
          metaText ||
          res.stats.opcodes +
            " words · " +
            res.stats.constants +
            " constants · " +
            res.stats.functions +
            " fn · " +
            Number(res.stats.durationMs || 0).toFixed(1) +
            " ms";
      }

      if (liveStatus) {
        liveStatus.textContent =
          "Run finished: " +
          stageLabel(res.stage) +
          ", " +
          (res.stats.steps || 0) +
          " steps, " +
          res.stats.opcodes +
          " bytecode words.";
      }
    }

    function applyDebugResponse(res) {
      if (!res || !res.snapshot) {
        if (dbgStateText) {
          dbgStateText.textContent = (res && res.error) || "Debugger error.";
        }
        return;
      }

      var snap = res.snapshot;
      var isPaused = !snap.halted;

      if (dbgPausedBadge) {
        dbgPausedBadge.hidden = !isPaused;
      }
      if (dbgStateText) {
        if (snap.halted) {
          dbgStateText.textContent = snap.error
            ? "Halted with error at line " + snap.line + ": " + snap.error
            : "Execution completed (" + snap.steps + " steps).";
        } else {
          dbgStateText.textContent =
            "Paused (" +
            snap.reason +
            ") at " +
            (snap.file || "sandbox.puls") +
            ":" +
            snap.line +
            " · IP " +
            snap.ip +
            (snap.opcode ? " · " + snap.opcode : "");
        }
      }

      if (dbgStackEl) {
        dbgStackEl.innerHTML = renderVarTable(snap.frames || [], "No active stack frames.", true);
      }
      if (dbgLocalsEl) {
        var topFrame = snap.frames && snap.frames.length ? snap.frames[0] : null;
        var combined = [];
        if (topFrame && Array.isArray(topFrame.locals)) {
          combined = combined.concat(topFrame.locals);
        }
        if (topFrame && Array.isArray(topFrame.upvalues)) {
          combined = combined.concat(
            topFrame.upvalues.map(function (u) {
              return { name: u.name + " (upvalue)", type: u.type, value: u.value };
            }),
          );
        }
        dbgLocalsEl.innerHTML = renderVarTable(combined, "No locals in current frame.", false);
      }
      if (dbgGlobalsEl) {
        dbgGlobalsEl.innerHTML = renderVarTable(snap.globals || [], "No user globals yet.", false);
      }

      updateTelemetryMeters(
        {
          steps: snap.steps,
          maxSteps: snap.maxSteps,
          durationMs: snap.elapsedMs,
          maxDurationMs: snap.maxDurationMs,
          memBytes: snap.memBytes,
          maxMemoryBytes: snap.maxMemoryBytes
        },
        snap.error ? "runtime" : "ok",
      );

      var outText = res.output || (res.prints && res.prints.join("\n")) || "(Running in debugger…)";
      outputEl.dataset.stage = snap.error ? "runtime" : "ok";
      outputEl.innerHTML = '<span class="output-label">Debugger Stdout</span>' + escapeHtml(outText);
      renderMockHostCalls(res.mockHostCalls || [], res.deniedCalls || []);

      if (snap.halted) {
        pausedDebugLine = null;
        disposeDebugSession();
      } else {
        pausedDebugLine = snap.line || null;
        setDebugButtonsEnabled(true);
        syncStudioGutter();
      }
    }

    function parseBreakpoints() {
      var raw = bpInput ? bpInput.value : "";
      var nums = raw
        .split(/[\s,;]+/)
        .map(function (s) {
          return Number.parseInt(s.trim(), 10);
        })
        .filter(function (n) {
          return Number.isInteger(n) && n > 0;
        });
      var unique = Array.from(new Set(nums));
      return unique.map(function (line) {
        return { line: line };
      });
    }

    async function executeEditorCode() {
      disposeDebugSession();
      runLintCheck(false);
      var src = editorEl.value;
      var wasm = await loadWasmVM(engineBadge);

      if (wasm && runtime && typeof runtime.compileForWasm === "function") {
        var compiled = runtime.compileForWasm(src);
        if (!compiled.ok || !compiled.bytecodeJson) {
          applyResultToUI({
            ok: false,
            stage: compiled.stage,
            output: "",
            error: compiled.error || "Compilation failed",
            disassembly: "",
            events: [],
            deniedCalls: [],
            mockHostCalls: [],
            stats: {
              steps: 0,
              maxSteps: 50000,
              memBytes: 0,
              maxMemoryBytes: 2097152,
              durationMs: 0,
              maxDurationMs: 500,
              opcodes: 0,
              constants: 0,
              functions: 0
            }
          });
          return;
        }

        var vmDisasm = compiled.disassembly;
        try {
          var disParsed = JSON.parse(wasm.disassemble(compiled.bytecodeJson));
          if (disParsed && disParsed.ok && disParsed.text) {
            vmDisasm = disParsed.text;
          }
        } catch (_err) {
          // Keep compiler disassembly on fallback.
        }

        var rawResp = await wasm.runAsync(
          compiled.bytecodeJson,
          JSON.stringify({
            mockHost: true,
            seedMockFS: true,
            capabilities: {
              "fs.read": caps["fs.read"],
              "fs.write": caps["fs.write"],
              kv: caps.kv,
              events: caps.events
            },
            autoResumeYield: true,
            maxSteps: 50000,
            maxDurationMs: 500,
            maxStringBytes: 262144,
            maxMemoryBytes: 2097152
          }),
        );
        var wasmRes = JSON.parse(rawResp);
        var outLines = (wasmRes.prints && wasmRes.prints.length)
          ? wasmRes.prints.slice()
          : (wasmRes.output ? [wasmRes.output] : []);
        if (Array.isArray(wasmRes.handlers)) {
          for (var h = 0; h < wasmRes.handlers.length; h++) {
            outLines.push("[registerHandler] " + wasmRes.handlers[h]);
          }
        }
        if (Array.isArray(wasmRes.eventListeners)) {
          for (var el = 0; el < wasmRes.eventListeners.length; el++) {
            outLines.push('[on("' + wasmRes.eventListeners[el] + '")] listener registered');
          }
        }

        applyResultToUI({
          ok: Boolean(wasmRes.ok),
          stage: wasmRes.stage || (wasmRes.ok ? "ok" : "runtime"),
          output: outLines.join("\n"),
          error: wasmRes.error || null,
          disassembly: vmDisasm,
          events: wasmRes.events || [],
          deniedCalls: wasmRes.deniedCalls || [],
          mockHostCalls: wasmRes.mockHostCalls || [],
          stats: {
            steps: (wasmRes.stats && wasmRes.stats.steps) || 0,
            maxSteps: (wasmRes.stats && wasmRes.stats.maxSteps) || 50000,
            memBytes: (wasmRes.stats && wasmRes.stats.memBytes) || 0,
            maxMemoryBytes: (wasmRes.stats && wasmRes.stats.maxMemoryBytes) || 2097152,
            durationMs: (wasmRes.stats && wasmRes.stats.durationMs) || 0,
            maxDurationMs: (wasmRes.stats && wasmRes.stats.maxDurationMs) || 500,
            opcodes: compiled.stats.opcodes,
            constants: compiled.stats.constants,
            functions: compiled.stats.functions
          }
        });
        return;
      }

      if (!runtime || typeof runtime.compileAndRun !== "function") return;
      var jsRes = runtime.compileAndRun(src, {
        capabilities: {
          "fs.read": caps["fs.read"],
          "fs.write": caps["fs.write"],
          kv: caps.kv,
          events: caps.events
        },
        maxSteps: 50000,
        timeoutMs: 500,
        maxStringBytes: 262144,
        maxMemoryBytes: 2097152
      });
      applyResultToUI(jsRes);
    }

    async function startDebugSession() {
      if (debugBusy) return;
      debugBusy = true;
      disposeDebugSession();
      activateStudioTab("studio-tab-debug");

      try {
        var wasm = await loadWasmVM(engineBadge);
        if (!wasm || !runtime || typeof runtime.compileForWasm !== "function") {
          if (dbgStateText) {
            dbgStateText.textContent = "Debugger requires Go VM on WebAssembly (serve over HTTP with `bun run site`).";
          }
          return;
        }

        var compiled = runtime.compileForWasm(editorEl.value);
        if (!compiled.ok || !compiled.bytecodeJson) {
          applyResultToUI({
            ok: false,
            stage: compiled.stage,
            output: "",
            error: compiled.error || "Compilation failed",
            disassembly: "",
            events: [],
            deniedCalls: [],
            mockHostCalls: [],
            stats: {
              steps: 0,
              maxSteps: 50000,
              memBytes: 0,
              maxMemoryBytes: 2097152,
              durationMs: 0,
              maxDurationMs: 500,
              opcodes: 0,
              constants: 0,
              functions: 0
            }
          });
          if (dbgStateText) dbgStateText.textContent = compiled.error || "Compilation failed.";
          return;
        }

        disasmEl.innerHTML = "<code>" + escapeHtml(compiled.disassembly) + "</code>";
        if (bcMetaEl) {
          bcMetaEl.textContent =
            compiled.stats.opcodes +
            " words · " +
            compiled.stats.constants +
            " constants · " +
            compiled.stats.functions +
            " fn · debug locals";
        }

        var created = JSON.parse(
          wasm.createDebugSession(
            compiled.bytecodeJson,
            JSON.stringify({
              mockHost: true,
              seedMockFS: true,
              capabilities: {
                "fs.read": caps["fs.read"],
                "fs.write": caps["fs.write"],
                kv: caps.kv,
                events: caps.events
              },
              maxSteps: 50000,
              maxDurationMs: 500,
              maxStringBytes: 262144,
              maxMemoryBytes: 2097152
            }),
          ),
        );
        if (!created.ok || created.sessionId === undefined) {
          if (dbgStateText) dbgStateText.textContent = created.error || "Failed to create debug session.";
          return;
        }

        activeWasmRef = wasm;
        activeDebugId = created.sessionId;
        var bps = parseBreakpoints();
        wasm.debugSetBreakpoints(activeDebugId, JSON.stringify(bps));

        var stepRaw = bps.length > 0
          ? await wasm.debugContinue(activeDebugId)
          : await wasm.debugStepIn(activeDebugId);
        applyDebugResponse(JSON.parse(stepRaw));
      } finally {
        debugBusy = false;
      }
    }

    async function runDebugCommand(action) {
      if (debugBusy || activeDebugId === null || !activeWasmRef) return;
      debugBusy = true;
      try {
        if (action === "continue") {
          activeWasmRef.debugSetBreakpoints(activeDebugId, JSON.stringify(parseBreakpoints()));
        }
        var raw =
          action === "continue"
            ? await activeWasmRef.debugContinue(activeDebugId)
            : action === "over"
              ? await activeWasmRef.debugStepOver(activeDebugId)
              : action === "in"
                ? await activeWasmRef.debugStepIn(activeDebugId)
                : await activeWasmRef.debugStepOut(activeDebugId);
        applyDebugResponse(JSON.parse(raw));
      } finally {
        debugBusy = false;
      }
    }

    function renderInitialPresetFromData(ex, overrideCode) {
      if (titleEl) titleEl.textContent = ex.title;
      if (summaryEl) summaryEl.textContent = ex.summary;
      if (fileLabelEl) {
        fileLabelEl.textContent = ex.multiFile
          ? "file-manager-reference.puls + file-manager-utils.puls (pre-linked bundle)"
          : "sandbox.puls (editable · Cmd/Ctrl+Enter)";
      }
      editorEl.value = typeof overrideCode === "string" ? overrideCode : ex.source;
      syncStudioGutter();
      runLintCheck(false);

      applyResultToUI(
        {
          ok: true,
          stage: "ok",
          output: ex.output,
          error: null,
          disassembly: ex.disassembly,
          events: [],
          deniedCalls: [],
          mockHostCalls: [],
          stats: {
            steps: ex.multiFile ? 133 : 17,
            maxSteps: ex.multiFile ? 250000 : 50000,
            memBytes: ex.multiFile ? 4096 : 256,
            maxMemoryBytes: ex.multiFile ? 16777216 : 2097152,
            durationMs: 0.3,
            maxDurationMs: 500,
            opcodes: ex.stats.opcodes,
            constants: ex.stats.constants,
            functions: ex.stats.functions
          }
        },
        ex.stats.opcodes +
          " words · " +
          ex.stats.constants +
          " constants · " +
          ex.stats.functions +
          " fn" +
          (ex.multiFile ? " · " + ex.stats.sources.join(" + ") : ""),
      );
    }

    function selectPreset(id, overrideCode, skipWasm) {
      disposeDebugSession();
      var ex = examplesById.get(id) || data.examples[0];
      if (!ex) return;
      activePresetId = ex.id;

      presetBtns.forEach(function (btn) {
        var active = btn.dataset.preset === activePresetId;
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        if (active) {
          try {
            btn.scrollIntoView({ block: "nearest", inline: "nearest", container: "nearest" });
          } catch (_err) {
            // Safe skip if unsupported.
          }
        }
      });

      if (skipWasm || (ex.multiFile && typeof overrideCode !== "string")) {
        renderInitialPresetFromData(ex, overrideCode);
        return;
      }

      if (titleEl) titleEl.textContent = ex.title;
      if (summaryEl) summaryEl.textContent = ex.summary;
      if (fileLabelEl) {
        fileLabelEl.textContent = "sandbox.puls (editable · Cmd/Ctrl+Enter)";
      }
      editorEl.value = typeof overrideCode === "string" ? overrideCode : ex.source;
      syncStudioGutter();
      executeEditorCode();
    }

    presetBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectPreset(btn.dataset.preset || "closures");
      });
    });

    capBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var name = btn.dataset.capToggle;
        if (!name) return;
        caps[name] = !(caps[name] !== false);
        syncCapButtons();
        runLintCheck(false);
        if (activePresetId !== "modules") {
          executeEditorCode();
        }
      });
    });

    if (runBtn) {
      runBtn.addEventListener("click", function () {
        activateStudioTab("studio-tab-output");
        executeEditorCode();
      });
    }
    if (debugToolbarBtn) debugToolbarBtn.addEventListener("click", startDebugSession);
    if (dbgStartBtn) dbgStartBtn.addEventListener("click", startDebugSession);
    if (dbgContBtn) dbgContBtn.addEventListener("click", function () { runDebugCommand("continue"); });
    if (dbgOverBtn) dbgOverBtn.addEventListener("click", function () { runDebugCommand("over"); });
    if (dbgInBtn) dbgInBtn.addEventListener("click", function () { runDebugCommand("in"); });
    if (dbgOutBtn) dbgOutBtn.addEventListener("click", function () { runDebugCommand("out"); });
    if (dbgStopBtn) {
      dbgStopBtn.addEventListener("click", function () {
        disposeDebugSession();
        if (dbgStateText) dbgStateText.textContent = "Debugger stopped.";
      });
    }

    if (fmtBtn) {
      fmtBtn.addEventListener("click", function () {
        if (!runtime || typeof runtime.formatSource !== "function") return;
        var res = runtime.formatSource(editorEl.value);
        if (res.ok) {
          editorEl.value = res.formatted;
          syncStudioGutter();
          runLintCheck(false);
          if (liveStatus) {
            liveStatus.textContent = res.changed ? "Formatted PulsarScript source." : "Source already formatted.";
          }
        } else if (liveStatus) {
          liveStatus.textContent = "Format error: " + res.error;
        }
      });
    }

    if (lintBtn) {
      lintBtn.addEventListener("click", function () {
        runLintCheck(true);
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        caps["fs.read"] = true;
        caps["fs.write"] = true;
        caps.kv = true;
        caps.events = true;
        syncCapButtons();
        selectPreset(activePresetId);
      });
    }

    editorEl.addEventListener("keydown", function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        activateStudioTab("studio-tab-output");
        executeEditorCode();
      }
    });

    editorEl.addEventListener("input", syncStudioGutter);
    editorEl.addEventListener("scroll", function () {
      if (gutterInnerEl) {
        gutterInnerEl.style.transform = "translateY(" + (-editorEl.scrollTop) + "px)";
      }
    });
    editorEl.addEventListener("keyup", syncStudioGutter);
    editorEl.addEventListener("click", syncStudioGutter);
    if (bpInput) {
      bpInput.addEventListener("input", syncStudioGutter);
    }
    if (gutterEl) {
      gutterEl.addEventListener("click", function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var btn = target.closest(".gutter-line");
        if (!btn) return;
        var line = Number(btn.getAttribute("data-line"));
        if (!Number.isInteger(line) || line <= 0) return;

        var current = new Set(parseBreakpoints().map(function (b) { return b.line; }));
        if (current.has(line)) {
          current.delete(line);
        } else {
          current.add(line);
        }
        var sorted = Array.from(current).sort(function (a, b) { return a - b; });
        if (bpInput) {
          bpInput.value = sorted.join(", ");
        }
        syncStudioGutter();
        if (activeDebugId !== null && activeWasmRef && typeof activeWasmRef.debugSetBreakpoints === "function") {
          activeWasmRef.debugSetBreakpoints(
            activeDebugId,
            JSON.stringify(sorted.map(function (ln) { return { line: ln }; }))
          );
        }
      });
    }
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(syncStudioGutter).observe(editorEl);
    }

    syncCapButtons();

    var draft = null;
    try {
      var rawDraft = sessionStorage.getItem(STUDIO_DRAFT_KEY);
      if (rawDraft) {
        draft = JSON.parse(rawDraft);
        sessionStorage.removeItem(STUDIO_DRAFT_KEY);
      }
    } catch (_err) {
      draft = null;
    }

    if (draft && typeof draft.code === "string") {
      if (titleEl) titleEl.textContent = draft.title || "Loaded from Docs";
      if (summaryEl) summaryEl.textContent = "Loaded directly from PulsarScript Developer Documentation.";
      editorEl.value = draft.code;
      syncStudioGutter();
      executeEditorCode();
    } else {
      selectPreset("closures", undefined, true);
    }

    return { selectPreset: selectPreset };
  }

  // --- 5. Accessible Tabs (tabs guide — Quickstart & Studio inspector) ---
  function initTabs() {
    var widgets = document.querySelectorAll(".tabs[data-tabs]");
    var activators = new Map();

    widgets.forEach(function (widget) {
      var tabKey = widget.getAttribute("data-tabs") || "";
      var tablist = widget.querySelector(".tablist");
      if (!tablist) return;
      var tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
      var panels = tabs.map(function (tab) {
        return widget.querySelector('[role="tabpanel"][aria-labelledby="' + CSS.escape(tab.id) + '"]');
      });

      function activate(nextTab, moveFocus) {
        var idx = tabs.indexOf(nextTab);
        if (idx < 0) return;

        for (var i = 0; i < tabs.length; i++) {
          var tab = tabs[i];
          var panel = panels[i];
          var selected = i === idx;
          tab.setAttribute("aria-selected", selected ? "true" : "false");
          tab.toggleAttribute("focusgroupstart", selected);
          tab.tabIndex = selected ? 0 : -1;

          if (panel) {
            panel.hidden = selected ? false : "until-found";
            panel.removeAttribute("tabindex");
          }
        }

        if (moveFocus) nextTab.focus();

        try {
          nextTab.scrollIntoView({ block: "nearest", inline: "nearest", container: "nearest" });
        } catch (_err) {
          nextTab.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }

      if (tabKey) {
        activators.set(tabKey, function (tabId) {
          var target = tabs.find(function (t) { return t.id === tabId; });
          if (target) activate(target, false);
        });
      }

      tablist.addEventListener("click", function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var tab = target.closest('[role="tab"]');
        if (tab && tabs.includes(tab)) activate(tab, false);
      });

      tablist.addEventListener("keydown", function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var current = target.closest('[role="tab"]');
        if (!current) return;
        var idx = tabs.indexOf(current);
        if (idx < 0) return;

        var isRtl = getComputedStyle(tablist).direction === "rtl";
        var nextIdx = idx;
        if (event.key === "ArrowRight") {
          nextIdx = isRtl ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
        } else if (event.key === "ArrowLeft") {
          nextIdx = isRtl ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
        } else if (event.key === "Home") {
          nextIdx = 0;
        } else if (event.key === "End") {
          nextIdx = tabs.length - 1;
        } else {
          return;
        }

        event.preventDefault();
        activate(tabs[nextIdx], true);
      });

      panels.forEach(function (panel, idx) {
        if (!panel) return;
        panel.addEventListener("beforematch", function () {
          activate(tabs[idx], false);
        });
      });

      if (typeof CSS !== "undefined" && !CSS.supports("animation-timeline", "scroll()") && tabs.length > 1) {
        var first = tabs[0];
        var last = tabs[tabs.length - 1];
        var fadeObs = new IntersectionObserver(
          function (entries) {
            for (var i = 0; i < entries.length; i++) {
              var entry = entries[i];
              if (entry.target === first) {
                tablist.classList.toggle("more-start", entry.intersectionRatio < 1);
              } else if (entry.target === last) {
                tablist.classList.toggle("more-end", entry.intersectionRatio < 1);
              }
            }
          },
          { root: tablist, threshold: 1, rootMargin: "1px" }
        );
        fadeObs.observe(first);
        fadeObs.observe(last);
      }
    });

    return {
      activateTab: function (tabKey, tabId) {
        var fn = activators.get(tabKey);
        if (fn) fn(tabId);
      }
    };
  }

  // --- 6. Standard Library & Host API Explorer ---
  function initApiExplorer(data) {
    if (!data || !Array.isArray(data.functions)) return;

    var functions = data.functions;
    var tbody = document.getElementById("api-table-body");
    var searchInput = document.getElementById("api-search");
    var visibleCount = document.getElementById("api-visible-count");
    var liveStatus = document.getElementById("api-live-status");
    var resetBtn = document.getElementById("api-reset-btn");
    var emptyState = document.getElementById("api-empty-state");
    var emptyReset = document.getElementById("api-empty-reset");
    var providerBtns = Array.from(document.querySelectorAll("[data-provider]"));
    var capBtns = Array.from(document.querySelectorAll("[data-cap]"));

    if (!tbody || !searchInput || !visibleCount) return;

    var state = {
      query: "",
      provider: "all",
      capability: "all"
    };
    var liveTimer = 0;

    function syncFilterButtons() {
      providerBtns.forEach(function (btn) {
        btn.setAttribute("aria-pressed", btn.dataset.provider === state.provider ? "true" : "false");
      });
      capBtns.forEach(function (btn) {
        btn.setAttribute("aria-pressed", btn.dataset.cap === state.capability ? "true" : "false");
      });
    }

    function renderRows() {
      var q = state.query.trim().toLowerCase();
      var matches = functions.filter(function (fn) {
        if (state.provider !== "all" && fn.provider !== state.provider) return false;
        if (state.capability !== "all" && fn.capability !== state.capability) return false;
        if (!q) return true;
        return (
          fn.name.toLowerCase().includes(q) ||
          fn.signature.toLowerCase().includes(q) ||
          fn.category.toLowerCase().includes(q) ||
          (fn.capability && fn.capability.toLowerCase().includes(q)) ||
          fn.returns.toLowerCase().includes(q) ||
          fn.doc.toLowerCase().includes(q)
        );
      });

      var frag = document.createDocumentFragment();
      for (var i = 0; i < matches.length; i++) {
        var fn = matches[i];
        var tr = document.createElement("tr");

        var th = document.createElement("th");
        th.scope = "row";
        var sigCode = document.createElement("code");
        sigCode.textContent = fn.signature;
        th.appendChild(sigCode);
        tr.appendChild(th);

        var tdCat = document.createElement("td");
        tdCat.dataset.label = "Category";
        tdCat.textContent = fn.category;
        tr.appendChild(tdCat);

        var tdAccess = document.createElement("td");
        tdAccess.dataset.label = "Access";
        var badge = document.createElement("span");
        if (fn.provider === "core") {
          badge.className = "badge badge-core";
          badge.textContent = "core";
        } else {
          badge.className = "badge badge-cap";
          badge.textContent = fn.capability || "host";
        }
        tdAccess.appendChild(badge);
        tr.appendChild(tdAccess);

        var tdRet = document.createElement("td");
        tdRet.dataset.label = "Returns";
        var retCode = document.createElement("code");
        retCode.textContent = fn.returns;
        tdRet.appendChild(retCode);
        tr.appendChild(tdRet);

        var tdDoc = document.createElement("td");
        tdDoc.dataset.label = "Behavior";
        tdDoc.textContent = fn.doc;
        tr.appendChild(tdDoc);

        frag.appendChild(tr);
      }

      tbody.replaceChildren(frag);

      var summaryText = "Showing " + matches.length + " of " + functions.length + " functions";
      visibleCount.textContent = summaryText;
      var hasActiveFilter = Boolean(q || state.provider !== "all" || state.capability !== "all");
      if (resetBtn) resetBtn.hidden = !hasActiveFilter;
      if (emptyState) emptyState.hidden = matches.length > 0;

      if (liveStatus) {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(function () {
          liveStatus.textContent = summaryText;
        }, LIVE_DEBOUNCE_MS);
      }
    }

    function resetFilters() {
      state.query = "";
      state.provider = "all";
      state.capability = "all";
      searchInput.value = "";
      syncFilterButtons();
      renderRows();
    }

    searchInput.addEventListener("input", function () {
      state.query = searchInput.value;
      renderRows();
    });

    providerBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.provider = btn.dataset.provider || "all";
        if (state.provider === "core") {
          state.capability = "all";
        }
        syncFilterButtons();
        renderRows();
      });
    });

    capBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.capability = btn.dataset.cap || "all";
        if (state.capability !== "all" && state.provider === "core") {
          state.provider = "host";
        }
        syncFilterButtons();
        renderRows();
      });
    });

    if (resetBtn) resetBtn.addEventListener("click", resetFilters);
    if (emptyReset) emptyReset.addEventListener("click", resetFilters);

    syncFilterButtons();
    renderRows();
  }

  // --- 7. Copy Buttons & Expand/Collapse All (copy-button + accordion guides) ---
  function initCommands() {
    var timers = new WeakMap();
    var lastMessage = "";

    function legacyCopy(text) {
      var field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.cssText = "position:fixed;inset-block-start:0;opacity:0";
      document.body.append(field);
      field.select();
      try {
        return document.execCommand("copy");
      } finally {
        field.remove();
      }
    }

    function report(button, ok) {
      var tip = button.nextElementSibling;
      if (!tip) return;
      clearTimeout(timers.get(button));
      button.removeAttribute("data-copied");
      button.removeAttribute("data-failed");

      var message = ok ? "Copied" : "Copy failed";
      if (message === lastMessage) message += "\u00A0";
      lastMessage = message;

      tip.textContent = "";
      void button.offsetWidth;
      button.setAttribute(ok ? "data-copied" : "data-failed", "");
      requestAnimationFrame(function () {
        tip.textContent = message;
      });
      timers.set(
        button,
        setTimeout(function () {
          button.removeAttribute("data-copied");
          button.removeAttribute("data-failed");
          tip.textContent = "";
        }, COPY_RESET_MS)
      );
    }

    async function copy(button, target) {
      var raw = target.matches("input, textarea") ? target.value : target.innerText;
      var text = (target.id === "hero-cli-cmd" ? raw.replace(/^\$/, "") : raw).trim();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        report(button, true);
      } catch (_err) {
        if (legacyCopy(text)) {
          report(button, true);
        } else {
          report(button, false);
        }
      }
    }

    function toggleAll(button, container) {
      var expand = button.getAttribute("aria-expanded") !== "true";
      var items = container.querySelectorAll(":scope > details");
      for (var i = 0; i < items.length; i++) {
        items[i].open = expand;
      }
      button.setAttribute("aria-expanded", String(expand));
    }

    function handleCommand(command, source, target) {
      if (!source || !target) return;
      if (command === "--copy") {
        copy(source, target);
      } else if (command === "--toggle-all") {
        toggleAll(source, target);
      }
    }

    if ("CommandEvent" in window) {
      document.addEventListener(
        "command",
        function (event) {
          if (event.command === "--copy" || event.command === "--toggle-all") {
            handleCommand(event.command, event.source, event.target);
          }
        },
        true
      );
    } else {
      document.addEventListener("click", function (event) {
        var origin = event.target;
        if (!(origin instanceof Element)) return;
        var button = origin.closest("button[command^='--']");
        if (!button) return;
        var command = button.getAttribute("command");
        var targetId = button.getAttribute("commandfor");
        var target = targetId ? document.getElementById(targetId) : null;
        if (command && target) {
          handleCommand(command, button, target);
        }
      });
    }

    document.addEventListener(
      "toggle",
      function (event) {
        var target = event.target;
        if (!(target instanceof HTMLDetailsElement) || !target.matches(".accordion > details")) return;
        var accordion = target.parentElement;
        if (!accordion || !accordion.id) return;
        var button = document.querySelector('[command="--toggle-all"][commandfor="' + CSS.escape(accordion.id) + '"]');
        if (!button) return;
        var items = accordion.querySelectorAll(":scope > details");
        var allOpen = Array.prototype.every.call(items, function (d) {
          return d.open;
        });
        button.setAttribute("aria-expanded", String(allOpen));
      },
      true
    );

    if (!Object.hasOwn(HTMLDetailsElement.prototype, "name")) {
      document.addEventListener(
        "toggle",
        function (event) {
          var details = event.target;
          if (!(details instanceof HTMLDetailsElement) || !details.open || !details.hasAttribute("name")) return;
          var name = CSS.escape(details.getAttribute("name") || "");
          for (var other of document.querySelectorAll('details[name="' + name + '"]')) {
            if (other !== details && other instanceof HTMLDetailsElement) other.open = false;
          }
        },
        true
      );
    }
  }

  // Boot
  var data = globalThis.PULSARSCRIPT_SITE_DATA;
  var runtime = globalThis.PulsarRuntime;
  if (data && Array.isArray(data.functions)) {
    for (var i = 0; i < data.functions.length; i++) {
      BUILTIN_NAMES.add(data.functions[i].name);
    }
  }

  initColorSchemeToggle();
  initNavbar();
  var tabsController = initTabs();
  var studioBridge = initStudio(data, runtime, tabsController);
  initHeroRunner(data, runtime, studioBridge);
  initApiExplorer(data);
  initCommands();
})();
