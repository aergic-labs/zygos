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
      sendApply(newMode, "mode-switch");
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

// --- fork defaults: load button ---
$("loadDefaultsBtn").addEventListener("click", () => {
  const forkId = $("forkDefaultsSelect").value;
  const fork = state?.forkTemplates?.find((f) => f.id === forkId);
  if (!fork) return;
  if (fork.template) $("templateInput").value = fork.template;
  $("checksumMethodSelect").value = fork.checksumMethod ?? "sidecar";
  $("checksumAlgoSelect").value = fork.checksumAlgo ?? "";
  $("manifestTemplateInput").value = fork.manifestTemplate ?? "";
  $("manifestFieldInput").value = fork.manifestField ?? "";
  updateChecksumMethod();
  updatePreview();
  renderVars();
  showStatus("custom", true, "Loaded defaults from " + fork.name + ".");
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
  const btn = which && $(which + "ApplyBtn");
  if (btn) {
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>Saving...';
  }
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
  const resultEl = $("sidecarStatus");
  resultEl.className = "status";
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
  const resultEl = $("manifestStatus");
  resultEl.className = "status";
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
    showStatus(
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

function showStatus(which, ok, msg) {
  const el = $(which + "Status");
  el.className = "status visible " + (ok ? "ok" : "err");
  el.textContent = msg;
}

function restoreApplyBtn(which) {
  const btn = $(which + "ApplyBtn");
  if (btn && btn.dataset.label) {
    btn.disabled = false;
    btn.textContent = btn.dataset.label;
    delete btn.dataset.label;
  }
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

      // Populate fork defaults picker (does not reflect saved state - it's
      // just a source to load defaults from on button click).
      const sel = $("forkDefaultsSelect");
      sel.innerHTML = "";
      const blankOpt = document.createElement("option");
      blankOpt.value = "";
      blankOpt.textContent = "(pick a fork)";
      sel.appendChild(blankOpt);
      for (const f of state.forkTemplates) {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.name;
        sel.appendChild(opt);
      }

      if (state.currentTemplate) {
        // Previously saved (custom mode only). Restore as-is; don't
        // auto-load defaults over the user's saved choice.
        $("templateInput").value = state.currentTemplate;
      } else {
        // Nothing saved yet: auto-load defaults from the detected fork so
        // the UI starts from sane defaults. Trae has regional variants
        // ("Trae (US)" etc), so match by prefix.
        const match = state.forkTemplates?.find(
          (f) => f.name === state.forkName || f.name.startsWith(state.forkName + " "),
        );
        const fallback = match ?? state.forkTemplates?.[0];
        if (fallback && fallback.template) {
          $("templateInput").value = fallback.template;
          $("checksumMethodSelect").value = fallback.checksumMethod ?? "sidecar";
          $("checksumAlgoSelect").value = fallback.checksumAlgo ?? "";
          $("manifestTemplateInput").value = fallback.manifestTemplate ?? "";
          $("manifestFieldInput").value = fallback.manifestField ?? "";
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
        showStatus(which, true, text);
      } else {
        let text = r.error || "HTTP " + r.status + " " + (r.statusText || "");
        if (r.contentType) text += " [content-type: " + r.contentType + "]";
        showStatus(which, false, text);
      }
      break;
    }

    case "applied": {
      const which = msg.which || "custom";
      if (which === "mode-switch") {
        const newMode = state?.downloadMode === "custom" ? "auto" : "custom";
        showStatus(
          newMode === "auto" ? "auto" : "custom",
          true,
          newMode === "auto" ? "Switched to auto." : "Switched to custom.",
        );
      } else if (which === "checksum") {
        showStatus("checksum", true, "Checksum settings saved.");
      } else {
        showStatus("custom", true, "Settings saved.");
      }
      restoreApplyBtn(which);
      vscode.postMessage({ type: "getState" });
      break;
    }

    case "applyError": {
      const which = msg.which || "custom";
      showStatus(which, false, "Save failed: " + msg.error);
      restoreApplyBtn(which);
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
