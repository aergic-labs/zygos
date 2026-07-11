// Zygos server download config webview.
// Communicates with the extension via postMessage. No inline handlers:
// buttons declare a data-action, a single delegated listener dispatches.

const vscode = acquireVsCodeApi();
let state = null;

const $ = (id) => document.getElementById(id);

// --- initial state ---
vscode.postMessage({ type: "getState" });

// --- delegated click handling ---
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  switch (action) {
    case "test-auto":
      runTest("auto", $("autoUrl").textContent);
      break;
    case "test-custom":
      runTest("custom", $("previewUrl").textContent);
      break;
    case "switch-mode": {
      const newMode = state?.downloadMode === "custom" ? "auto" : "custom";
      vscode.postMessage({
        type: "apply",
        template: $("templateInput").value,
        binaryName: $("binaryNameInput").value,
        which: newMode,
        mode: newMode,
      });
      break;
    }
    case "apply":
      vscode.postMessage({
        type: "apply",
        template: $("templateInput").value,
        binaryName: $("binaryNameInput").value,
        which: "custom",
        mode: "custom",
      });
      break;
  }
});

// --- fork select: pre-fill the template ---
$("forkSelect").addEventListener("change", () => {
  const fork = state?.forkTemplates?.find(
    (f) => f.id === $("forkSelect").value,
  );
  if (fork) {
    $("templateInput").value = fork.template;
    updatePreview();
    renderVars();
  }
});

// --- template input: live preview ---
$("templateInput").addEventListener("input", () => {
  updatePreview();
  renderVars();
});

function updateMode() {
  const mode = state?.downloadMode || "auto";
  const badge = $("modeBadge");
  const switchBtn = $("switchModeBtn");

  badge.textContent = mode.toUpperCase();
  badge.className = "badge " + mode;

  if (mode === "auto") {
    $("autoSection").classList.add("visible");
    $("customSection").classList.remove("visible");
    switchBtn.textContent = "Switch to Custom";
  } else {
    $("autoSection").classList.remove("visible");
    $("customSection").classList.add("visible");
    switchBtn.textContent = "Switch to Auto";
  }
}

function updatePreview() {
  vscode.postMessage({
    type: "resolveUrl",
    template: $("templateInput").value,
  });
}

function runTest(which, url) {
  if (
    !url ||
    url === "Resolving..." ||
    url === "(empty)" ||
    url.includes("${")
  ) {
    showTestResult(
      which,
      false,
      "No valid URL to test. Resolve the template first.",
    );
    return;
  }
  const btn = $(which + "TestBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Testing...';
  }
  vscode.postMessage({ type: "testUrl", url, which });
}

function showTestResult(which, ok, msg) {
  const el = $(which + "TestResult");
  el.className = "test-result visible " + (ok ? "ok" : "err");
  el.textContent = msg;
}

function renderVars() {
  const tbl = $("varsTable");
  tbl.innerHTML = "";
  if (state?.variables) {
    for (const v of state.variables) {
      addVarRow(tbl, "${" + v.name + "}", v.value);
    }
  }
  const template = $("templateInput").value || "";
  if (template.includes("${cdnVersion}")) {
    addVarRow(tbl, "${cdnVersion}", "(fetched on Test)");
  }
}

function addVarRow(tbl, name, value) {
  const tr = document.createElement("tr");
  const td1 = document.createElement("td");
  td1.className = "name";
  td1.textContent = name;
  const td2 = document.createElement("td");
  td2.className = "value";
  td2.textContent = value;
  tr.appendChild(td1);
  tr.appendChild(td2);
  tbl.appendChild(tr);
}

// --- messages from the extension ---
window.addEventListener("message", (e) => {
  const msg = e.data;
  console.log("[zygos] RX", JSON.stringify(msg).slice(0, 500));
  switch (msg.type) {
    case "state": {
      state = msg.state;
      $("forkName").textContent = state.forkName || "(unknown)";

      if (state.binaryName) {
        $("binaryNameInput").value = state.binaryName;
      }

      const sel = $("forkSelect");
      sel.innerHTML = "";
      for (const f of state.forkTemplates) {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.name;
        sel.appendChild(opt);
      }

      if (state.downloadMode === "custom" && state.currentTemplate) {
        $("templateInput").value = state.currentTemplate;
      } else {
        // No saved template (auto mode, or custom with no template set).
        // Pre-fill from the first fork in the dropdown so Apply has an effect.
        const firstFork = state.forkTemplates?.[0];
        if (firstFork && firstFork.template) {
          $("templateInput").value = firstFork.template;
        }
      }

      if (state.resolvedUrl) {
        setUrlBox("autoUrl", state.resolvedUrl);
        setUrlBox("previewUrl", state.resolvedUrl);
      }
      updatePreview();
      renderVars();
      updateMode();
      break;
    }

    case "resolvedUrl": {
      if (msg.error) {
        setUrlBox("previewUrl", "Error: " + msg.error);
      } else if (msg.url) {
        let text = msg.url;
        if (msg.unresolved && msg.unresolved.length > 0) {
          text += "\n\nUnresolved: " + msg.unresolved.join(", ");
        }
        setUrlBox("previewUrl", text);
      }
      break;
    }

    case "testResult": {
      const which = msg.which || "custom";
      const btn = $(which + "TestBtn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Test URL";
      }
      const r = msg.result;
      if (r.ok) {
        let text = "OK - HTTP " + r.status;
        if (r.contentLength) {
          const mb = (Number(r.contentLength) / 1048576).toFixed(1);
          text += " (" + mb + " MB)";
        }
        if (r.contentType) text += " [" + r.contentType + "]";
        if (r.error) text += "\n" + r.error;
        showTestResult(which, true, text);
      } else {
        let text = r.error || "HTTP " + r.status + " " + (r.statusText || "");
        if (r.contentType) text += " [content-type: " + r.contentType + "]";
        showTestResult(which, false, text);
      }
      break;
    }

    case "applied": {
      const which = msg.which || "custom";
      const isModeSwitch = msg.which === "auto" || msg.which === "custom";
      if (isModeSwitch) {
        showTestResult(
          which === "auto" ? "auto" : "custom",
          true,
          which === "auto" ? "Switched to auto." : "Switched to custom.",
        );
      } else {
        showTestResult("custom", true, "Settings saved.");
      }
      vscode.postMessage({ type: "getState" });
      break;
    }

    case "applyError": {
      const which = msg.which || "custom";
      showTestResult(which, false, "Save failed: " + msg.error);
      break;
    }
  }
});

function setUrlBox(id, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.remove("empty");
}
