const ext = typeof browser !== "undefined" ? browser : chrome;

let activeTagFilter = null;
let activeSearchQuery = "";

document.addEventListener("DOMContentLoaded", () => {
  const toggleBtn = document.getElementById("toggle-btn");
  const undoBtn = document.getElementById("undo-btn");
  const clearBtn = document.getElementById("clear-btn");
  const openOptionsBtn = document.getElementById("open-options-btn");
  const openPrivacyBtn = document.getElementById("open-privacy-btn");
  const colorPicker = document.getElementById("color-picker");
  const highlightList = document.getElementById("highlight-list");
  const tagBar = document.getElementById("tag-bar");
  const searchInput = document.getElementById("search-input");

  let highlightMode = false;

  toggleBtn.addEventListener("click", () => {
    highlightMode = !highlightMode;
    toggleBtn.textContent = highlightMode ? "Disable Highlight Mode" : "Enable Highlight Mode";
    toggleBtn.setAttribute("aria-pressed", highlightMode ? "true" : "false");
    sendToActiveTab({ action: "toggleHighlightMode", enabled: highlightMode });
  });

  undoBtn.addEventListener("click", () => {
    sendToActiveTab({ action: "undoLastHighlight" });
    setTimeout(() => loadHighlights(highlightList, tagBar), 150);
  });

  clearBtn.addEventListener("click", () => {
    sendToActiveTab({ action: "clearHighlights" });
    setTimeout(() => loadHighlights(highlightList, tagBar), 200);
  });

  openOptionsBtn.addEventListener("click", () => {
    ext.runtime.openOptionsPage();
  });

  openPrivacyBtn.addEventListener("click", () => {
    ext.tabs.create({ url: ext.runtime.getURL("privacy_policy.html") });
  });

  colorPicker.addEventListener("click", e => {
    const swatch = e.target.closest(".color-swatch");
    if (!swatch) return;
    const color = swatch.dataset.color;
    updateSelectedSwatch(colorPicker, swatch);
    sendToActiveTab({ action: "setColor", color });
  });

  colorPicker.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      const swatch = e.target.closest(".color-swatch");
      if (!swatch) return;
      const color = swatch.dataset.color;
      updateSelectedSwatch(colorPicker, swatch);
      sendToActiveTab({ action: "setColor", color });
      e.preventDefault();
    }
  });

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      activeSearchQuery = searchInput.value.trim().toLowerCase();
      loadHighlights(highlightList, tagBar);
    });
  }

  loadCustomSwatches(colorPicker);
  loadHighlights(highlightList, tagBar);

  ext.runtime.onMessage.addListener(msg => {
    if (msg && msg.action === "refreshPopup") {
      loadHighlights(highlightList, tagBar);
    }
  });
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

function sendToActiveTab(msg) {
  ext.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) ext.tabs.sendMessage(tabs[0].id, msg);
  });
}

function loadCustomSwatches(container) {
  ext.storage.local.get("customColors").then(data => {
    const raw = data.customColors || [];
    const customs = raw.map(c => {
      if (typeof c === "string") return { color: c, name: "" };
      return { color: c.color, name: c.name || "" };
    });

    customs.forEach(c => {
      const swatch = document.createElement("div");
      swatch.className = "color-swatch";
      swatch.dataset.color = c.color;
      swatch.style.background = c.color;
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-label", "Select " + (c.name || c.color) + " highlight color");
      swatch.setAttribute("aria-checked", "false");
      swatch.tabIndex = 0;
      container.appendChild(swatch);
    });

    initializeSelectedSwatch(container);
  });
}

function extractTags(note) {
  if (!note) return [];
  return [...note.matchAll(/#([a-zA-Z0-9_-]+)/g)].map(m => m[1].toLowerCase());
}

function matchesSearch(entry) {
  if (!activeSearchQuery) return true;
  const t = (entry.text || "").toLowerCase();
  const n = (entry.note || "").toLowerCase();
  return t.includes(activeSearchQuery) || n.includes(activeSearchQuery);
}

function loadHighlights(container, tagBar) {
  container.textContent = "";
  tagBar.textContent = "";

  ext.storage.local.get("highlights").then(data => {
    const originalMap = data.highlights || {};
    const map = normalizeHighlightsMap(originalMap);

    if (JSON.stringify(map) !== JSON.stringify(originalMap)) {
      ext.storage.local.set({ highlights: map });
    }

    const urls = Object.keys(map);

    if (!urls.length) {
      container.textContent = "No highlights saved.";
      return;
    }

    const allTags = new Set();

    urls.forEach(url => {
      map[url].forEach(e => {
        extractTags(e.note || "").forEach(t => allTags.add(t));
      });
    });

    if (allTags.size > 0) {
      allTags.forEach(tag => {
        const pill = document.createElement("div");
        pill.className = "tag-pill";
        pill.textContent = "#" + tag;
        pill.dataset.tag = tag;
        pill.addEventListener("click", () => {
          activeTagFilter = tag;
          loadHighlights(container, tagBar);
        });
        tagBar.appendChild(pill);
      });

      const clear = document.createElement("div");
      clear.className = "tag-pill clear-pill";
      clear.textContent = "Clear Filter";
      clear.addEventListener("click", () => {
        activeTagFilter = null;
        loadHighlights(container, tagBar);
      });
      tagBar.appendChild(clear);
    }

    urls.forEach(url => {
      const entries = map[url];
      let filtered = entries;

      if (activeTagFilter) {
        filtered = filtered.filter(e => extractTags(e.note || "").includes(activeTagFilter));
      }

      filtered = filtered.filter(matchesSearch);

      if (!filtered.length) return;

      const group = document.createElement("div");
      group.className = "source-group";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Highlights for " + url);

      const header = document.createElement("div");
      header.className = "source-header";
      header.setAttribute("role", "button");
      header.setAttribute("tabindex", "0");
      header.setAttribute("aria-expanded", "false");
      header.setAttribute("aria-label", "Expand or collapse highlights for " + url);

      const title = document.createElement("div");
      title.className = "source-title";
      title.textContent = url;

      const colors = [...new Set(filtered.map(e => e.color))];

      const strip = document.createElement("div");
      strip.className = "source-color-strip";
      strip.setAttribute("role", "list");

      const allPill = document.createElement("div");
      allPill.className = "source-color-pill";
      allPill.style.background = "#000";
      allPill.dataset.color = "all";
      allPill.setAttribute("role", "button");
      allPill.setAttribute("tabindex", "0");
      allPill.setAttribute("aria-label", "Show all highlight colors for this page");
      allPill.addEventListener("click", ev => {
        ev.stopPropagation();
        renderEntries(list, filtered);
      });
      strip.appendChild(allPill);

      colors.forEach(c => {
        const pill = document.createElement("div");
        pill.className = "source-color-pill";
        pill.style.background = c;
        pill.dataset.color = c;
        pill.setAttribute("role", "button");
        pill.setAttribute("tabindex", "0");
        pill.setAttribute("aria-label", "Filter highlights by color " + c);
        pill.addEventListener("click", ev => {
          ev.stopPropagation();
          renderEntries(list, filtered.filter(e => e.color === c));
        });
        strip.appendChild(pill);
      });

      header.appendChild(title);
      header.appendChild(strip);

      const list = document.createElement("div");
      list.className = "highlight-list-inner";
      list.setAttribute("role", "list");

      header.addEventListener("click", () => {
        const expanded = group.classList.toggle("expanded");
        header.setAttribute("aria-expanded", expanded ? "true" : "false");
      });

      header.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          const expanded = group.classList.toggle("expanded");
          header.setAttribute("aria-expanded", expanded ? "true" : "false");
          e.preventDefault();
        }
      });

      group.appendChild(header);
      group.appendChild(list);
      container.appendChild(group);

      renderEntries(list, filtered);
    });
  });
}

function renderEntries(container, entries) {
  container.textContent = "";
  entries
    .slice()
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .forEach(e => {
      const item = document.createElement("div");
      item.className = "highlight-item";
      item.style.borderLeftColor = e.color;
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");

      const textDiv = document.createElement("div");
      textDiv.textContent = e.text;
      item.appendChild(textDiv);

      item.addEventListener("click", () => {
        navigator.clipboard.writeText(e.text);
        flashCopied(item, "HIGHLIGHT COPIED!");
      });

      if (e.note && e.note.trim()) {
        const noteDiv = document.createElement("div");
        noteDiv.className = "highlight-note-preview";
        noteDiv.textContent = e.note;

        noteDiv.addEventListener("click", ev => {
          ev.stopPropagation();
          navigator.clipboard.writeText(e.note);
          flashCopied(noteDiv, "NOTE COPIED!");
        });

        item.appendChild(noteDiv);
      }

      container.appendChild(item);
    });
}

function flashCopied(target, message) {
  const flash = document.createElement("div");
  flash.textContent = message;
  flash.style.position = "absolute";
  flash.style.background = "#fff";
  flash.style.border = "3px solid #000";
  flash.style.boxShadow = "3px 3px 0 #000";
  flash.style.padding = "6px 10px";
  flash.style.fontWeight = "700";
  flash.style.borderRadius = "4px";
  flash.style.transform = "translateY(-4px)";
  flash.style.pointerEvents = "none";
  flash.style.zIndex = "9999";
  flash.setAttribute("role", "status");
  flash.setAttribute("aria-live", "polite");

  const rect = target.getBoundingClientRect();
  flash.style.left = rect.left + "px";
  flash.style.top = rect.top + "px";

  document.body.appendChild(flash);

  setTimeout(() => {
    flash.style.opacity = "0";
    flash.style.transition = "opacity 0.2s ease";
  }, 300);

  setTimeout(() => {
    flash.remove();
  }, 500);
}

function updateSelectedSwatch(colorPicker, activeSwatch) {
  const all = colorPicker.querySelectorAll(".color-swatch");
  all.forEach(s => {
    s.classList.remove("swatch-selected");
    s.setAttribute("aria-checked", "false");
  });
  activeSwatch.classList.add("swatch-selected");
  activeSwatch.setAttribute("aria-checked", "true");
}

function initializeSelectedSwatch(colorPicker) {
  const swatches = colorPicker.querySelectorAll(".color-swatch");
  if (!swatches.length) return;
  swatches.forEach(s => {
    s.classList.remove("swatch-selected");
    s.setAttribute("aria-checked", "false");
  });
  swatches[0].classList.add("swatch-selected");
  swatches[0].setAttribute("aria-checked", "true");
}