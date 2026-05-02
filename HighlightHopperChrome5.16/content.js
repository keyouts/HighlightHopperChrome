const ext = typeof browser !== "undefined" ? browser : chrome;

let highlightMode = false;
let currentColor = "yellow";

const MAX_HIGHLIGHT_TEXT_LENGTH = 2000;

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

function persistNormalizedHighlightsMap(map) {
  const normalized = normalizeHighlightsMap(map || {});
  return ext.storage.local.set({ highlights: normalized }).then(() => normalized);
}

function unwrapHighlightSpan(span) {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);
  parent.normalize();
}

function clearHighlightsInDOM() {
  const spans = document.querySelectorAll(".highlight-hopper");
  spans.forEach(unwrapHighlightSpan);

  const noteIcons = document.querySelectorAll(".highlight-note-icon");
  noteIcons.forEach(icon => {
    if (icon.parentNode) icon.parentNode.removeChild(icon);
  });

  const popups = document.querySelectorAll(".highlight-note-popup");
  popups.forEach(p => p.remove());
}

function saveHighlightEntry(keyUrl, entry) {
  const storageKey = "highlights";
  const pageUrl = canonicalizeUrl(keyUrl);
  const incoming = cloneEntry(entry, pageUrl);

  ext.storage.local.get(storageKey).then(data => {
    const map = normalizeHighlightsMap(data[storageKey] || {});
    const entries = map[pageUrl] || [];
    map[pageUrl] = dedupeEntries(entries.concat(incoming), pageUrl);
    ext.storage.local.set({ [storageKey]: map }).then(() => {
      try {
        ext.runtime.sendMessage({ action: "refreshPopup" });
      } catch (e) {}
    });
  });
}

function extractTags(note) {
  if (!note) return [];
  return [...note.matchAll(/#([a-zA-Z0-9_-]+)/g)].map(m => m[1].toLowerCase());
}

function updateHighlightNote(id, note) {
  const storageKey = "highlights";
  const pageKey = canonicalizeUrl(window.location.href);

  ext.storage.local.get(storageKey).then(data => {
    const map = normalizeHighlightsMap(data[storageKey] || {});
    const entries = map[pageKey] || [];
    let changed = false;

    entries.forEach(e => {
      if (e.id === id) {
        e.note = note;
        e.timestamp = Date.now();
        changed = true;
      }
    });

    if (changed) {
      map[pageKey] = dedupeEntries(entries, pageKey);
      ext.storage.local.set({ [storageKey]: map }).then(() => {
        try {
          ext.runtime.sendMessage({ action: "refreshPopup" });
        } catch (e) {}
      });
    }
  });
}

function saveHighlight(text, color, id, rangeDesc) {
  const keyUrl = canonicalizeUrl(window.location.href);
  const entry = {
    id: id,
    text: text,
    color: color,
    timestamp: Date.now(),
    sourcePage: keyUrl,
    keyUrl: keyUrl,
    ranges: [rangeDesc],
    note: ""
  };
  saveHighlightEntry(keyUrl, entry);
}

function getXPathForElement(el) {
  if (el === document.body) return "/html/body";
  const parts = [];
  while (el && el.nodeType === 1 && el !== document.documentElement) {
    let index = 1;
    let sibling = el.previousSibling;
    while (sibling) {
      if (sibling.nodeType === 1 && sibling.nodeName === el.nodeName) index++;
      sibling = sibling.previousSibling;
    }
    parts.unshift(el.nodeName.toLowerCase() + "[" + index + "]");
    el = el.parentNode;
  }
  return "/html/" + parts.join("/");
}

function getTextNodeXPath(node) {
  const parent = node.parentNode;
  const parentPath = getXPathForElement(parent);
  let index = 1;
  let sibling = parent.firstChild;
  while (sibling && sibling !== node) {
    if (sibling.nodeType === Node.TEXT_NODE) index++;
    sibling = sibling.nextSibling;
  }
  return parentPath + "/text()[" + index + "]";
}

function getNodeByXPath(path) {
  try {
    return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch (e) {
    return null;
  }
}

function attachNoteIcon(span, note, id) {
  const existingIcon = span.nextSibling && span.nextSibling.classList && span.nextSibling.classList.contains("highlight-note-icon")
    ? span.nextSibling
    : null;

  if (existingIcon) {
    existingIcon.textContent = note && note.trim() ? "✎" : "+";
    existingIcon.setAttribute("aria-label", note && note.trim() ? "Edit note for highlight" : "Add note to highlight");
    existingIcon.dataset.highlightId = id;
    return;
  }

  const icon = document.createElement("button");
  icon.type = "button";
  icon.className = "highlight-note-icon";
  icon.textContent = note && note.trim() ? "✎" : "+";
  icon.setAttribute("aria-label", note && note.trim() ? "Edit note for highlight" : "Add note to highlight");
  icon.dataset.highlightId = id;
  span.insertAdjacentElement("afterend", icon);

  icon.addEventListener("click", ev => {
    ev.stopPropagation();
    openNotePopup(span, icon, id);
  });
}

function openNotePopup(span, icon, id) {
  const existing = document.querySelector(".highlight-note-popup");
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const popup = document.createElement("div");
  popup.className = "highlight-note-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Note for highlight");

  const textarea = document.createElement("textarea");
  popup.appendChild(textarea);

  const controls = document.createElement("div");
  controls.className = "highlight-note-popup-controls";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.textContent = "Delete";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";

  controls.appendChild(saveBtn);
  controls.appendChild(deleteBtn);
  controls.appendChild(closeBtn);
  popup.appendChild(controls);

  document.body.appendChild(popup);

  const rect = icon.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 4;
  let left = rect.left + window.scrollX;
  const popupRect = popup.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  if (left + popupRect.width > viewportWidth - 8) {
    left = viewportWidth - popupRect.width - 8;
  }
  if (left < 4) left = 4;
  popup.style.top = top + "px";
  popup.style.left = left + "px";

  const storageKey = "highlights";
  const pageKey = canonicalizeUrl(window.location.href);
  ext.storage.local.get(storageKey).then(data => {
    const map = normalizeHighlightsMap(data[storageKey] || {});
    const entries = map[pageKey] || [];
    const entry = entries.find(e => e.id === id);
    if (entry && entry.note) {
      textarea.value = entry.note;
    }
  });

  saveBtn.addEventListener("click", () => {
    const value = textarea.value || "";
    updateHighlightNote(id, value);
    icon.textContent = value.trim() ? "✎" : "+";
    icon.setAttribute("aria-label", value.trim() ? "Edit note for highlight" : "Add note to highlight");
    popup.remove();
  });

  deleteBtn.addEventListener("click", () => {
    textarea.value = "";
    updateHighlightNote(id, "");
    icon.textContent = "+";
    icon.setAttribute("aria-label", "Add note to highlight");
    popup.remove();
  });

  closeBtn.addEventListener("click", () => {
    popup.remove();
  });
}

function flashCopiedHighlight(span) {
  const flash = document.createElement("div");
  flash.textContent = "HIGHLIGHT COPIED!";
  flash.style.position = "absolute";
  flash.style.background = "#fff";
  flash.style.border = "3px solid #000";
  flash.style.boxShadow = "3px 3px 0 #000";
  flash.style.padding = "6px 10px";
  flash.style.fontWeight = "700";
  flash.style.borderRadius = "4px";
  flash.style.transform = "translateY(-4px)";
  flash.style.pointerEvents = "none";
  flash.style.zIndex = "2147483647";

  const rect = span.getBoundingClientRect();
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

function isIgnoredTextNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return true;
  const parent = node.parentNode;
  if (!parent || !parent.closest) return false;
  if (parent.closest(".highlight-hopper")) return true;
  if (parent.closest(".highlight-note-icon")) return true;
  if (parent.closest(".highlight-note-popup")) return true;
  if (parent.closest("script")) return true;
  if (parent.closest("style")) return true;
  if (parent.closest("noscript")) return true;
  if (parent.closest("textarea")) return true;
  if (parent.closest("input")) return true;
  if (parent.closest("select")) return true;
  if (parent.closest("option")) return true;
  if (parent.closest("button")) return true;
  if (parent.closest("[contenteditable='true']")) return true;
  return false;
}

function getNodeElement(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function isEditableElement(el) {
  if (!el) return false;
  if (el.closest("textarea")) return true;
  if (el.closest("input")) return true;
  if (el.closest("[contenteditable='true']")) return true;
  return false;
}

function isBlockElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const display = window.getComputedStyle(el).display;
  return display === "block" ||
    display === "flex" ||
    display === "grid" ||
    display === "table" ||
    display === "table-row" ||
    display === "table-cell" ||
    display === "list-item" ||
    display === "flow-root";
}

function getHighlightBlock(node) {
  let el = getNodeElement(node);
  while (el && el !== document.body && el !== document.documentElement) {
    if (isBlockElement(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function getSafeRangeText(range) {
  return normalizeHighlightText(range && range.toString ? range.toString() : "");
}

function rangeContainsForbiddenStructure(range) {
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;

        if (node.nodeType === Node.TEXT_NODE) {
          return NodeFilter.FILTER_ACCEPT;
        }

        const el = node;
        if (el.closest(".highlight-hopper")) return NodeFilter.FILTER_ACCEPT;
        if (el.closest(".highlight-note-icon")) return NodeFilter.FILTER_ACCEPT;
        if (el.closest(".highlight-note-popup")) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const startBlock = getHighlightBlock(range.startContainer);
  const endBlock = getHighlightBlock(range.endContainer);

  while (walker.nextNode()) {
    const node = walker.currentNode;

    if (node.nodeType === Node.TEXT_NODE) {
      if (isIgnoredTextNode(node) && normalizeHighlightText(node.nodeValue || "")) {
        return true;
      }
      continue;
    }

    const el = node;
    if (!el || el === startBlock || el === endBlock) continue;

    if (el.classList && (el.classList.contains("highlight-hopper") || el.classList.contains("highlight-note-icon") || el.classList.contains("highlight-note-popup"))) {
      return true;
    }

    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "textarea" || tag === "input" || tag === "select" || tag === "option" || tag === "button") {
      return true;
    }

    if (isEditableElement(el)) {
      return true;
    }

    if (isBlockElement(el)) {
      return true;
    }
  }

  return false;
}

function isRangeSafeToHighlight(range) {
  if (!range || range.collapsed) return false;

  const text = getSafeRangeText(range);
  if (!text) return false;
  if (text.length > MAX_HIGHLIGHT_TEXT_LENGTH) return false;

  const startEl = getNodeElement(range.startContainer);
  const endEl = getNodeElement(range.endContainer);

  if (!startEl || !endEl) return false;
  if (isEditableElement(startEl) || isEditableElement(endEl)) return false;

  const startBlock = getHighlightBlock(range.startContainer);
  const endBlock = getHighlightBlock(range.endContainer);

  if (!startBlock || !endBlock) return false;
  if (startBlock !== endBlock) return false;
  if (startBlock === document.body || endBlock === document.body) return false;

  if (rangeContainsForbiddenStructure(range)) return false;

  return true;
}

function buildHighlightSpan(color, id, text) {
  const span = document.createElement("span");
  span.className = "highlight-hopper";
  span.dataset.color = color;
  span.dataset.highlightId = id;
  span.style.background = color;
  span.setAttribute("role", "mark");
  span.setAttribute("tabindex", "0");
  span.setAttribute("aria-label", "Highlighted text in " + color + ": " + text);
  return span;
}

function wrapRangeInHighlight(range, color, id, text, note) {
  if (!isRangeSafeToHighlight(range)) return false;

  const fragment = range.extractContents();
  if (!fragment || !normalizeHighlightText(fragment.textContent || "")) return false;

  const span = buildHighlightSpan(color, id, text);
  span.appendChild(fragment);
  range.insertNode(span);
  attachNoteIcon(span, note || "", id);
  return true;
}

function applyStoredRangeHighlight(entry) {
  if (!entry.ranges || entry.ranges.length !== 1) return false;

  const r = entry.ranges[0];
  const startNode = getNodeByXPath(r.startXPath);
  const endNode = getNodeByXPath(r.endXPath);

  if (!startNode || !endNode || startNode.nodeType !== 3 || endNode.nodeType !== 3) return false;
  if (isIgnoredTextNode(startNode) || isIgnoredTextNode(endNode)) return false;

  const range = document.createRange();
  const startOffset = Math.min(r.startOffset, startNode.nodeValue.length);
  const endOffset = Math.min(r.endOffset, endNode.nodeValue.length);

  if (startNode === endNode && endOffset <= startOffset) return false;

  try {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
  } catch (e) {
    return false;
  }

  if (!isRangeSafeToHighlight(range)) return false;

  return wrapRangeInHighlight(range, entry.color, entry.id, entry.text, entry.note || "");
}

function highlightFirstOccurrence(text, color, id, note) {
  const needle = normalizeHighlightText(text);
  if (!needle) return false;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (isIgnoredTextNode(node)) continue;

    const rawValue = node.nodeValue || "";
    const normalizedValue = rawValue.replace(/\s+/g, " ");
    const idx = normalizedValue.indexOf(needle);

    if (idx === -1) continue;

    const rawStart = rawValue.indexOf(needle);
    if (rawStart === -1) continue;

    const range = document.createRange();
    range.setStart(node, rawStart);
    range.setEnd(node, rawStart + needle.length);

    if (!isRangeSafeToHighlight(range)) return false;

    return wrapRangeInHighlight(range, color, id, text, note || "");
  }

  return false;
}

function applyHighlightsForCurrentPage() {
  const storageKey = "highlights";
  const pageKey = canonicalizeUrl(window.location.href);

  ext.storage.local.get(storageKey).then(data => {
    const rawMap = data[storageKey] || {};
    const map = normalizeHighlightsMap(rawMap);
    const rawSerialized = JSON.stringify(rawMap);
    const normalizedSerialized = JSON.stringify(map);

    if (rawSerialized !== normalizedSerialized) {
      ext.storage.local.set({ [storageKey]: map });
    }

    clearHighlightsInDOM();

    const entries = map[pageKey] || [];
    entries.forEach(entry => {
      const applied = applyStoredRangeHighlight(entry);
      if (!applied && entry.text) {
        highlightFirstOccurrence(entry.text, entry.color, entry.id, entry.note || "");
      }
    });
  });
}

function undoLastHighlight() {
  const storageKey = "highlights";
  const pageKey = canonicalizeUrl(window.location.href);

  ext.storage.local.get(storageKey).then(data => {
    const map = normalizeHighlightsMap(data[storageKey] || {});
    const entries = map[pageKey] || [];
    if (!entries.length) return;

    let lastIndex = 0;
    let lastTs = entries[0].timestamp || 0;

    for (let i = 1; i < entries.length; i++) {
      if ((entries[i].timestamp || 0) > lastTs) {
        lastTs = entries[i].timestamp || 0;
        lastIndex = i;
      }
    }

    const last = entries[lastIndex];
    entries.splice(lastIndex, 1);
    map[pageKey] = dedupeEntries(entries, pageKey);

    ext.storage.local.set({ [storageKey]: map }).then(() => {
      const spans = document.querySelectorAll('.highlight-hopper[data-highlight-id="' + last.id + '"]');
      spans.forEach(unwrapHighlightSpan);

      const icons = document.querySelectorAll('.highlight-note-icon[data-highlight-id="' + last.id + '"]');
      icons.forEach(icon => {
        if (icon.parentNode) icon.parentNode.removeChild(icon);
      });

      try {
        ext.runtime.sendMessage({ action: "refreshPopup" });
      } catch (e) {}
    });
  });
}

function tryCreateHighlightFromSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

  const liveRange = sel.getRangeAt(0);
  const text = getSafeRangeText(liveRange);

  if (!text) {
    sel.removeAllRanges();
    return;
  }

  const range = liveRange.cloneRange();

  if (!isRangeSafeToHighlight(range)) {
    sel.removeAllRanges();
    return;
  }

  const startXPath = getTextNodeXPath(range.startContainer);
  const endXPath = getTextNodeXPath(range.endContainer);
  const startOffset = range.startOffset;
  const endOffset = range.endOffset;
  const id = generateId();

  const applied = wrapRangeInHighlight(range, currentColor, id, text, "");
  if (!applied) {
    sel.removeAllRanges();
    return;
  }

  const desc = {
    startXPath: startXPath,
    endXPath: endXPath,
    startOffset: startOffset,
    endOffset: endOffset
  };

  saveHighlight(text, currentColor, id, desc);

  sel.removeAllRanges();

  try {
    ext.runtime.sendMessage({ action: "refreshPopup" });
  } catch (e) {}
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyHighlightsForCurrentPage);
} else {
  applyHighlightsForCurrentPage();
}

document.addEventListener("mouseup", () => {
  if (!highlightMode) return;
  tryCreateHighlightFromSelection();
});

ext.runtime.onMessage.addListener(msg => {
  if (msg.action === "toggleHighlightMode") highlightMode = msg.enabled;
  if (msg.action === "setColor") currentColor = msg.color;

  if (msg.action === "clearHighlights") {
    clearHighlightsInDOM();
    const pageKey = canonicalizeUrl(window.location.href);
    const storageKey = "highlights";

    ext.storage.local.get(storageKey).then(data => {
      const map = normalizeHighlightsMap(data[storageKey] || {});
      delete map[pageKey];
      ext.storage.local.set({ [storageKey]: map }).then(() => {
        try {
          ext.runtime.sendMessage({ action: "refreshPopup" });
        } catch (e) {}
      });
    });
  }

  if (msg.action === "undoLastHighlight") undoLastHighlight();
});