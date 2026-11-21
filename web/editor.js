// Textarea-editor primitives: auto-grow, caret geometry for popovers, and
// the markdown conveniences (list continuation, indent, inline wrapping).

export function autoResize(ta) {
  ta.style.height = "auto";
  const min = Math.max(window.innerHeight * 0.45, 320);
  ta.style.height = Math.max(ta.scrollHeight, min) + "px";
}

export function caretCoords(ta, pos) {
  const box = ta.getBoundingClientRect();
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  const props = [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "textTransform",
    "wordSpacing",
    "textIndent",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "boxSizing",
  ];
  mirror.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:break-word;";
  mirror.style.top = box.top + "px";
  mirror.style.left = box.left + "px";
  mirror.style.width = box.width + "px";
  for (const p of props) mirror.style[p] = cs[p];
  mirror.textContent = ta.value.slice(0, pos);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const r = marker.getBoundingClientRect();
  const h = r.height || parseFloat(cs.lineHeight) || 20;
  mirror.remove();
  return { left: r.left, top: r.top - ta.scrollTop, height: h };
}

export function insertText(ta, text) {
  ta.focus();
  const ok = document.execCommand && document.execCommand("insertText", false, text);
  if (!ok) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    ta.setRangeText(text, s, e, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

export function replaceRange(ta, start, end, text, selMode = "end") {
  ta.setRangeText(text, start, end, selMode);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function notify(ta) {
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Wrap the selection (or insert a placeholder) with markdown markers. */
export function wrapSelection(ta, before, after = before, placeholder = "") {
  ta.focus();
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  const text = sel || placeholder;
  ta.setRangeText(before + text + after, s, e, "end");
  if (!sel && placeholder) {
    ta.setSelectionRange(s + before.length, s + before.length + placeholder.length);
  }
  notify(ta);
}

/** Prefix every line touched by the selection with a marker (or un-prefix). */
export function prefixLines(ta, marker, removePrefix) {
  const val = ta.value;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const lineStart = val.lastIndexOf("\n", s - 1) + 1;
  let lineEnd = val.indexOf("\n", e);
  if (lineEnd === -1) lineEnd = val.length;
  const block = val.slice(lineStart, lineEnd);
  let out;
  if (removePrefix) {
    out = block
      .split("\n")
      .map((l) => l.replace(removePrefix, ""))
      .join("\n");
  } else {
    out = block
      .split("\n")
      .map((l) => marker + l)
      .join("\n");
  }
  ta.setRangeText(out, lineStart, lineEnd, "select");
  notify(ta);
}

export function indentSelection(ta, outdent = false) {
  const val = ta.value;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const lineStart = val.lastIndexOf("\n", s - 1) + 1;
  const block = val.slice(lineStart, e);
  const lines = block.split("\n");
  const out = lines
    .map((l) => {
      if (outdent) return l.replace(/^ {1,2}/, "").replace(/^\t/, "");
      return "  " + l;
    })
    .join("\n");
  ta.setRangeText(out, lineStart, e, "end");
  ta.setSelectionRange(lineStart + (outdent ? 0 : 2), lineStart + out.length);
  notify(ta);
}

/**
 * Enter inside a list / task / quote line continues the marker; Enter on an
 * empty item removes it (Notion/Obsidian behaviour). Returns true if handled.
 */
export function handleEnter(ta, e) {
  if (ta.selectionStart !== ta.selectionEnd) return false;
  const val = ta.value;
  const caret = ta.selectionStart;
  const lineStart = val.lastIndexOf("\n", caret - 1) + 1;
  const line = val.slice(lineStart, caret);

  const quote = line.match(/^(\s*>\s?)(.*)$/);
  if (quote && !/^\s*>?\s*[-*+]/.test(quote[2])) {
    e.preventDefault();
    if (!quote[2].trim()) {
      ta.setRangeText("", lineStart, caret, "start");
      notify(ta);
    } else {
      insertText(ta, "\n" + quote[1]);
    }
    return true;
  }

  const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
  if (!m) return false;
  e.preventDefault();
  const [, indent, marker, task = "", content] = m;
  if (!content.trim()) {
    ta.setRangeText("", lineStart, caret, "start");
    notify(ta);
    return true;
  }
  let next = marker;
  if (/^\d/.test(marker)) next = String(parseInt(marker, 10) + 1) + marker.slice(-1);
  insertText(ta, "\n" + indent + next + " " + (task ? "[ ] " : ""));
  return true;
}

/** Toggle the markdown checkbox at the caret line (⌘⇧T style helper). */
export function currentLine(ta) {
  const val = ta.value;
  const caret = ta.selectionStart;
  const start = val.lastIndexOf("\n", caret - 1) + 1;
  let end = val.indexOf("\n", caret);
  if (end === -1) end = val.length;
  return { start, end, text: val.slice(start, end) };
}
