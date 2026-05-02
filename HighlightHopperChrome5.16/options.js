const ext = typeof browser !== "undefined" ? browser : chrome;

let selectedTags = new Set();

document.addEventListener("DOMContentLoaded", () => {
  const exportTxtBtn = document.getElementById("export-txt-btn");
  const exportCsvBtn = document.getElementById("export-csv-btn");
  const importFile = document.getElementById("import-file");
  const importTrigger = document.getElementById("import-trigger");
  const importFilename = document.getElementById("import-filename");
  const importBtn = document.getElementById("import-btn");
  const importError = document.getElementById("import-error");
  const tagContainer = document.getElementById("export-tag-container");
  const addColorBtn = document.getElementById("add-color-btn");
  const newColorInput = document.getElementById("new-color-input");
  const customColorList = document.getElementById("custom-color-list");

  loadAvailableTags(tagContainer);
  loadCustomColors(customColorList);

  exportTxtBtn.addEventListener("click", () => {
    exportTxtBtn.setAttribute("aria-busy", "true");
    exportHighlightsAsTxt().finally(() => {
      exportTxtBtn.removeAttribute("aria-busy");
    });
  });

  exportCsvBtn.addEventListener("click", () => {
    exportCsvBtn.setAttribute("aria-busy", "true");
    exportHighlightsAsCsv().finally(() => {
      exportCsvBtn.removeAttribute("aria-busy");
    });
  });

  importTrigger.addEventListener("click", () => {
    importFile.click();
  });

  importTrigger.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      importFile.click();
      e.preventDefault();
    }
  });

  importFile.addEventListener("change", () => {
    if (importFile.files.length > 0) {
      importFilename.textContent = importFile.files[0].name;
    } else {
      importFilename.textContent = "";
    }
  });

  importBtn.addEventListener("click", () => {
    importError.textContent = "";
    importBtn.setAttribute("aria-busy", "true");
    importCsv(importFile.files[0])
      .then(() => {
        importFilename.textContent = "";
        importFile.value = "";
        loadAvailableTags(tagContainer);
      })
      .catch(err => {
        importError.textContent = err.message || "Import failed.";
      })
      .finally(() => {
        importBtn.removeAttribute("aria-busy");
      });
  });

  importBtn.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      importBtn.click();
      e.preventDefault();
    }
  });

  if (addColorBtn && newColorInput && customColorList) {
    addColorBtn.addEventListener("click", () => {
      const c = newColorInput.value;
      if (!c) return;
      ext.storage.local.get("customColors").then(data => {
        const raw = data.customColors || [];
        const arr = raw.map(x => {
          if (typeof x === "string") return { color: x, name: "" };
          return { color: x.color, name: x.name || "" };
        });
        if (!arr.some(x => x.color === c)) {
          arr.push({ color: c, name: "" });
        }
        ext.storage.local.set({ customColors: arr }).then(() => {
          loadCustomColors(customColorList);
        });
      });
    });
  }
});

function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch (e) {
    return url || "";
  }
}

function normalizeHighlightText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function cloneEntry(entry, pageUrl) {
  const url = canonicalizeUrl((entry && (entry.keyUrl || entry.sourcePage)) || pageUrl);
  return {
    id: entry && entry.id ? entry.id : generateId(),
    text: entry && typeof entry.text === "string" ? entry.text : "",
    color: entry && entry.color ? entry.color : "yellow",
    timestamp: entry && Number(entry.timestamp) ? Number(entry.timestamp) : Date.now(),
    sourcePage: url,
    keyUrl: url,
    ranges: Array.isArray(entry && entry.ranges) ? entry.ranges.filter(Boolean) : [],
    note: entry && typeof entry.note === "string" ? entry.note : ""
  };
}

function shouldReplaceEntry(existing, incoming) {
  const existingHasRanges = Array.isArray(existing.ranges) && existing.ranges.length > 0;
  const incomingHasRanges = Array.isArray(incoming.ranges) && incoming.ranges.length > 0;
  if (incoming.timestamp !== existing.timestamp) return incoming.timestamp > existing.timestamp;
  if (incomingHasRanges !== existingHasRanges) return incomingHasRanges;
  return true;
}

function dedupeEntries(entries, pageUrl) {
  const byText = new Map();

  (entries || []).forEach(raw => {
    const entry = cloneEntry(raw, pageUrl);
    const key = normalizeHighlightText(entry.text);
    if (!key) return;
    const existing = byText.get(key);
    if (!existing || shouldReplaceEntry(existing, entry)) {
      byText.set(key, entry);
    }
  });

  return Array.from(byText.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function normalizeHighlightsMap(map) {
  const normalized = {};

  Object.keys(map || {}).forEach(rawUrl => {
    const canonicalUrl = canonicalizeUrl(rawUrl);
    const deduped = dedupeEntries(map[rawUrl] || [], canonicalUrl);
    if (!normalized[canonicalUrl]) normalized[canonicalUrl] = [];
    normalized[canonicalUrl] = dedupeEntries(normalized[canonicalUrl].concat(deduped), canonicalUrl);
  });

  return normalized;
}

function extractTags(note) {
  if (!note) return [];
  return [...note.matchAll(/#([a-zA-Z0-9_-]+)/g)].map(m => m[1].toLowerCase());
}

function repairStoredNotes(map) {
  let changed = false;
  Object.keys(map).forEach(url => {
    map[url].forEach(entry => {
      if (entry.note && typeof entry.note === "string") {
        const tags = extractTags(entry.note);
        if (tags.length > 0 && !entry.note.includes("#")) {
          entry.note = entry.note.trim();
          changed = true;
        }
      }
    });
  });
  return changed;
}

function loadAvailableTags(container) {
  ext.storage.local.get("highlights").then(data => {
    let map = data.highlights || {};
    const repaired = repairStoredNotes(map);
    map = normalizeHighlightsMap(map);
    if (repaired || JSON.stringify(map) !== JSON.stringify(data.highlights || {})) {
      ext.storage.local.set({ highlights: map });
    }

    const allTags = new Set();

    Object.values(map).forEach(entries => {
      entries.forEach(e => {
        extractTags(e.note || "").forEach(t => allTags.add(t));
      });
    });

    container.textContent = "";

    if (allTags.size === 0) {
      const none = document.createElement("div");
      none.textContent = "No tags found.";
      none.style.fontSize = "12px";
      container.appendChild(none);
      return;
    }

    allTags.forEach(tag => {
      const pill = document.createElement("div");
      pill.textContent = "#" + tag;
      pill.dataset.tag = tag;
      pill.className = "export-tag-pill";

      pill.addEventListener("click", () => {
        if (selectedTags.has(tag)) {
          selectedTags.delete(tag);
          pill.classList.remove("selected");
        } else {
          selectedTags.add(tag);
          pill.classList.add("selected");
        }
      });

      container.appendChild(pill);
    });

    const clear = document.createElement("div");
    clear.textContent = "Clear Tags";
    clear.className = "export-tag-clear";

    clear.addEventListener("click", () => {
      selectedTags.clear();
      [...container.children].forEach(child => {
        if (child.dataset && child.dataset.tag) {
          child.classList.remove("selected");
        }
      });
    });

    container.appendChild(clear);
  });
}

function filterBySelectedTags(entries) {
  if (selectedTags.size === 0) return entries;
  return entries.filter(e => {
    const tags = extractTags(e.note || "");
    return tags.some(t => selectedTags.has(t));
  });
}

function buildColorNameMap(customColors) {
  const map = {};
  const raw = customColors || [];
  raw.forEach(c => {
    if (typeof c === "string") {
      if (!map[c]) map[c] = "";
    } else if (c && c.color) {
      map[c.color] = c.name || "";
    }
  });
  return map;
}

function exportHighlightsAsTxt() {
  return ext.storage.local.get(["highlights", "customColors"]).then(data => {
    const map = normalizeHighlightsMap(data.highlights || {});
    const colorNameMap = buildColorNameMap(data.customColors);
    let output = "";

    Object.keys(map).forEach(url => {
      const filtered = filterBySelectedTags(map[url]);
      if (filtered.length === 0) return;

      output += "URL: " + url + "\n";
      const byColor = {};

      filtered.forEach(e => {
        byColor[e.color] = byColor[e.color] || [];
        byColor[e.color].push(e);
      });

      Object.keys(byColor).forEach(color => {
        const name = colorNameMap[color] || color;
        const label = colorNameMap[color] ? name + " (" + color + ")" : name;
        output += "\nColor: " + label + "\n";
        byColor[color].forEach(entry => {
          output += "- " + entry.text + "\n";
          if (entry.note && entry.note.trim()) {
            output += "  Note: " + entry.note + "\n";
          }
        });
      });

      output += "\n\n";
    });

    const blob = new Blob([output], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "highlights_filtered.txt";
    a.click();
    URL.revokeObjectURL(url);
  });
}

function exportHighlightsAsCsv() {
  return ext.storage.local.get(["highlights", "customColors"]).then(data => {
    const map = normalizeHighlightsMap(data.highlights || {});
    const colorNameMap = buildColorNameMap(data.customColors);
    const rows = [["URL", "Color", "Color Name", "Timestamp", "Text", "Note"]];

    Object.keys(map).forEach(url => {
      const filtered = filterBySelectedTags(map[url]);
      filtered.forEach(e => {
        const text = (e.text || "").replace(/"/g, '""');
        const note = (e.note || "").replace(/"/g, '""');
        const color = e.color || "";
        const colorName = (colorNameMap[color] || "").replace(/"/g, '""');
        const ts = e.timestamp || "";
        rows.push([url, color, colorName, ts, text, note]);
      });
    });

    const csv = rows.map(r => r.map(v => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "highlights_filtered.csv";
    a.click();
    URL.revokeObjectURL(url);
  });
}

function importCsv(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("No file selected."));
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      try {
        const rows = parseCsv(reader.result || "");
        if (!rows.length) {
          reject(new Error("Invalid CSV format."));
          return;
        }

        const headerCols = rows[0].map(h => (h || "").trim().toLowerCase());
        const urlIdx = headerCols.indexOf("url");
        const colorIdx = headerCols.indexOf("color");
        const textIdx = headerCols.indexOf("text");
        const noteIdx = headerCols.indexOf("note");
        const timestampIdx = headerCols.indexOf("timestamp");

        if (urlIdx === -1 || colorIdx === -1 || textIdx === -1) {
          reject(new Error("Invalid CSV format."));
          return;
        }

        const storageKey = "highlights";

        ext.storage.local.get(storageKey).then(data => {
          const map = normalizeHighlightsMap(data[storageKey] || {});

          for (let i = 1; i < rows.length; i++) {
            const parts = rows[i];
            if (!parts || !parts.length) continue;

            const rawUrl = parts[urlIdx] || "";
            const url = canonicalizeUrl(rawUrl);
            const color = parts[colorIdx] || "yellow";
            const textVal = parts[textIdx] || "";
            const noteVal = noteIdx !== -1 ? (parts[noteIdx] || "") : "";
            const tsVal = timestampIdx !== -1 ? Number(parts[timestampIdx]) : Date.now();

            if (!url || !normalizeHighlightText(textVal)) continue;

            const incoming = {
              id: generateId(),
              text: textVal,
              color: color,
              timestamp: Number.isFinite(tsVal) && tsVal > 0 ? tsVal : Date.now(),
              sourcePage: url,
              keyUrl: url,
              ranges: [],
              note: noteVal
            };

            const existing = map[url] || [];
            map[url] = dedupeEntries(existing.concat(incoming), url);
          }

          ext.storage.local.set({ [storageKey]: map }).then(resolve);
        });
      } catch (e) {
        reject(new Error("Failed to parse CSV."));
      }
    };

    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsText(file);
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (c === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && next === "\n") i++;
      row.push(current);
      current = "";
      if (row.some(cell => (cell || "").length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    current += c;
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    if (row.some(cell => (cell || "").length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

function loadCustomColors(list) {
  if (!list) return;
  list.textContent = "";
  ext.storage.local.get("customColors").then(data => {
    const raw = data.customColors || [];
    const arr = raw.map(c => {
      if (typeof c === "string") return { color: c, name: "" };
      return { color: c.color, name: c.name || "" };
    });

    arr.forEach((c, index) => {
      const row = document.createElement("div");
      row.className = "custom-color-row";

      const swatch = document.createElement("div");
      swatch.className = "custom-color-swatch";
      swatch.style.background = c.color;

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "custom-color-name";
      nameInput.placeholder = "Name (optional)";
      nameInput.value = c.name || "";
      nameInput.addEventListener("change", () => {
        arr[index].name = nameInput.value.trim();
        ext.storage.local.set({ customColors: arr });
      });

      const del = document.createElement("button");
      del.className = "custom-color-delete";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        const filtered = arr.filter(x => x.color !== c.color);
        ext.storage.local.set({ customColors: filtered }).then(() => {
          loadCustomColors(list);
        });
      });

      row.appendChild(swatch);
      row.appendChild(nameInput);
      row.appendChild(del);
      list.appendChild(row);
    });
  });
}