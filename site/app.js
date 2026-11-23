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
      codeEl.innerHTML = "<code>" + highlightPulsar(src) + "</code>";

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

  // --- 4. Live Interactive Pulsar Sandbox Studio (#playground) ---
  function initStudio(data, runtime) {
    var presetBtns = Array.from(document.querySelectorAll("#studio-presets [data-preset]"));
    var capBtns = Array.from(document.querySelectorAll("[data-cap-toggle]"));
    var titleEl = document.getElementById("studio-title");
    var summaryEl = document.getElementById("studio-summary");
    var fileLabelEl = document.getElementById("studio-file-label");
    var editorEl = document.getElementById("sandbox-code");
    var runBtn = document.getElementById("studio-run-btn");
    var resetBtn = document.getElementById("studio-reset-btn");
    var stageBadge = document.getElementById("studio-stage-badge");
    var outputEl = document.getElementById("studio-output");
    var stepsText = document.getElementById("studio-steps-text");
    var stepsBar = document.getElementById("studio-steps-bar");
    var memText = document.getElementById("studio-mem-text");
    var memBar = document.getElementById("studio-mem-bar");
    var liveStatus = document.getElementById("studio-live-status");
    var bcMetaEl = document.getElementById("studio-bc-meta");
    var disasmEl = document.getElementById("studio-disasm");

    if (!editorEl || !outputEl || !disasmEl || !data || !Array.isArray(data.examples)) {
      return null;
    }

    var examplesById = new Map();
    data.examples.forEach(function (ex) {
      examplesById.set(ex.id, ex);
    });

    var activePresetId = "closures";
    var caps = {
      "fs.read": true,
      "fs.write": true,
      kv: true,
      events: true
    };

    function syncCapButtons() {
      capBtns.forEach(function (btn) {
        var name = btn.dataset.capToggle;
        var enabled = name ? caps[name] !== false : true;
        btn.setAttribute("aria-pressed", enabled ? "true" : "false");
        var stateSpan = btn.querySelector(".cap-state");
        if (stateSpan) stateSpan.textContent = enabled ? "ON" : "OFF";
      });
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

      var outputText = lines.join("\n") || "(no output)";
      outputEl.dataset.stage = res.stage;
      outputEl.innerHTML = '<span class="output-label">Stdout / Host Result</span>' + escapeHtml(outputText);

      var maxSteps = res.stats.maxSteps || 50000;
      var steps = res.stats.steps || 0;
      if (stepsText) {
        stepsText.textContent = steps.toLocaleString() + " / " + maxSteps.toLocaleString();
      }
      if (stepsBar) {
        stepsBar.max = maxSteps;
        stepsBar.value = Math.min(steps, maxSteps);
        stepsBar.dataset.danger = res.stage === "budget" ? "true" : "false";
      }

      var maxMem = res.stats.maxMemoryBytes || 2097152;
      var mem = res.stats.memBytes || 0;
      if (memText) {
        memText.textContent = formatBytes(mem) + " / " + formatBytes(maxMem);
      }
      if (memBar) {
        memBar.max = maxMem;
        memBar.value = Math.min(mem, maxMem);
        memBar.dataset.danger = res.stage === "memory" ? "true" : "false";
      }

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
            res.stats.durationMs +
            " ms";
      }

      if (liveStatus) {
        liveStatus.textContent =
          "Run finished: " + stageLabel(res.stage) + ", " + steps + " steps, " + res.stats.opcodes + " bytecode words.";
      }
    }

    function executeEditorCode() {
      var src = editorEl.value;
      if (!runtime || typeof runtime.compileAndRun !== "function") return;
      var res = runtime.compileAndRun(src, {
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
      applyResultToUI(res);
    }

    function selectPreset(id, overrideCode) {
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

      if (titleEl) titleEl.textContent = ex.title;
      if (summaryEl) summaryEl.textContent = ex.summary;
      if (fileLabelEl) {
        fileLabelEl.textContent = ex.multiFile
          ? "file-manager-reference.puls + file-manager-utils.puls (pre-linked bundle)"
          : "sandbox.puls (editable · Cmd/Ctrl+Enter)";
      }

      editorEl.value = typeof overrideCode === "string" ? overrideCode : ex.source;

      if (ex.multiFile && typeof overrideCode !== "string") {
        applyResultToUI(
          {
            ok: true,
            stage: "ok",
            output: ex.output,
            error: null,
            disassembly: ex.disassembly,
            events: [],
            deniedCalls: [],
            stats: {
              steps: 133,
              maxSteps: 250000,
              memBytes: 4096,
              maxMemoryBytes: 16777216,
              durationMs: 0.5,
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
            " fn · " +
            ex.stats.sources.join(" + ")
        );
        return;
      }

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
        if (activePresetId !== "modules") {
          executeEditorCode();
        }
      });
    });

    if (runBtn) runBtn.addEventListener("click", executeEditorCode);
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
        executeEditorCode();
      }
    });

    syncCapButtons();
    selectPreset("closures");

    return { selectPreset: selectPreset };
  }

  // --- 5. Accessible Tabs (tabs guide — Quickstart workflows) ---
  function initTabs() {
    var widgets = document.querySelectorAll('.tabs[data-tabs="quickstart"]');
    widgets.forEach(function (widget) {
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
  var studioBridge = initStudio(data, runtime);
  initHeroRunner(data, runtime, studioBridge);
  initTabs();
  initApiExplorer(data);
  initCommands();
})();
