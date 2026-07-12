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
    case "test-sidecar":
      runTest("sidecar", $("sidecarUrl").textContent);
      break;
    case "test-manifest":
      runTest("manifest", $("manifestUrl").textContent);
      break;
    case "switch-mode": {
      const newMode = state?.downloadMode === "custom" ? "auto" : "custom";
      sendApply(newMode);
      break;
    }
    case "apply":
      sendApply("custom");
      break;
    case "apply-checksum":
      sendApply(state?.downloadMode || "auto", "checksum");
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
    $("checksumMethodSelect").value = fork.checksumMethod ?? "sidecar";
    $("checksumAlgoSelect").value = fork.checksumAlgo ?? "";
    $("manifestTemplateInput").value = fork.manifestTemplate ?? "";
    $("manifestFieldInput").value = fork.manifestField ?? "";
    updateChecksumMethod();

    updatePreview();
    renderVars();
  }
});

// --- template input: live preview ---
$("templateInput").addEventListener("input", () => {
  updatePreview();
  renderVars();
});

// --- checksum method selector ---
$("checksumMethodSelect").addEventListener("change", updateChecksumMethod);

// --- checksum algo: update sidecar URL ---
$("checksumAlgoSelect").addEventListener("change", updateSidecarUrl);

// --- manifest template: live resolve ---
$("manifestTemplateInput").addEventListener("input", updateManifestUrl);

function updateChecksumMethod() {
  const method = $("checksumMethodSelect").value;
  if (method === "manifest") {
    $("sidecarRow").classList.add("hidden");
    $("manifestRow").classList.remove("hidden");
    $("manifestFieldRow").classList.remove("hidden");
    updateManifestUrl();
  } else {
    $("sidecarRow").classList.remove("hidden");
    $("manifestRow").classList.add("hidden");
    $("manifestFieldRow").classList.add("hidden");
    updateSidecarUrl();
  }
}

function sendApply(mode, which) {
  vscode.postMessage({
    type: "apply",
    template: $("templateInput").value,
    binaryName: $("binaryNameInput").value,
    which: which || mode,
    mode,
    checksumMethod: $("checksumMethodSelect").value,
    checksumAlgo: $("checksumAlgoSelect").value,
    manifestTemplate: $("manifestTemplateInput").value,
    manifestField: $("manifestFieldInput").value,
    verifyChecksum: $("verifyChecksumToggle").value === "true",
    onNoChecksum: $("onNoChecksumSelect").value,
  });
}

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

  // Hide fork picker if there are <= 2 templates (one fork + custom).
  const forkCount = state?.forkTemplates?.length ?? 0;
  const forkRow = $("forkSelectRow");
  if (forkRow) {
    forkRow.style.display = forkCount > 2 ? "" : "none";
  }
}

function updatePreview() {
  vscode.postMessage({
    type: "resolveUrl",
    template: $("templateInput").value,
  });
}

/** Sidecar URL = resolved download URL + "." + algo.
 * Computed client-side from the auto/custom URL box + algo dropdown. */
function updateSidecarUrl() {
  const algo = $("checksumAlgoSelect").value;
  const btnRow = $("sidecarBtnRow");
  const urlBox = $("sidecarUrl");
  const resultEl = $("sidecarTestResult");
  resultEl.className = "test-result";
  resultEl.textContent = "";

  if (!algo) {
    urlBox.textContent = "";
    urlBox.className = "url-box empty hidden";
    btnRow.classList.add("hidden");
    return;
  }

  const downloadUrl = $("customSection").classList.contains("visible")
    ? $("previewUrl").textContent
    : $("autoUrl").textContent;
  if (
    !downloadUrl ||
    downloadUrl.includes("${") ||
    downloadUrl === "Resolving..." ||
    downloadUrl === "(empty)"
  ) {
    urlBox.textContent = "";
    urlBox.className = "url-box empty hidden";
    btnRow.classList.add("hidden");
    return;
  }

  const sidecarUrl = downloadUrl + "." + algo;
  urlBox.textContent = sidecarUrl;
  urlBox.className = "url-box";
  btnRow.classList.remove("hidden");
}

/** Resolve manifest template via the extension. */
function updateManifestUrl() {
  const template = $("manifestTemplateInput").value.trim();
  const btnRow = $("manifestBtnRow");
  const urlBox = $("manifestUrl");
  const resultEl = $("manifestTestResult");
  resultEl.className = "test-result";
  resultEl.textContent = "";

  if (!template) {
    urlBox.textContent = "";
    urlBox.className = "url-box empty hidden";
    btnRow.classList.add("hidden");
    return;
  }

  btnRow.classList.remove("hidden");
  vscode.postMessage({
    type: "resolveManifestUrl",
    template,
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
  switch (msg.type) {
    case "state": {
      state = msg.state;
      $("forkName").textContent = state.forkName || "(unknown)";

      if (state.binaryName) {
        $("binaryNameInput").value = state.binaryName;
      }

      // Populate fork select
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
        const firstFork = state.forkTemplates?.[0];
        if (firstFork && firstFork.template) {
          $("templateInput").value = firstFork.template;
        }
      }

      if (state.resolvedUrl) {
        setUrlBox("autoUrl", state.resolvedUrl);
        setUrlBox("previewUrl", state.resolvedUrl);
      }

      // Checksum fields
      $("checksumMethodSelect").value = state.checksumMethod || "sidecar";
      if (state.checksumAlgo) {
        $("checksumAlgoSelect").value = state.checksumAlgo;
      }
      if (state.manifestTemplate) {
        $("manifestTemplateInput").value = state.manifestTemplate;
      }
      if (state.manifestField) {
        $("manifestFieldInput").value = state.manifestField;
      }
      $("verifyChecksumToggle").value = state.verifyChecksum ? "true" : "false";
      $("onNoChecksumSelect").value = state.onNoChecksum || "warn";

      updatePreview();
      renderVars();
      updateMode();
      updateChecksumMethod();
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
      updateSidecarUrl();
      break;
    }

    case "resolvedManifestUrl": {
      if (msg.error) {
        setUrlBox("manifestUrl", "Error: " + msg.error);
      } else if (msg.url) {
        let text = msg.url;
        if (msg.unresolved && msg.unresolved.length > 0) {
          text += "\n\nUnresolved: " + msg.unresolved.join(", ");
        }
        setUrlBox("manifestUrl", text);
      }
      break;
    }

    case "testResult": {
      const which = msg.which || "custom";
      const btn = $(which + "TestBtn");
      if (btn) {
        btn.disabled = false;
        const labels = {
          auto: "Test URL",
          custom: "Test URL",
          sidecar: "Test Sidecar URL",
          manifest: "Test Manifest URL",
        };
        btn.textContent = labels[which] || "Test URL";
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
      } else if (which === "checksum") {
        showTestResult("sidecar", true, "Checksum settings saved.");
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
  el.classList.remove("hidden");
}
