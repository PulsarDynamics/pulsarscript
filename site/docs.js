(function () {
  "use strict";

  var STORAGE_DRAFT_KEY = "pulsarscript-studio-draft";

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function countLines(source) {
    return source === "" ? 1 : String(source).split(/\r?\n/).length;
  }

  function renderNumberedCode(source) {
    return String(source || "")
      .split(/\r?\n/)
      .map(function (line) {
        return '<span class="code-line">' + escapeHtml(line) + "</span>";
      })
      .join("");
  }

  function initThemeToggle() {
    var btn = document.getElementById("theme-toggle");
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) return;

    function getStored() {
      try {
        var v = localStorage.getItem("color-scheme");
        return v === "light" || v === "dark" ? v : null;
      } catch (_err) {
        return null;
      }
    }

    function effectiveScheme() {
      if (meta.content === "light" || meta.content === "dark") return meta.content;
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    function applyScheme(value) {
      if (value === "light" || value === "dark") {
        meta.content = value;
      } else {
        meta.content = "light dark";
      }
      if (btn) {
        btn.setAttribute("aria-pressed", effectiveScheme() === "dark" ? "true" : "false");
      }
    }

    applyScheme(getStored() || "light dark");

    if (btn) {
      btn.addEventListener("click", function () {
        var next = effectiveScheme() === "dark" ? "light" : "dark";
        applyScheme(next);
        try {
          localStorage.setItem("color-scheme", next);
        } catch (_err) {
          // Ignore storage restrictions.
        }
      });
    }
  }

  function openInStudio(code, title) {
    try {
      sessionStorage.setItem(
        STORAGE_DRAFT_KEY,
        JSON.stringify({ code: code, title: title || "Docs Example" }),
      );
    } catch (_err) {
      // Ignore storage failure and fall back to navigation.
    }
    window.location.href = "./index.html#playground";
  }

  function formatInline(text) {
    var html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return html;
  }

  function renderMarkdown(mdText, allowStudioButtons) {
    var lines = String(mdText || "").split(/\r?\n/);
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (line.indexOf("```") === 0) {
        var lang = line.slice(3).trim().toLowerCase();
        var codeLines = [];
        i++;
        while (i < lines.length && lines[i].indexOf("```") !== 0) {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        var codeBody = codeLines.join("\n");
        var isPulsSnippet = lang === "puls" || lang === "pulsarscript";
        var isRunnableSnippet =
          allowStudioButtons &&
          isPulsSnippet &&
          !/\b(import|export)\b/.test(codeBody);
        var lineCount = countLines(codeBody);
        var lineLabel = lineCount + (lineCount === 1 ? " line" : " lines");
        out.push('<div class="docs-code-wrap">');
        if (isPulsSnippet) {
          out.push(
            '<pre class="code-block has-lines" tabindex="0"><code>' + renderNumberedCode(codeBody) + "</code></pre>",
          );
          out.push('<div class="docs-code-footer"><span class="code-line-count">' + escapeHtml(lineLabel) + "</span>");
          if (isRunnableSnippet) {
            out.push(
              '<button class="btn btn-secondary docs-try-btn" type="button" data-open-studio="' +
                escapeHtml(encodeURIComponent(codeBody)) +
                '">Open in Script Studio</button>',
            );
          }
          out.push("</div>");
        } else {
          out.push('<pre class="code-block" tabindex="0"><code>' + escapeHtml(codeBody) + "</code></pre>");
        }
        out.push("</div>");
        continue;
      }

      if (/^\|.+\|$/.test(line.trim()) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        var headers = line
          .trim()
          .slice(1, -1)
          .split("|")
          .map(function (c) {
            return c.trim();
          });
        i += 2;
        out.push('<div class="docs-table-wrap"><table class="docs-table"><thead><tr>');
        for (var h = 0; h < headers.length; h++) {
          out.push("<th>" + formatInline(headers[h]) + "</th>");
        }
        out.push("</tr></thead><tbody>");
        while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
          var cols = lines[i]
            .trim()
            .slice(1, -1)
            .split("|")
            .map(function (c) {
              return c.trim();
            });
          out.push("<tr>");
          for (var c = 0; c < cols.length; c++) {
            out.push("<td>" + formatInline(cols[c]) + "</td>");
          }
          out.push("</tr>");
          i++;
        }
        out.push("</tbody></table></div>");
        continue;
      }

      var headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
      if (headingMatch) {
        var level = Math.min(4, headingMatch[1].length + 1);
        out.push("<h" + level + ">" + formatInline(headingMatch[2]) + "</h" + level + ">");
        i++;
        continue;
      }

      if (/^---+$/.test(line.trim())) {
        out.push("<hr />");
        i++;
        continue;
      }

      if (line.trim().indexOf(">") === 0) {
        var quoteLines = [];
        while (i < lines.length && lines[i].trim().indexOf(">") === 0) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        out.push("<blockquote><p>" + formatInline(quoteLines.join(" ")) + "</p></blockquote>");
        continue;
      }

      if (/^(\d+\.\s+|[-*]\s+)/.test(line)) {
        var ordered = /^\d+\.\s+/.test(line);
        out.push(ordered ? "<ol>" : "<ul>");
        while (i < lines.length && (ordered ? /^\d+\.\s+/.test(lines[i]) : /^[-*]\s+/.test(lines[i]))) {
          var itemText = lines[i].replace(/^(\d+\.\s+|[-*]\s+)/, "");
          i++;
          out.push("<li>" + formatInline(itemText) + "</li>");
        }
        out.push(ordered ? "</ol>" : "</ul>");
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      var paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4}\s+|```|---+|>\s?|\d+\.\s+|[-*]\s+|\|.+\|$)/.test(lines[i])
      ) {
        paraLines.push(lines[i].trim());
        i++;
      }
      out.push("<p>" + formatInline(paraLines.join(" ")) + "</p>");
    }

    return out.join("\n");
  }

  function renderManifestSection(data) {
    var container = document.getElementById("docs-manifest-body");
    if (!container || !data || !data.manifestSchema) return;

    var schema = data.manifestSchema;
    var required = Array.isArray(schema.required) ? schema.required : [];
    var props = schema.properties || {};

    var html = [];
    html.push(
      "<p>Required top-level fields: " +
        required
          .map(function (r) {
            return "<code>" + escapeHtml(r) + "</code>";
          })
          .join(", ") +
        ".</p>",
    );
    html.push(
      '<div class="docs-table-wrap"><table class="docs-table"><thead><tr><th>Field</th><th>Type / Format</th><th>Description</th></tr></thead><tbody>',
    );

    Object.keys(props).forEach(function (key) {
      var prop = props[key];
      var typeStr = Array.isArray(prop.type) ? prop.type.join(" | ") : prop.type || "object";
      var badge = required.indexOf(key) >= 0 ? " (required)" : "";
      html.push(
        "<tr><td><code>" +
          escapeHtml(key) +
          "</code>" +
          escapeHtml(badge) +
          "</td><td><code>" +
          escapeHtml(typeStr) +
          "</code></td><td>" +
          escapeHtml(prop.description || "") +
          "</td></tr>",
      );
    });
    html.push("</tbody></table></div>");

    if (data.exampleManifest) {
      html.push("<h3>Full Valid AppManifest Example</h3>");
      html.push(
        '<pre class="code-block" tabindex="0"><code>' +
          escapeHtml(JSON.stringify(data.exampleManifest, null, 2)) +
          "</code></pre>",
      );
    }

    container.innerHTML = html.join("\n");
  }

  function renderSdkAndTooling(data) {
    var container = document.getElementById("docs-sdk-body");
    if (!container || !data || !data.sdkReference) return;

    var sdkHtml = ['<article class="card docs-card"><h3>App UI SDK Bridge</h3><ul class="docs-list">'];
    (data.sdkReference.bridgeGlobals || []).forEach(function (entry) {
      sdkHtml.push(
        "<li><code>" +
          escapeHtml(entry.name) +
          "</code> &rarr; <code>" +
          escapeHtml(entry.returns) +
          "</code><p>" +
          escapeHtml(entry.description) +
          "</p></li>",
      );
    });
    sdkHtml.push("</ul></article>");

    var cliHtml = ['<article class="card docs-card"><h3>Developer CLI Workflows</h3><ul class="docs-list">'];
    (data.sdkReference.cliCommands || []).forEach(function (entry) {
      cliHtml.push(
        "<li><code>" +
          escapeHtml(entry.cmd) +
          "</code><p>" +
          escapeHtml(entry.description) +
          "</p></li>",
      );
    });
    cliHtml.push("</ul></article>");

    container.innerHTML = sdkHtml.join("\n") + cliHtml.join("\n");
  }

  function renderRegistry(functions, query, providerFilter) {
    var listEl = document.getElementById("docs-registry-list");
    var countEl = document.getElementById("docs-registry-count");
    if (!listEl) return;

    var q = (query || "").trim().toLowerCase();
    var filtered = functions.filter(function (fn) {
      if (providerFilter !== "all" && fn.provider !== providerFilter) return false;
      if (!q) return true;
      return (
        fn.name.toLowerCase().indexOf(q) >= 0 ||
        fn.doc.toLowerCase().indexOf(q) >= 0 ||
        fn.category.toLowerCase().indexOf(q) >= 0 ||
        (fn.capability && fn.capability.toLowerCase().indexOf(q) >= 0)
      );
    });

    if (countEl) countEl.textContent = filtered.length + " / " + functions.length + " Functions";

    listEl.innerHTML = filtered
      .map(function (fn) {
        var capPill = fn.capability
          ? '<span class="badge badge-cap">cap: ' + escapeHtml(fn.capability) + "</span>"
          : '<span class="badge badge-core">core</span>';
        return (
          '<article class="card docs-api-card">' +
          '<div class="docs-api-head"><code>' +
          escapeHtml(fn.signature) +
          "</code>" +
          capPill +
          "</div>" +
          "<p>" +
          escapeHtml(fn.doc) +
          "</p>" +
          "</article>"
        );
      })
      .join("\n");
  }

  function renderExamples(examples, query) {
    var grid = document.getElementById("docs-examples-grid");
    var countEl = document.getElementById("docs-examples-count");
    if (!grid) return;

    var q = (query || "").trim().toLowerCase();
    var filtered = examples.filter(function (ex) {
      if (!q) return true;
      return (
        ex.title.toLowerCase().indexOf(q) >= 0 ||
        ex.category.toLowerCase().indexOf(q) >= 0 ||
        ex.code.toLowerCase().indexOf(q) >= 0 ||
        ex.path.toLowerCase().indexOf(q) >= 0
      );
    });

    if (countEl) countEl.textContent = filtered.length + " Verified Examples";

    grid.innerHTML = filtered
      .map(function (ex, idx) {
        var lineCount = countLines(ex.code);
        return (
          '<article class="card docs-card">' +
          '<div class="docs-card-head">' +
          "<h3>" +
          escapeHtml(ex.title) +
          "</h3>" +
          '<div class="docs-stat-row">' +
          '<span class="code-line-count">' +
          escapeHtml(lineCount + (lineCount === 1 ? " line" : " lines")) +
          "</span>" +
          '<span class="badge badge-core">' +
          escapeHtml(ex.category) +
          "</span>" +
          "</div>" +
          "</div>" +
          '<p class="docs-card-path"><code>' +
          escapeHtml(ex.path) +
          "</code></p>" +
          '<pre class="code-block has-lines" tabindex="0"><code>' +
          renderNumberedCode(ex.code) +
          "</code></pre>" +
          '<div class="output-block docs-expected-out"><span class="output-label">Expected Output</span>' +
          escapeHtml(ex.expected) +
          "</div>" +
          '<div class="docs-card-actions">' +
          '<button class="btn btn-secondary" type="button" data-example-index="' +
          idx +
          '">Open in Script Studio</button>' +
          "</div>" +
          "</article>"
        );
      })
      .join("\n");

    grid.querySelectorAll("[data-example-index]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = Number(btn.getAttribute("data-example-index"));
        var ex = filtered[idx];
        if (ex) openInStudio(ex.code, ex.title);
      });
    });
  }

  function boot() {
    initThemeToggle();

    var data = globalThis.PULSARSCRIPT_DOCS_DATA;
    if (!data) return;

    var versionTag = document.getElementById("docs-version-tag");
    if (versionTag && data.meta) {
      versionTag.textContent = "v" + data.meta.version + " · Docs";
    }

    var statRow = document.getElementById("docs-stat-row");
    if (statRow && data.meta) {
      statRow.innerHTML = [
        '<span class="badge badge-core">' + escapeHtml(data.meta.totalFunctions) + " Built-in / Host Functions</span>",
        '<span class="badge badge-core">' + escapeHtml(data.meta.conformanceCount) + " Conformance Cases</span>",
        '<span class="badge badge-cap">SPEC v' + escapeHtml(data.meta.specVersion) + " · Bytecode v" + escapeHtml(data.meta.bytecodeVersion) + "</span>",
        '<span class="badge badge-core">' + escapeHtml(data.meta.opcodeCount) + " VM Opcodes</span>",
      ].join("");
    }

    var guideBody = document.getElementById("docs-guide-body");
    if (guideBody) {
      guideBody.innerHTML = renderMarkdown(data.guideMarkdown, true);
      guideBody.querySelectorAll("[data-open-studio]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var code = decodeURIComponent(btn.getAttribute("data-open-studio") || "");
          openInStudio(code, "First-App Snippet");
        });
      });
    }

    renderSdkAndTooling(data);
    renderManifestSection(data);

    var specBody = document.getElementById("docs-spec-body");
    if (specBody) {
      specBody.innerHTML = renderMarkdown(data.specMarkdown, false);
    }

    var searchInput = document.getElementById("docs-global-search");
    var searchMeta = document.getElementById("docs-search-meta");
    var filterBtns = Array.from(document.querySelectorAll("[data-provider-filter]"));
    var providerFilter = "all";

    function refreshFilteredViews() {
      var q = searchInput ? searchInput.value : "";
      renderRegistry(data.functions || [], q, providerFilter);
      renderExamples(data.conformanceExamples || [], q);
      if (searchMeta) {
        searchMeta.textContent = q
          ? 'Filtered by "' + q + '"'
          : (data.functions || []).length + " functions · " + (data.conformanceExamples || []).length + " live examples";
      }
    }

    filterBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        providerFilter = btn.getAttribute("data-provider-filter") || "all";
        filterBtns.forEach(function (b) {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        refreshFilteredViews();
      });
    });

    if (searchInput) {
      searchInput.addEventListener("input", refreshFilteredViews);
    }

    refreshFilteredViews();
  }

  boot();
})();
