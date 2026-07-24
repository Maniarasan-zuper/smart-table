"use strict";

const { Plugin, Menu, Modal, Notice, MarkdownView, setIcon } = require("obsidian");

// ---------------------------------------------------------------------------
// Data model helpers
// ---------------------------------------------------------------------------

// Background / text colour pairs for status & select pills.
const PALETTE = {
  gray: ["#e6e4df", "#4a4843"],
  blue: ["#d6e6ff", "#1f4b99"],
  green: ["#cdefd3", "#1f7a3d"],
  yellow: ["#ffeab3", "#7a5d00"],
  orange: ["#ffdcc2", "#9a4a12"],
  red: ["#ffd3d3", "#9a1f1f"],
  purple: ["#e7d6fb", "#5a2ca0"],
  pink: ["#ffd6ec", "#9a256e"],
};
const PALETTE_KEYS = Object.keys(PALETTE);

const COLUMN_TYPES = [
  "text",
  "number",
  "date",
  "datetime",
  "checkbox",
  "select",
  "multiselect",
  "status",
];
const TYPE_LABELS = {
  text: "Text",
  number: "Number",
  date: "Date",
  datetime: "Date & time",
  checkbox: "Checkbox",
  select: "Select",
  multiselect: "Multi-select",
  status: "Status",
};

// Column types whose cells hold one or more chosen options (with colors).
const OPTION_TYPES = ["select", "multiselect", "status"];

// A multi-select cell stores an array of labels; coerce any stored value to one.
function asTags(v) {
  if (Array.isArray(v)) return v.slice();
  return v == null || v === "" ? [] : [String(v)];
}

// Normalize a date-time string to the value an <input type="datetime-local">
// expects (YYYY-MM-DDTHH:mm), accepting either a space or "T" separator and an
// optional seconds component. Returns the trimmed input unchanged if it doesn't
// look like a date-time.
function toDatetimeLocal(s) {
  const m = String(s == null ? "" : s)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? m[1] + "T" + m[2] : String(s == null ? "" : s).trim();
}

// Column sizing. Widths are stored per column (in px) once a user drags to
// resize; until then each type falls back to a sensible default. The grid uses
// table-layout: fixed so these widths are authoritative and text can wrap.
const DEFAULT_COL_WIDTHS = {
  checkbox: 90,
  date: 140,
  datetime: 180,
  number: 110,
  status: 150,
  select: 150,
  multiselect: 200,
  text: 220,
};
const FALLBACK_COL_WIDTH = 180;
const MIN_COL_WIDTH = 60;
const TRAILING_COL_WIDTH = 34; // the add-column / delete-row gutter
const SELECT_COL_WIDTH = 42; // the leading checkbox gutter (selection mode)

function columnWidth(col) {
  const w = typeof col.width === "number" ? col.width : DEFAULT_COL_WIDTHS[col.type];
  return Math.max(MIN_COL_WIDTH, w || FALLBACK_COL_WIDTH);
}

// Reorder helper for drag-and-drop: move the item with id `fromId` to just
// before or after `toId` within `arr` (mutates in place).
function moveById(arr, fromId, toId, after) {
  if (fromId === toId) return;
  const fromIdx = arr.findIndex((x) => x.id === fromId);
  if (fromIdx < 0) return;
  const [item] = arr.splice(fromIdx, 1);
  let toIdx = arr.findIndex((x) => x.id === toId);
  if (toIdx < 0) {
    arr.push(item);
    return;
  }
  if (after) toIdx += 1;
  arr.splice(toIdx, 0, item);
}

function typeIcon(t) {
  return (
    {
      text: "text",
      number: "hash",
      date: "calendar",
      datetime: "calendar-clock",
      checkbox: "check-square",
      select: "chevron-down-circle",
      multiselect: "tags",
      status: "circle-dot",
    }[t] || "text"
  );
}

let idCounter = 0;
function uid(prefix) {
  idCounter += 1;
  return (
    prefix + idCounter.toString(36) + "-" + Math.random().toString(36).slice(2, 7)
  );
}

function defaultStatusOptions() {
  return [
    { label: "Todo", color: "gray" },
    { label: "In progress", color: "blue" },
    { label: "Done", color: "green" },
  ];
}

function defaultState() {
  const c1 = uid("c"),
    c2 = uid("c"),
    c3 = uid("c");
  return {
    columns: [
      { id: c1, name: "Name", type: "text" },
      { id: c2, name: "Status", type: "status", options: defaultStatusOptions() },
      { id: c3, name: "Due", type: "date" },
    ],
    rows: [
      { id: uid("r"), cells: { [c1]: "First task", [c2]: "Todo", [c3]: "" } },
      {
        id: uid("r"),
        cells: { [c1]: "Second task", [c2]: "In progress", [c3]: "" },
      },
    ],
    sort: null, // { col, dir: "asc" | "desc" }
    filters: {}, // { [colId]: string }
    showFilters: false,
  };
}

// Returns a state object, or null if the source is present but unparseable.
function parseState(source) {
  const t = (source || "").trim();
  if (!t) return defaultState();
  let s;
  try {
    s = JSON.parse(t);
  } catch (e) {
    return null;
  }
  if (!s || !Array.isArray(s.columns) || !Array.isArray(s.rows)) return null;
  s.filters = s.filters || {};
  s.rows.forEach((r) => (r.cells = r.cells || {}));
  return s;
}

function compareValues(a, b, type) {
  a = a == null ? "" : a;
  b = b == null ? "" : b;
  if (type === "number") return (parseFloat(a) || 0) - (parseFloat(b) || 0);
  if (type === "checkbox")
    return (a === true || a === "true" ? 1 : 0) - (b === true || b === "true" ? 1 : 0);
  return a.toString().localeCompare(b.toString(), undefined, { numeric: true });
}

// Range filters store two values joined by "|" (either side may be blank).
function splitPair(s) {
  const parts = String(s == null ? "" : s).split("|");
  return [parts[0] || "", parts[1] || ""];
}
function joinPair(a, b) {
  a = (a || "").trim();
  b = (b || "").trim();
  return a === "" && b === "" ? "" : a + "|" + b;
}

// Type-aware filter: does `raw` (a cell value) pass `fv` (the column's filter)?
function matchesFilter(col, raw, fv) {
  if (fv == null || fv === "") return true;
  if (col.type === "checkbox") {
    const checked = raw === true || raw === "true";
    return fv === "true" ? checked : fv === "false" ? !checked : true;
  }
  if (col.type === "select" || col.type === "status") {
    return (raw == null ? "" : String(raw)) === fv;
  }
  if (col.type === "multiselect") {
    return asTags(raw).includes(fv);
  }
  if (col.type === "number") {
    const [minS, maxS] = splitPair(fv);
    if (minS === "" && maxS === "") return true;
    const n = parseFloat(raw);
    if (isNaN(n)) return false;
    if (minS !== "" && n < parseFloat(minS)) return false;
    if (maxS !== "" && n > parseFloat(maxS)) return false;
    return true;
  }
  if (col.type === "date" || col.type === "datetime") {
    const [from, to] = splitPair(fv);
    if (from === "" && to === "") return true;
    // Stored as YYYY-MM-DD (or YYYY-MM-DDTHH:mm), both of which compare
    // chronologically as strings.
    const v = raw == null ? "" : String(raw);
    if (!v) return false;
    if (from && v < from) return false;
    if (to && v > to) return false;
    return true;
  }
  // text
  return (raw == null ? "" : String(raw).toLowerCase()).includes(
    String(fv).toLowerCase()
  );
}

// Rows after applying filters and sort (does not mutate state.rows).
function viewRows(state) {
  let rows = state.rows.slice();
  rows = rows.filter((r) =>
    state.columns.every((c) =>
      matchesFilter(c, r.cells[c.id], state.filters[c.id])
    )
  );
  if (state.sort) {
    const col = state.columns.find((c) => c.id === state.sort.col);
    if (col) {
      rows.sort((a, b) => compareValues(a.cells[col.id], b.cells[col.id], col.type));
      if (state.sort.dir === "desc") rows.reverse();
    }
  }
  return rows;
}

function defaultCell(type) {
  if (type === "checkbox") return false;
  if (type === "multiselect") return [];
  return "";
}

// Deep-clone a value so a duplicated/pasted cell shares no reference with its
// source (arrays for multi-select, etc.).
function cloneValue(v) {
  return Array.isArray(v) ? v.slice() : v;
}

// A fresh row whose cells are copied from `cellsById`, with a new id — used by
// Duplicate row and Paste. Only keeps values for columns that still exist.
function rowFromCells(columns, cellsById) {
  const cells = {};
  columns.forEach((c) => {
    cells[c.id] =
      cellsById && c.id in cellsById ? cloneValue(cellsById[c.id]) : defaultCell(c.type);
  });
  return { id: uid("r"), cells };
}

// In-app clipboard for copied rows (module-level so you can paste into another
// table). Stores plain cell maps keyed by column id.
let rowClipboard = [];

function addColumn(state, type) {
  const col = { id: uid("c"), name: "Column " + (state.columns.length + 1), type };
  if (type === "status") col.options = defaultStatusOptions();
  if (type === "select" || type === "multiselect") col.options = [];
  state.columns.push(col);
  state.rows.forEach((r) => (r.cells[col.id] = defaultCell(type)));
}

function changeColumnType(col, type) {
  col.type = type;
  if (OPTION_TYPES.includes(type) && !Array.isArray(col.options)) {
    col.options = type === "status" ? defaultStatusOptions() : [];
  }
}

// Convert a single cell value from one column type to another. Returns
// { value, ok }: ok=false means the (non-empty) value can't be represented in
// the target type and the caller should treat it as lost. text is a universal
// target; option types (select/status/multiselect) preserve values by turning
// them into options.
function convertValue(v, from, to) {
  if (to === from) return { value: v, ok: true };
  const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
  if (empty) return { value: defaultCell(to), ok: true };

  const str =
    v === true
      ? "true"
      : v === false
      ? "false"
      : Array.isArray(v)
      ? v.join(", ")
      : String(v);

  if (to === "text") return { value: str, ok: true };
  if (to === "number") {
    const n = parseFloat(str);
    return isNaN(n) ? { value: "", ok: false } : { value: String(n), ok: true };
  }
  if (to === "checkbox") {
    const s = str.trim().toLowerCase();
    if (["true", "yes", "1", "x", "[x]", "done", "checked"].includes(s))
      return { value: true, ok: true };
    if (["false", "no", "0", "[ ]", "[]", "unchecked"].includes(s))
      return { value: false, ok: true };
    return { value: false, ok: false };
  }
  if (to === "date") {
    const m = str.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? { value: m[1], ok: true } : { value: "", ok: false };
  }
  if (to === "datetime") {
    const dl = toDatetimeLocal(str);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dl)) return { value: dl, ok: true };
    const d = str.trim().match(/^(\d{4}-\d{2}-\d{2})$/);
    if (d) return { value: d[1] + "T00:00", ok: true };
    return { value: "", ok: false };
  }
  if (to === "select" || to === "status") {
    return { value: Array.isArray(v) ? String(v[0] || "") : str, ok: true };
  }
  if (to === "multiselect") {
    return { value: Array.isArray(v) ? v : str ? [str] : [], ok: true };
  }
  return { value: str, ok: true };
}

function addOption(col, label) {
  col.options = col.options || [];
  if (col.options.some((o) => o.label === label)) return;
  const color = PALETTE_KEYS[col.options.length % PALETTE_KEYS.length];
  col.options.push({ label, color });
}

// ---------------------------------------------------------------------------
// Persistence: rewrite the fenced code block this widget was rendered from.
// ---------------------------------------------------------------------------

async function persist(app, ctx, el, state) {
  const info = ctx.getSectionInfo(el);
  if (!info) return;
  const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!file) return;
  // Store minified (single line): a large table stays ~3 lines in the note
  // instead of thousands, so Obsidian renders it immediately rather than
  // lazily (which showed big tables as raw source until scrolled/edited).
  const block = "```smart-table\n" + JSON.stringify(state) + "\n```";
  // `info.lineEnd` from getSectionInfo() can be stale in Live Preview (the
  // widget is reused, not re-rendered, after we edit the file). Trusting it
  // would splice the wrong range once the block grows/shrinks and corrupt the
  // note. So we locate the block's fences fresh at write time.
  const apply = (data) => {
    const lines = data.split("\n");
    const isOpen = (i) => /^```+\s*smart-table\s*$/.test(lines[i] || "");
    const isFence = (i) => /^```+\s*$/.test(lines[i] || "");

    let start = info.lineStart;
    if (!isOpen(start)) {
      // Realign to the smart-table opening fence nearest the cached position.
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < lines.length; i++) {
        if (isOpen(i)) {
          const d = Math.abs(i - info.lineStart);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
      }
      if (best === -1) return data; // can't locate the block — leave file as-is
      start = best;
    }

    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (isFence(i)) {
        end = i;
        break;
      }
    }
    if (end === -1) return data; // no closing fence — abort rather than corrupt

    lines.splice(start, end - start + 1, block);
    return lines.join("\n");
  };
  if (app.vault.process) {
    await app.vault.process(file, apply);
  } else {
    const data = await app.vault.read(file);
    await app.vault.modify(file, apply(data));
  }
}

// ---------------------------------------------------------------------------
// Export the table (as currently sorted/filtered) to a downloaded CSV file.
// ---------------------------------------------------------------------------

function exportRowsCSV(columns, rows, filename) {
  // RFC 4180 quoting: wrap fields containing quotes, commas, or newlines.
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map((c) => esc(c.name)).join(",")];
  rows.forEach((row) => {
    lines.push(
      columns
        .map((c) => {
          const v = row.cells[c.id];
          if (c.type === "checkbox") return esc(v === true || v === "true");
          if (c.type === "datetime") return esc(v ? String(v).replace("T", " ") : "");
          if (c.type === "multiselect") return esc(asTags(v).join(", "));
          return esc(v);
        })
        .join(",")
    );
  });
  // Prepend a BOM so Excel reads UTF-8 correctly.
  const blob = new Blob(["﻿" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "smart-table.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportTableCSV(state) {
  exportRowsCSV(state.columns, viewRows(state), "smart-table.csv");
}

// ---------------------------------------------------------------------------
// Convert a plain Markdown table (pipe syntax) into a Smart Table state.
// ---------------------------------------------------------------------------

// Split a pipe-delimited row into trimmed cells, honouring escaped pipes (\|)
// and dropping the empty cells produced by leading / trailing border pipes.
function splitTableRow(line) {
  const cells = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

// True for a Markdown delimiter row like `| --- | :--: |`.
function isDelimiterRow(line) {
  const cells = splitTableRow(line);
  return (
    cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")))
  );
}

// Guess a column type from its body values, so a converted table keeps using
// Smart Table's typed inputs where it can. Falls back to plain text.
function inferColumnType(values) {
  const nonEmpty = values.filter((v) => v !== "");
  if (!nonEmpty.length) return "text";
  const isBool = (v) => /^(\[[ xX]?\]|true|false|yes|no)$/i.test(v.trim());
  if (nonEmpty.every(isBool)) return "checkbox";
  if (nonEmpty.every((v) => /^-?\d+(\.\d+)?$/.test(v.trim()))) return "number";
  // Check date-time before date, since a date-time string starts with a date.
  if (nonEmpty.every((v) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v.trim())))
    return "datetime";
  if (nonEmpty.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim()))) return "date";
  return "text";
}

function toBool(v) {
  return /^(\[[xX]\]|true|yes)$/i.test(String(v).trim());
}

// Parse Markdown table text into a Smart Table state, or null if it isn't a
// recognisable table (needs a header row + a delimiter row).
function parseMarkdownTable(text) {
  const lines = (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length < 2 || !lines.every((l) => l.includes("|"))) return null;
  if (!isDelimiterRow(lines[1])) return null;

  const headers = splitTableRow(lines[0]);
  if (!headers.length) return null;
  const bodyRows = lines.slice(2).map(splitTableRow);

  const columns = headers.map((h, i) => {
    const colValues = bodyRows.map((r) => (r[i] == null ? "" : r[i]));
    const type = inferColumnType(colValues);
    return { id: uid("c"), name: h || "Column " + (i + 1), type };
  });
  const rows = bodyRows.map((r) => {
    const cells = {};
    columns.forEach((col, i) => {
      const raw = r[i] == null ? "" : r[i];
      cells[col.id] =
        col.type === "checkbox"
          ? toBool(raw)
          : col.type === "datetime"
          ? toDatetimeLocal(raw)
          : raw;
    });
    return { id: uid("r"), cells };
  });
  return { columns, rows, sort: null, filters: {}, showFilters: false };
}

// Find the Markdown table to convert: the selection if one is highlighted,
// otherwise the run of pipe rows surrounding the cursor. Returns the source
// text plus the document range it occupies, or null if none is found.
function findTableRange(editor) {
  const sel = editor.getSelection();
  if (sel && sel.trim()) {
    return {
      from: editor.getCursor("from"),
      to: editor.getCursor("to"),
      text: sel,
    };
  }
  const cur = editor.getCursor();
  const isRow = (n) => {
    const l = editor.getLine(n);
    return l != null && l.trim() !== "" && l.includes("|");
  };
  if (!isRow(cur.line)) return null;
  let start = cur.line;
  while (start > 0 && isRow(start - 1)) start--;
  let end = cur.line;
  const last = editor.lineCount() - 1;
  while (end < last && isRow(end + 1)) end++;
  const from = { line: start, ch: 0 };
  const to = { line: end, ch: editor.getLine(end).length };
  return { from, to, text: editor.getRange(from, to) };
}

// Replace `range` in the editor with a smart-table block built from `state`.
function convertTableRange(editor, range) {
  const state = parseMarkdownTable(range.text);
  if (!state) {
    new Notice("Smart Table: no Markdown table found to convert.");
    return false;
  }
  const block = "```smart-table\n" + JSON.stringify(state) + "\n```";
  editor.replaceRange(block, range.from, range.to);
  return true;
}

// ---------------------------------------------------------------------------
// A tiny text-prompt modal (rename column, new option).
// ---------------------------------------------------------------------------

class PromptModal extends Modal {
  constructor(app, title, initial, onSubmit) {
    super(app);
    this._title = title;
    this._initial = initial || "";
    this._onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("smart-table-modal");
    contentEl.createEl("h3", { text: this._title });
    const input = contentEl.createEl("input", {
      cls: "smart-table-modal-input",
      attr: { type: "text" },
    });
    input.value = this._initial;
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    const submit = () => {
      const v = input.value.trim();
      this.close();
      this._onSubmit(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    const row = contentEl.createDiv({ cls: "smart-table-modal-row" });
    const ok = row.createEl("button", { cls: "mod-cta", text: "OK" });
    ok.onclick = submit;
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}
function promptText(app, title, initial, cb) {
  new PromptModal(app, title, initial, cb).open();
}

// A confirm/cancel modal for destructive actions (delete column / row). Runs
// `onConfirm` only if the user accepts; Enter confirms, Escape/Cancel dismisses.
class ConfirmModal extends Modal {
  constructor(app, title, message, confirmText, onConfirm) {
    super(app);
    this._title = title;
    this._message = message;
    this._confirmText = confirmText || "Delete";
    this._onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("smart-table-modal");
    contentEl.createEl("h3", { text: this._title });
    if (this._message) contentEl.createEl("p", { text: this._message });
    const confirm = () => {
      this.close();
      this._onConfirm();
    };
    this.scope.register([], "Enter", (e) => {
      e.preventDefault();
      confirm();
    });
    const row = contentEl.createDiv({ cls: "smart-table-modal-row" });
    const ok = row.createEl("button", {
      cls: "mod-warning",
      text: this._confirmText,
    });
    ok.onclick = confirm;
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    window.setTimeout(() => ok.focus(), 0);
  }
  onClose() {
    this.contentEl.empty();
  }
}
function confirmAction(app, title, message, confirmText, onConfirm) {
  new ConfirmModal(app, title, message, confirmText, onConfirm).open();
}

// Editor for a select/status column's options: pick each option's color from
// the preset palette, rename it, delete it, or add new ones. Renames/deletes
// migrate matching cell values in `rows`. `onChange` persists after each edit.
class OptionsModal extends Modal {
  constructor(app, col, rows, onChange) {
    super(app);
    this.col = col;
    this.rows = rows;
    this.onChange = onChange;
  }
  onOpen() {
    const { contentEl } = this;
    const { col, rows, onChange } = this;
    contentEl.addClass("smart-table-modal");
    contentEl.createEl("h3", { text: "Edit options — " + (col.name || "options") });
    const list = contentEl.createDiv({ cls: "smart-table-opt-list" });

    const renderRow = (opt) => {
      const row = list.createDiv({ cls: "smart-table-opt-row" });
      const swatches = row.createDiv({ cls: "smart-table-swatches" });
      PALETTE_KEYS.forEach((key) => {
        const sw = swatches.createDiv({ cls: "smart-table-swatch" });
        sw.style.background = PALETTE[key][0];
        if (opt.color === key) sw.addClass("is-active");
        sw.setAttr("aria-label", key);
        sw.onclick = () => {
          opt.color = key;
          swatches
            .querySelectorAll(".smart-table-swatch")
            .forEach((n) => n.removeClass("is-active"));
          sw.addClass("is-active");
          onChange();
        };
      });
      const label = row.createEl("input", {
        cls: "smart-table-opt-label",
        attr: { type: "text" },
      });
      label.value = opt.label;
      const rename = () => {
        const v = label.value.trim();
        if (!v || v === opt.label) {
          label.value = opt.label;
          return;
        }
        if ((col.options || []).some((o) => o !== opt && o.label === v)) {
          label.value = opt.label; // avoid duplicate labels
          return;
        }
        const old = opt.label;
        opt.label = v;
        rows.forEach((r) => {
          const cur = r.cells[col.id];
          if (Array.isArray(cur)) {
            r.cells[col.id] = cur.map((t) => (t === old ? v : t));
          } else if (String(cur) === old) {
            r.cells[col.id] = v;
          }
        });
        onChange();
      };
      label.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          label.blur();
        }
      });
      label.addEventListener("blur", rename);
      const del = row.createSpan({ cls: "smart-table-opt-del" });
      setIcon(del, "trash");
      del.setAttr("aria-label", "Delete option");
      del.onclick = () => {
        col.options = (col.options || []).filter((o) => o !== opt);
        rows.forEach((r) => {
          const cur = r.cells[col.id];
          if (Array.isArray(cur)) {
            r.cells[col.id] = cur.filter((t) => t !== opt.label);
          } else if (String(cur) === opt.label) {
            r.cells[col.id] = "";
          }
        });
        onChange();
        renderList();
      };
    };

    const renderList = () => {
      list.empty();
      (col.options || []).forEach(renderRow);
      if (!(col.options || []).length) {
        list.createDiv({
          cls: "smart-table-opt-empty",
          text: "No options yet — add one below.",
        });
      }
    };
    renderList();

    const add = contentEl.createDiv({ cls: "smart-table-opt-add" });
    const input = add.createEl("input", {
      cls: "smart-table-opt-label",
      attr: { type: "text", placeholder: "New option" },
    });
    const addBtn = add.createEl("button", { cls: "mod-cta", text: "Add" });
    const doAdd = () => {
      const v = input.value.trim();
      if (!v) return;
      addOption(col, v);
      input.value = "";
      onChange();
      renderList();
      input.focus();
    };
    addBtn.onclick = doAdd;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doAdd();
      }
    });

    const foot = contentEl.createDiv({ cls: "smart-table-modal-row" });
    const done = foot.createEl("button", { cls: "mod-cta", text: "Done" });
    done.onclick = () => this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}
function editOptions(app, col, rows, onChange) {
  new OptionsModal(app, col, rows, onChange).open();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// `persistFn(state)` writes the edited state back to the note — either through
// the Reading-view post-processor context or the Live-Preview editor.
function renderTable(app, source, el, persistFn) {
  const parsed = parseState(source);
  el.empty();
  el.addClass("smart-table");
  if (parsed === null) {
    el.createDiv({
      cls: "smart-table-error",
      text:
        "Smart Table: couldn't read this table's data. Edit the code block to fix the JSON.",
    });
    return;
  }
  const state = parsed;

  // Row-selection state (transient UI, never persisted to the block). Lives
  // across rebuilds within a single render.
  let selecting = false;
  const selection = new Set();

  // Rebuild the whole widget from `state`.
  const draw = () => build();
  // Persist without rebuilding — for value edits that update their own cell in
  // place, so the table doesn't flicker or lose scroll on every keystroke.
  const save = () => persistFn(state);
  // Mutation entry point for structural changes (add/remove row or column,
  // sort, filter, reorder, type change): rebuild, then write back.
  const commit = () => {
    build();
    persistFn(state);
  };

  // Append a blank row and persist. Shared by the toolbar button and the
  // "+ New row" footer at the bottom of the grid.
  const appendRow = () => {
    const row = { id: uid("r"), cells: {} };
    state.columns.forEach((c) => (row.cells[c.id] = defaultCell(c.type)));
    state.rows.push(row);
    commit();
  };

  // Duplicate a single row: insert a clean copy directly below it (Notion-style).
  const duplicateRow = (row) => {
    const idx = state.rows.findIndex((r) => r.id === row.id);
    const copy = rowFromCells(state.columns, row.cells);
    state.rows.splice(idx < 0 ? state.rows.length : idx + 1, 0, copy);
    commit();
  };

  // Duplicate a column: a clone (type, options, width, alignment) inserted just
  // after the source, carrying every row's value.
  const duplicateColumn = (col) => {
    const idx = state.columns.findIndex((c) => c.id === col.id);
    const nc = { id: uid("c"), name: (col.name || "Column") + " copy", type: col.type };
    if (typeof col.width === "number") nc.width = col.width;
    if (col.align) nc.align = col.align;
    if (Array.isArray(col.options)) {
      nc.options = col.options.map((o) => ({ label: o.label, color: o.color }));
    }
    state.columns.splice(idx < 0 ? state.columns.length : idx + 1, 0, nc);
    state.rows.forEach((r) => (r.cells[nc.id] = cloneValue(r.cells[col.id])));
    commit();
  };

  // Insert a fresh empty row directly above or below a given row. If a sort is
  // active, bake it into manual order first so "above/below" matches what's on
  // screen rather than the underlying storage order.
  const insertRow = (row, below) => {
    if (state.sort) {
      const sc = state.columns.find((c) => c.id === state.sort.col);
      if (sc) {
        const dir = state.sort.dir === "desc" ? -1 : 1;
        state.rows.sort(
          (a, b) => dir * compareValues(a.cells[sc.id], b.cells[sc.id], sc.type)
        );
      }
      state.sort = null;
    }
    const idx = state.rows.findIndex((r) => r.id === row.id);
    const nr = { id: uid("r"), cells: {} };
    state.columns.forEach((c) => (nr.cells[c.id] = defaultCell(c.type)));
    state.rows.splice(idx < 0 ? state.rows.length : idx + (below ? 1 : 0), 0, nr);
    commit();
  };

  // Insert a fresh empty column of the given type to the left or right of a
  // column (matches the shape produced by addColumn).
  const insertColumn = (col, after, type) => {
    const idx = state.columns.findIndex((c) => c.id === col.id);
    const nc = { id: uid("c"), name: "Column " + (state.columns.length + 1), type };
    if (type === "status") nc.options = defaultStatusOptions();
    if (type === "select" || type === "multiselect") nc.options = [];
    state.columns.splice(idx < 0 ? state.columns.length : idx + (after ? 1 : 0), 0, nc);
    state.rows.forEach((r) => (r.cells[nc.id] = defaultCell(type)));
    commit();
  };

  // Copy the given rows into the in-app clipboard (plain cell maps).
  const copyRows = (rows) => {
    rowClipboard = rows.map((r) => {
      const cells = {};
      state.columns.forEach((c) => (cells[c.id] = cloneValue(r.cells[c.id])));
      return cells;
    });
  };

  // Paste clipboard rows as new rows appended to the table. Paste is one-shot:
  // the clipboard is cleared afterwards, so the toolbar Paste button doesn't
  // linger. Re-copy to paste again.
  const pasteRows = () => {
    if (!rowClipboard.length) return;
    rowClipboard.forEach((cells) =>
      state.rows.push(rowFromCells(state.columns, cells))
    );
    rowClipboard = [];
    commit();
  };

  // ⌘V behaviour: if rows are selected, overwrite their values with the copied
  // rows (matched 1:1, cycling the clipboard); otherwise append copies.
  const pasteIntoSelection = () => {
    if (!rowClipboard.length) return;
    const targets = state.rows.filter((r) => selection.has(r.id));
    if (!targets.length) {
      pasteRows();
      return;
    }
    targets.forEach((r, i) => {
      const cells = rowClipboard[i % rowClipboard.length];
      state.columns.forEach((c) => {
        if (c.id in cells) r.cells[c.id] = cloneValue(cells[c.id]);
      });
    });
    rowClipboard = [];
    commit();
  };

  // Change a column's type, converting each cell's value where possible.
  // Lossless conversions apply silently; if any non-empty value can't be
  // converted, warn (with the count) before clearing those cells. Converting
  // to an option type turns existing values into options so nothing is lost.
  const changeType = (col, to) => {
    if (to === col.type) return;
    const from = col.type;
    const results = state.rows.map((r) => convertValue(r.cells[col.id], from, to));
    const lossy = state.rows.reduce((n, r, idx) => {
      const v = r.cells[col.id];
      const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
      return n + (!empty && !results[idx].ok ? 1 : 0);
    }, 0);
    const apply = () => {
      changeColumnType(col, to);
      state.rows.forEach((r, idx) => {
        const val = results[idx].value;
        if ((to === "select" || to === "status") && val) addOption(col, val);
        if (to === "multiselect") asTags(val).forEach((tag) => addOption(col, tag));
        r.cells[col.id] = val;
      });
      commit();
    };
    if (lossy > 0) {
      confirmAction(
        app,
        "Change column type?",
        lossy +
          " value" +
          (lossy === 1 ? "" : "s") +
          " can't be converted to " +
          TYPE_LABELS[to] +
          " and will be cleared. Other values are converted automatically.",
        "Change type",
        apply
      );
    } else {
      apply();
    }
  };

  function openTypeMenu(evt, cb) {
    const menu = new Menu();
    COLUMN_TYPES.forEach((t) =>
      menu.addItem((i) =>
        i
          .setTitle(TYPE_LABELS[t])
          .setIcon(typeIcon(t))
          .onClick(() => cb(t))
      )
    );
    menu.showAtMouseEvent(evt);
  }

  function openColumnMenu(evt, col) {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Sort ascending")
        .setIcon("arrow-up")
        .onClick(() => {
          state.sort = { col: col.id, dir: "asc" };
          commit();
        })
    );
    menu.addItem((i) =>
      i
        .setTitle("Sort descending")
        .setIcon("arrow-down")
        .onClick(() => {
          state.sort = { col: col.id, dir: "desc" };
          commit();
        })
    );
    if (state.sort && state.sort.col === col.id) {
      menu.addItem((i) =>
        i
          .setTitle("Clear sort")
          .setIcon("x")
          .onClick(() => {
            state.sort = null;
            commit();
          })
      );
    }
    menu.addSeparator();
    COLUMN_TYPES.forEach((t) =>
      menu.addItem((i) =>
        i
          .setTitle(TYPE_LABELS[t])
          .setIcon(col.type === t ? "check" : typeIcon(t))
          .onClick(() => changeType(col, t))
      )
    );
    menu.addSeparator();
    // Text alignment for the whole column. "left" is the default, so we clear
    // the property rather than storing it.
    const ALIGNS = [
      ["left", "Left", "align-left"],
      ["center", "Center", "align-center"],
      ["right", "Right", "align-right"],
    ];
    const curAlign = col.align || "left";
    const setAlign = (val) => {
      if (val === "left") delete col.align;
      else col.align = val;
      commit();
    };
    menu.addItem((parent) => {
      parent.setTitle("Text align").setIcon("align-" + curAlign);
      // Prefer a nested submenu; fall back to flat items on older Obsidian
      // builds that lack MenuItem.setSubmenu().
      if (typeof parent.setSubmenu === "function") {
        const sub = parent.setSubmenu();
        ALIGNS.forEach(([val, label, icon]) =>
          sub.addItem((s) =>
            s
              .setTitle(label)
              .setIcon(curAlign === val ? "check" : icon)
              .onClick(() => setAlign(val))
          )
        );
      } else {
        parent.onClick(() => setAlign(curAlign === "right" ? "left" : "right"));
      }
    });
    menu.addSeparator();
    if (OPTION_TYPES.includes(col.type)) {
      menu.addItem((i) =>
        i
          .setTitle("Edit options…")
          .setIcon("palette")
          .onClick(() => editOptions(app, col, state.rows, commit))
      );
    }
    // Insert a new column immediately left/right of this one, picking its type
    // from a submenu (falls back to a Text column on older Obsidian builds).
    [
      ["Insert column left", false, "arrow-left"],
      ["Insert column right", true, "arrow-right"],
    ].forEach(([title, after, icon]) => {
      menu.addItem((parent) => {
        parent.setTitle(title).setIcon(icon);
        if (typeof parent.setSubmenu === "function") {
          const sub = parent.setSubmenu();
          COLUMN_TYPES.forEach((t) =>
            sub.addItem((s) =>
              s
                .setTitle(TYPE_LABELS[t])
                .setIcon(typeIcon(t))
                .onClick(() => insertColumn(col, after, t))
            )
          );
        } else {
          parent.onClick(() => insertColumn(col, after, "text"));
        }
      });
    });
    menu.addItem((i) =>
      i
        .setTitle("Duplicate column")
        .setIcon("copy")
        .onClick(() => duplicateColumn(col))
    );
    menu.addItem((i) =>
      i
        .setTitle("Rename…")
        .setIcon("pencil")
        .onClick(() =>
          promptText(app, "Rename column", col.name, (v) => {
            if (v) {
              col.name = v;
              commit();
            }
          })
        )
    );
    menu.addItem((i) =>
      i
        .setTitle("Delete column")
        .setIcon("trash")
        .onClick(() => {
          if (state.columns.length <= 1) return;
          // Always confirm — deleting a column discards that field's data in
          // every row.
          confirmAction(
            app,
            "Delete column?",
            'This deletes the "' +
              (col.name || "Untitled") +
              '" column and its values in all ' +
              state.rows.length +
              " row" +
              (state.rows.length === 1 ? "" : "s") +
              ". This can't be undone.",
            "Delete column",
            () => {
              state.columns = state.columns.filter((c) => c.id !== col.id);
              state.rows.forEach((r) => delete r.cells[col.id]);
              if (state.sort && state.sort.col === col.id) state.sort = null;
              delete state.filters[col.id];
              commit();
            }
          );
        })
    );
    menu.showAtMouseEvent(evt);
  }

  function openSelectMenu(evt, col, row, refresh) {
    const set = (value) => {
      row.cells[col.id] = value;
      refresh();
      save();
    };
    const menu = new Menu();
    (col.options || []).forEach((o) =>
      menu.addItem((i) =>
        i
          .setTitle(o.label)
          .setIcon(row.cells[col.id] === o.label ? "check" : "circle")
          .onClick(() => set(o.label))
      )
    );
    if (col.options && col.options.length) menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Clear")
        .setIcon("x")
        .onClick(() => set(""))
    );
    menu.addItem((i) =>
      i
        .setTitle("New option…")
        .setIcon("plus")
        .onClick(() =>
          promptText(app, "New option", "", (label) => {
            if (label) {
              addOption(col, label);
              set(label);
            }
          })
        )
    );
    menu.addItem((i) =>
      i
        .setTitle("Edit options…")
        .setIcon("palette")
        .onClick(() => editOptions(app, col, state.rows, commit))
    );
    menu.showAtMouseEvent(evt);
  }

  // Add-a-tag menu for a multi-select cell: lists options not already on the
  // row (toggling one on), plus create/edit-options entries.
  function openMultiAddMenu(evt, col, row, refresh) {
    const addTag = (label) => {
      row.cells[col.id] = asTags(row.cells[col.id]).concat(label);
      refresh();
      save();
    };
    const menu = new Menu();
    const cur = asTags(row.cells[col.id]);
    const remaining = (col.options || []).filter((o) => !cur.includes(o.label));
    remaining.forEach((o) =>
      menu.addItem((i) =>
        i
          .setTitle(o.label)
          .setIcon("plus")
          .onClick(() => addTag(o.label))
      )
    );
    if (!remaining.length) {
      menu.addItem((i) => i.setTitle("All options added").setDisabled(true));
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("New option…")
        .setIcon("plus")
        .onClick(() =>
          promptText(app, "New option", "", (label) => {
            if (label) {
              addOption(col, label);
              addTag(label);
            }
          })
        )
    );
    menu.addItem((i) =>
      i
        .setTitle("Edit options…")
        .setIcon("palette")
        .onClick(() => editOptions(app, col, state.rows, commit))
    );
    menu.showAtMouseEvent(evt);
  }

  function setFilter(col, value) {
    if (value) state.filters[col.id] = value;
    else delete state.filters[col.id];
    commit();
  }

  function renderFilterControl(fth, col) {
    const cur = state.filters[col.id] || "";
    if (col.type === "checkbox") {
      const sel = fth.createEl("select", { cls: "smart-table-filter-input" });
      [
        ["", "Any"],
        ["true", "Checked"],
        ["false", "Unchecked"],
      ].forEach(([v, l]) => {
        const o = sel.createEl("option", { text: l });
        o.value = v;
        if (v === cur) o.selected = true;
      });
      sel.onchange = () => setFilter(col, sel.value);
    } else if (
      col.type === "select" ||
      col.type === "status" ||
      col.type === "multiselect"
    ) {
      const sel = fth.createEl("select", { cls: "smart-table-filter-input" });
      const any = sel.createEl("option", { text: "Any" });
      any.value = "";
      if (!cur) any.selected = true;
      (col.options || []).forEach((o) => {
        const op = sel.createEl("option", { text: o.label });
        op.value = o.label;
        if (o.label === cur) op.selected = true;
      });
      sel.onchange = () => setFilter(col, sel.value);
    } else if (col.type === "number" || col.type === "date" || col.type === "datetime") {
      const [a, b] = splitPair(cur);
      const inType =
        col.type === "number"
          ? "number"
          : col.type === "datetime"
          ? "datetime-local"
          : "date";
      const box = fth.createDiv({ cls: "smart-table-filter-pair" });
      const lo = box.createEl("input", {
        cls: "smart-table-filter-input",
        attr: { type: inType, placeholder: col.type === "number" ? "Min" : "" },
      });
      const hi = box.createEl("input", {
        cls: "smart-table-filter-input",
        attr: { type: inType, placeholder: col.type === "number" ? "Max" : "" },
      });
      lo.value = a;
      hi.value = b;
      lo.setAttr("aria-label", col.type === "number" ? "Minimum" : "From");
      hi.setAttr("aria-label", col.type === "number" ? "Maximum" : "To");
      const upd = () => setFilter(col, joinPair(lo.value, hi.value));
      lo.onchange = upd;
      hi.onchange = upd;
    } else {
      const fi = fth.createEl("input", {
        cls: "smart-table-filter-input",
        attr: { type: "text", placeholder: "Filter…" },
      });
      fi.value = cur;
      fi.onchange = () => setFilter(col, fi.value);
    }
  }

  function renderCell(td, col, row) {
    const val = row.cells[col.id];
    // text-align is inherited, so setting it on the cell aligns inputs, the
    // textarea's text, pills, and the checkbox alike.
    if (col.align) td.style.textAlign = col.align;
    // Re-render just this cell (no full table rebuild) — used after value
    // edits so the table doesn't flicker or lose scroll position.
    const refresh = () => {
      td.empty();
      renderCell(td, col, row);
    };
    if (col.type === "checkbox") {
      const cb = td.createEl("input", { attr: { type: "checkbox" } });
      cb.checked = val === true || val === "true";
      cb.onchange = () => {
        row.cells[col.id] = cb.checked;
        save();
      };
    } else if (col.type === "select" || col.type === "status") {
      const opt = (col.options || []).find((o) => o.label === val);
      const pill = td.createDiv({ cls: "smart-table-pill" });
      if (val) {
        const c = PALETTE[opt ? opt.color : "gray"] || PALETTE.gray;
        pill.style.background = c[0];
        pill.style.color = c[1];
        pill.setText(val);
      } else {
        pill.addClass("smart-table-pill-empty");
        pill.setText("Empty");
      }
      pill.onclick = (e) => openSelectMenu(e, col, row, refresh);
    } else if (col.type === "multiselect") {
      const tags = asTags(val);
      const box = td.createDiv({ cls: "smart-table-tags" });
      tags.forEach((label) => {
        const opt = (col.options || []).find((o) => o.label === label);
        const c = PALETTE[opt ? opt.color : "gray"] || PALETTE.gray;
        const pill = box.createDiv({ cls: "smart-table-pill smart-table-tag" });
        pill.style.background = c[0];
        pill.style.color = c[1];
        pill.createSpan({ text: label });
        const x = pill.createSpan({ cls: "smart-table-tag-x" });
        setIcon(x, "x");
        x.setAttr("aria-label", "Remove " + label);
        x.onclick = (e) => {
          e.stopPropagation();
          row.cells[col.id] = asTags(row.cells[col.id]).filter((t) => t !== label);
          refresh();
          save();
        };
      });
      const add = box.createDiv({ cls: "smart-table-tag-add" });
      setIcon(add, "plus");
      add.setAttr("aria-label", "Add tag");
      add.onclick = (e) => openMultiAddMenu(e, col, row, refresh);
    } else if (
      col.type === "number" ||
      col.type === "date" ||
      col.type === "datetime"
    ) {
      const inp = td.createEl("input", {
        cls: "smart-table-cell-input",
        attr: { type: col.type === "datetime" ? "datetime-local" : col.type },
      });
      // datetime-local needs the YYYY-MM-DDTHH:mm form; normalize stored values
      // that may use a space separator so they still populate the picker.
      inp.value =
        val == null ? "" : col.type === "datetime" ? toDatetimeLocal(val) : val;
      inp.onchange = () => {
        row.cells[col.id] = inp.value;
        save();
      };
    } else {
      // Text uses an auto-growing textarea so long content wraps onto new
      // lines instead of being clipped to a single line.
      const ta = td.createEl("textarea", {
        cls: "smart-table-cell-input smart-table-cell-text",
      });
      ta.rows = 1;
      ta.value = val == null ? "" : val;
      const autosize = () => {
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      };
      ta.addEventListener("input", autosize);
      ta.onchange = () => {
        row.cells[col.id] = ta.value;
        save();
      };
      // Size to existing content once the cell is in the DOM.
      window.setTimeout(autosize, 0);
    }
  }

  function build() {
    // Preserve the grid's scroll position across the full rebuild, so setting
    // a value in an off-screen column doesn't snap the table back to the left.
    const prevWrap = el.querySelector(".smart-table-wrap");
    const keepScrollLeft = prevWrap ? prevWrap.scrollLeft : 0;
    const keepScrollTop = prevWrap ? prevWrap.scrollTop : 0;
    el.empty();
    el.addClass("smart-table");

    // Toolbar -------------------------------------------------------------
    const bar = el.createDiv({ cls: "smart-table-toolbar" });
    const addRow = bar.createEl("button", { cls: "smart-table-btn" });
    setIcon(addRow.createSpan(), "plus");
    addRow.createSpan({ text: "Row" });
    addRow.onclick = appendRow;

    const addCol = bar.createEl("button", { cls: "smart-table-btn" });
    setIcon(addCol.createSpan(), "plus");
    addCol.createSpan({ text: "Column" });
    addCol.onclick = (e) =>
      openTypeMenu(e, (t) => {
        addColumn(state, t);
        commit();
      });

    const filterBtn = bar.createEl("button", { cls: "smart-table-btn" });
    if (state.showFilters) filterBtn.addClass("is-active");
    setIcon(filterBtn.createSpan(), "filter");
    filterBtn.createSpan({ text: "Filter" });
    filterBtn.onclick = () => {
      state.showFilters = !state.showFilters;
      // Hiding the filter row returns to the normal (unfiltered) view — clear
      // any active filters so rows aren't left filtered by a hidden control.
      if (!state.showFilters) state.filters = {};
      commit();
    };

    const csvBtn = bar.createEl("button", { cls: "smart-table-btn" });
    setIcon(csvBtn.createSpan(), "download");
    csvBtn.createSpan({ text: "Export CSV" });
    csvBtn.setAttr("aria-label", "Export this table to CSV");
    csvBtn.onclick = () => exportTableCSV(state);

    // Paste appears only when rows have been copied (possibly from another table).
    if (rowClipboard.length) {
      const pasteBtn = bar.createEl("button", { cls: "smart-table-btn" });
      setIcon(pasteBtn.createSpan(), "clipboard-paste");
      pasteBtn.createSpan({
        text: "Paste " + rowClipboard.length + " row" + (rowClipboard.length === 1 ? "" : "s"),
      });
      pasteBtn.setAttr("aria-label", "Paste copied rows");
      pasteBtn.onclick = pasteRows;
    }

    const selectBtn = bar.createEl("button", { cls: "smart-table-btn" });
    if (selecting) selectBtn.addClass("is-active");
    setIcon(selectBtn.createSpan(), "check-square");
    selectBtn.createSpan({ text: "Select" });
    selectBtn.setAttr("aria-label", "Select rows for bulk actions");
    selectBtn.onclick = () => {
      // Toggling adds/removes the leading checkbox column; keep the same data
      // columns in view by shifting scroll by that column's width.
      const w = el.querySelector(".smart-table-wrap");
      const sx = w ? w.scrollLeft : 0;
      const entering = !selecting;
      selecting = !selecting;
      if (!selecting) selection.clear();
      draw();
      const nw = el.querySelector(".smart-table-wrap");
      if (nw) {
        nw.scrollLeft = Math.max(
          0,
          sx + (entering ? SELECT_COL_WIDTH : -SELECT_COL_WIDTH)
        );
      }
    };

    const shown = viewRows(state);
    bar.createDiv({
      cls: "smart-table-count",
      text: shown.length + " of " + state.rows.length,
    });

    // Selection action bar (only while selecting).
    const selectedRows = () => shown.filter((r) => selection.has(r.id));
    if (selecting) {
      const sel = el.createDiv({ cls: "smart-table-selbar" });
      const n = selectedRows().length;
      sel.createSpan({
        cls: "smart-table-selcount",
        text: n + " selected",
      });
      const act = (label, icon, aria, fn) => {
        const b = sel.createEl("button", { cls: "smart-table-btn" });
        setIcon(b.createSpan(), icon);
        b.createSpan({ text: label });
        b.setAttr("aria-label", aria);
        if (!n) b.setAttr("disabled", "true");
        else b.onclick = fn;
        return b;
      };
      act("Duplicate", "copy", "Duplicate selected rows", () => {
        selectedRows().forEach((r) =>
          state.rows.push(rowFromCells(state.columns, r.cells))
        );
        commit();
      });
      act("Copy", "clipboard-copy", "Copy selected rows", () => {
        copyRows(selectedRows());
        draw(); // reveal the Paste button in the toolbar
      });
      act("Export", "download", "Export selected rows to CSV", () =>
        exportRowsCSV(state.columns, selectedRows(), "smart-table-selection.csv")
      );
      act("Delete", "trash", "Delete selected rows", () =>
        deleteSelected(selectedRows())
      );
      const done = sel.createEl("button", { cls: "smart-table-btn" });
      setIcon(done.createSpan(), "x");
      done.createSpan({ text: "Done" });
      done.setAttr("aria-label", "Exit selection");
      done.onclick = () => {
        selecting = false;
        selection.clear();
        draw();
      };
    }

    // Table ---------------------------------------------------------------
    const wrap = el.createDiv({ cls: "smart-table-wrap" });
    const table = wrap.createEl("table", { cls: "smart-table-grid" });

    // Fixed layout driven by an explicit colgroup: column widths are honoured
    // exactly (so they can be dragged) and the overall table width is the sum,
    // letting the wrapper scroll horizontally when needed. A leading checkbox
    // column is added only while selecting.
    const leadWidth = selecting ? SELECT_COL_WIDTH : 0;
    const sumWidth = () =>
      state.columns.reduce((s, c) => s + columnWidth(c), 0) +
      TRAILING_COL_WIDTH +
      leadWidth;
    table.style.width = sumWidth() + "px";
    const colgroup = table.createEl("colgroup");
    if (selecting) colgroup.createEl("col").style.width = SELECT_COL_WIDTH + "px";
    const colEls = state.columns.map((col) => {
      const cl = colgroup.createEl("col");
      cl.style.width = columnWidth(col) + "px";
      return cl;
    });
    colgroup.createEl("col").style.width = TRAILING_COL_WIDTH + "px";

    // Drag a column's right-edge handle to resize it; the new width is stored
    // on the column (and persisted) when the drag ends.
    const startResize = (evt, col, index) => {
      evt.preventDefault();
      evt.stopPropagation();
      const startX = evt.clientX;
      const startW = columnWidth(col);
      let width = startW;
      document.body.classList.add("smart-table-resizing");
      const onMove = (e) => {
        width = Math.max(MIN_COL_WIDTH, Math.round(startW + (e.clientX - startX)));
        colEls[index].style.width = width + "px";
        table.style.width =
          state.columns.reduce(
            (s, c, i) => s + (i === index ? width : columnWidth(c)),
            0
          ) +
          TRAILING_COL_WIDTH +
          leadWidth +
          "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("smart-table-resizing");
        if (width !== startW) {
          col.width = width;
          commit();
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };

    // Drag-and-drop reorder state. These live for one render; a commit (which
    // rebuilds) resets them. A drag completes within a single render, so that's
    // fine.
    let dragColId = null;
    let dragRowId = null;
    const clearColIndicators = () =>
      table
        .querySelectorAll("th.st-drop-left, th.st-drop-right")
        .forEach((n) => n.classList.remove("st-drop-left", "st-drop-right"));
    const clearRowIndicators = () =>
      table
        .querySelectorAll("tr.st-drop-above, tr.st-drop-below")
        .forEach((n) => n.classList.remove("st-drop-above", "st-drop-below"));
    // Dragging a row clears any active sort, but first bakes the current sorted
    // order into state.rows so nothing visibly reshuffles.
    const bakeSortThenClear = () => {
      if (!state.sort) return;
      const col = state.columns.find((c) => c.id === state.sort.col);
      if (col) {
        const dir = state.sort.dir === "desc" ? -1 : 1;
        state.rows.sort(
          (a, b) => dir * compareValues(a.cells[col.id], b.cells[col.id], col.type)
        );
      }
      state.sort = null;
    };

    const thead = table.createEl("thead");
    const htr = thead.createEl("tr");
    if (selecting) {
      const selTh = htr.createEl("th", { cls: "smart-table-selcol" });
      const all = selTh.createEl("input", { attr: { type: "checkbox" } });
      const shownIds = shown.map((r) => r.id);
      const selCount = shownIds.filter((id) => selection.has(id)).length;
      all.checked = shownIds.length > 0 && selCount === shownIds.length;
      all.indeterminate = selCount > 0 && selCount < shownIds.length;
      all.setAttr("aria-label", "Select all rows");
      all.onclick = () => {
        if (all.checked) shownIds.forEach((id) => selection.add(id));
        else shownIds.forEach((id) => selection.delete(id));
        draw();
      };
    }
    state.columns.forEach((col, index) => {
      const th = htr.createEl("th", {
        cls: "smart-table-th" + (index === 0 ? " smart-table-th-first" : ""),
      });
      // Drop target for column reorder.
      th.addEventListener("dragover", (e) => {
        if (dragColId == null || dragColId === col.id) return;
        e.preventDefault();
        const r = th.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        clearColIndicators();
        th.classList.add(after ? "st-drop-right" : "st-drop-left");
      });
      th.addEventListener("dragleave", () =>
        th.classList.remove("st-drop-left", "st-drop-right")
      );
      th.addEventListener("drop", (e) => {
        if (dragColId == null) return;
        e.preventDefault();
        const r = th.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        moveById(state.columns, dragColId, col.id, after);
        dragColId = null;
        commit();
      });
      const inner = th.createDiv({ cls: "smart-table-th-inner" });
      // The type icon doubles as the column's drag handle (Notion-style),
      // keeping the editable name field free for text selection.
      const ico = inner.createSpan({ cls: "smart-table-th-ico" });
      setIcon(ico, typeIcon(col.type));
      ico.draggable = true;
      ico.setAttr("aria-label", "Drag to reorder column");
      ico.addEventListener("dragstart", (e) => {
        dragColId = col.id;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", col.id);
        }
        th.classList.add("st-dragging");
      });
      ico.addEventListener("dragend", () => {
        dragColId = null;
        clearColIndicators();
        th.classList.remove("st-dragging");
      });
      // Auto-growing textarea (not an input) so long column names wrap onto
      // multiple lines instead of being clipped to one.
      const name = inner.createEl("textarea", { cls: "smart-table-th-name" });
      name.rows = 1;
      name.value = col.name;
      if (col.align) name.style.textAlign = col.align;
      const sizeName = () => {
        name.style.height = "auto";
        name.style.height = name.scrollHeight + "px";
      };
      name.addEventListener("input", sizeName);
      name.onchange = () => {
        col.name = name.value;
        commit();
      };
      window.setTimeout(sizeName, 0);
      if (state.sort && state.sort.col === col.id) {
        inner.createSpan({
          cls: "smart-table-sort",
          text: state.sort.dir === "asc" ? "↑" : "↓",
        });
      }
      const menuBtn = inner.createSpan({ cls: "smart-table-th-menu" });
      setIcon(menuBtn, "chevron-down");
      menuBtn.onclick = (e) => openColumnMenu(e, col);
      const handle = th.createDiv({ cls: "smart-table-col-resize" });
      handle.setAttr("aria-label", "Drag to resize column");
      handle.addEventListener("mousedown", (e) => startResize(e, col, index));
    });
    const thAdd = htr.createEl("th", { cls: "smart-table-th-add" });
    setIcon(thAdd, "plus");
    thAdd.onclick = (e) =>
      openTypeMenu(e, (t) => {
        addColumn(state, t);
        commit();
      });

    if (state.showFilters) {
      const ftr = thead.createEl("tr", { cls: "smart-table-filter-row" });
      if (selecting) ftr.createEl("th", { cls: "smart-table-selcol" });
      state.columns.forEach((col, index) =>
        renderFilterControl(
          ftr.createEl("th", {
            cls: index === 0 ? "smart-table-th-first" : "",
          }),
          col
        )
      );
      ftr.createEl("th");
    }

    // Trailing delete column, plus a leading checkbox column while selecting.
    const fullSpan = String(state.columns.length + 1 + (selecting ? 1 : 0));

    const removeRow = (row) => {
      state.rows = state.rows.filter((r) => r.id !== row.id);
      commit();
    };
    // A row is "empty" when every cell is blank / unchecked — those delete
    // instantly. Rows with any content ask for confirmation first.
    const rowHasData = (row) =>
      state.columns.some((c) => {
        const v = row.cells[c.id];
        if (c.type === "checkbox") return v === true || v === "true";
        if (c.type === "multiselect") return asTags(v).length > 0;
        return v != null && v !== "";
      });
    const deleteRow = (row) => {
      if (!rowHasData(row)) {
        removeRow(row);
        return;
      }
      confirmAction(
        app,
        "Delete row?",
        "This row has data. Deleting it can't be undone.",
        "Delete row",
        () => removeRow(row)
      );
    };

    // Row actions menu, shared by the grip click and right-click. Notion-style:
    // insert above/below, duplicate, copy, delete.
    const openRowMenu = (evt, row) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i.setTitle("Insert row above").setIcon("arrow-up").onClick(() => insertRow(row, false))
      );
      menu.addItem((i) =>
        i.setTitle("Insert row below").setIcon("arrow-down").onClick(() => insertRow(row, true))
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("Duplicate row").setIcon("copy").onClick(() => duplicateRow(row))
      );
      menu.addItem((i) =>
        i.setTitle("Copy row").setIcon("clipboard-copy").onClick(() => copyRows([row]))
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("Delete row").setIcon("trash").onClick(() => deleteRow(row))
      );
      menu.showAtMouseEvent(evt);
    };

    // Bulk actions on the current selection.
    const deleteSelected = (targets) => {
      const ids = new Set(targets.map((r) => r.id));
      const doDelete = () => {
        state.rows = state.rows.filter((r) => !ids.has(r.id));
        selection.clear();
        commit();
      };
      if (targets.some(rowHasData)) {
        confirmAction(
          app,
          "Delete rows?",
          "Delete " + targets.length + " selected row" +
            (targets.length === 1 ? "" : "s") + "? This can't be undone.",
          "Delete rows",
          doDelete
        );
      } else {
        doDelete();
      }
    };

    const tbody = table.createEl("tbody");
    if (!shown.length) {
      const tr = tbody.createEl("tr");
      const td = tr.createEl("td", {
        cls: "smart-table-empty",
        attr: { colspan: fullSpan },
      });
      td.setText(state.rows.length ? "No rows match the filters." : "No rows yet.");
    }
    shown.forEach((row) => {
      const tr = tbody.createEl("tr");
      tr.dataset.rowId = row.id;
      if (selection.has(row.id)) tr.addClass("smart-table-row-selected");
      // Right-click anywhere on the row for its actions — reachable without
      // scrolling to the row's ✕ when the table has many columns.
      tr.oncontextmenu = (e) => {
        e.preventDefault();
        openRowMenu(e, row);
      };
      // Drop target for row reorder.
      tr.addEventListener("dragover", (e) => {
        if (dragRowId == null || dragRowId === row.id) return;
        e.preventDefault();
        const r = tr.getBoundingClientRect();
        const below = e.clientY > r.top + r.height / 2;
        clearRowIndicators();
        tr.classList.add(below ? "st-drop-below" : "st-drop-above");
      });
      tr.addEventListener("dragleave", () =>
        tr.classList.remove("st-drop-above", "st-drop-below")
      );
      tr.addEventListener("drop", (e) => {
        if (dragRowId == null) return;
        e.preventDefault();
        const r = tr.getBoundingClientRect();
        const below = e.clientY > r.top + r.height / 2;
        moveById(state.rows, dragRowId, row.id, below);
        dragRowId = null;
        commit();
      });
      if (selecting) {
        const selTd = tr.createEl("td", { cls: "smart-table-selcol" });
        const cb = selTd.createEl("input", { attr: { type: "checkbox" } });
        cb.checked = selection.has(row.id);
        cb.setAttr("aria-label", "Select row");
        cb.onclick = () => {
          if (cb.checked) selection.add(row.id);
          else selection.delete(row.id);
          draw();
        };
      }
      let firstTd = null;
      state.columns.forEach((col, ci) => {
        const td = tr.createEl("td", {
          cls: "smart-table-td" + (ci === 0 ? " smart-table-td-first" : ""),
        });
        if (ci === 0) firstTd = td;
        renderCell(td, col, row);
      });
      // Hover-only drag grip overlaid at the row's left edge — no permanent
      // gutter column.
      if (firstTd) {
        const grip = firstTd.createDiv({ cls: "smart-table-row-grip" });
        setIcon(grip, "grip-vertical");
        grip.setAttr("aria-label", "Click for row actions · drag to reorder");
        // Click (no drag) opens the row-actions menu (insert above/below,
        // duplicate, copy, delete), Notion-style.
        grip.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          openRowMenu(e, row);
        };
        grip.draggable = true;
        grip.addEventListener("dragstart", (e) => {
          bakeSortThenClear();
          dragRowId = row.id;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", row.id);
          }
          tr.classList.add("st-dragging");
        });
        grip.addEventListener("dragend", () => {
          dragRowId = null;
          clearRowIndicators();
          tr.classList.remove("st-dragging");
        });
      }
      const tdDel = tr.createEl("td", { cls: "smart-table-td-del" });
      const del = tdDel.createSpan({ cls: "smart-table-row-del" });
      setIcon(del, "x");
      del.setAttr("aria-label", "Delete row");
      del.onclick = () => deleteRow(row);
    });

    // Footer "+ New row" — add rows without scrolling back up to the toolbar.
    const addTr = tbody.createEl("tr", { cls: "smart-table-addrow" });
    const addTd = addTr.createEl("td", {
      cls: "smart-table-addrow-cell",
      attr: { colspan: fullSpan },
    });
    const addInner = addTd.createDiv({ cls: "smart-table-addrow-inner" });
    setIcon(addInner.createSpan({ cls: "smart-table-addrow-ico" }), "plus");
    addInner.createSpan({ text: "New row" });
    addTd.setAttr("aria-label", "Add a row");
    addTd.onclick = appendRow;

    // Restore the scroll position captured before the rebuild.
    if (keepScrollLeft || keepScrollTop) {
      wrap.scrollLeft = keepScrollLeft;
      wrap.scrollTop = keepScrollTop;
    }
  }

  // Keyboard copy/paste of whole rows. Registered once on the container (which
  // is made focusable); a grip click focuses it so ⌘C/⌘V land here.
  el.tabIndex = -1;
  el.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "c" && selection.size) {
      copyRows(state.rows.filter((r) => selection.has(r.id)));
      draw(); // reveal the toolbar Paste button
      e.preventDefault();
    } else if (k === "v" && rowClipboard.length) {
      pasteIntoSelection();
      e.preventDefault();
    }
  });

  build();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// Insert a starter smart-table block at the editor's cursor.
function insertTableBlock(editor) {
  const json = JSON.stringify(defaultState());
  const cur = editor.getCursor();
  const atLineStart = cur.ch === 0;
  const text = (atLineStart ? "" : "\n") + "```smart-table\n" + json + "\n```\n";
  editor.replaceRange(text, cur);
  const added = text.split("\n").length - 1;
  editor.setCursor({ line: cur.line + added, ch: 0 });
}

const FENCE_OPEN = /^`{3,}\s*smart-table\s*$/;
const FENCE_CLOSE = /^`{3,}\s*$/;

// Rewrite the smart-table block that contains the widget `el` with `state`,
// by dispatching a CodeMirror change (the Live-Preview counterpart to the
// Reading-view persist()). `annotation` tags the change as our own so the
// decoration field can keep the existing widget instead of rebuilding it
// (which would reset the table's scroll position).
function persistToEditor(view, el, state, annotation) {
  let pos;
  try {
    pos = view.posAtDOM(el);
  } catch (e) {
    return;
  }
  const doc = view.state.doc;
  const startLine = doc.lineAt(pos).number;
  let open = null;
  for (let i = startLine; i >= 1; i--) {
    if (FENCE_OPEN.test(doc.line(i).text)) {
      open = i;
      break;
    }
    if (i !== startLine && FENCE_CLOSE.test(doc.line(i).text)) break;
  }
  if (open == null) return;
  let close = null;
  for (let i = open + 1; i <= doc.lines; i++) {
    if (FENCE_CLOSE.test(doc.line(i).text)) {
      close = i;
      break;
    }
  }
  if (close == null) return;
  // Replace only the JSON *between* the fences, leaving the fence lines
  // untouched. That keeps the widget decoration's boundaries stable so the
  // field can map (not rebuild) it — no widget recreation, no flicker.
  const json = JSON.stringify(state);
  const hasBody = close - 1 >= open + 1;
  const changes = hasBody
    ? { from: doc.line(open + 1).from, to: doc.line(close - 1).to, insert: json }
    : { from: doc.line(open).to, to: doc.line(open).to, insert: "\n" + json };
  const spec = { changes };
  if (annotation) spec.annotations = annotation;
  view.dispatch(spec);
}

// A CodeMirror 6 editor extension that, in Live Preview, replaces each
// smart-table fenced block with the interactive table widget — so the raw JSON
// is never revealed when the cursor enters the block. Reading view keeps using
// the markdown code-block processor. Returns null if the CM6 modules aren't
// available (older Obsidian), leaving Reading view unaffected.
function smartTableEditorExtension(plugin) {
  let cmView, cmState, obs;
  try {
    cmView = require("@codemirror/view");
    cmState = require("@codemirror/state");
    obs = require("obsidian");
  } catch (e) {
    console.warn("[SmartTable] CM6 modules unavailable — Live Preview falls back to the code-block processor.", e);
    return null;
  }
  const { EditorView, Decoration, WidgetType } = cmView;
  const { StateField, Annotation, Prec } = cmState;
  const livePreviewField = obs.editorLivePreviewField;
  // Marks changes made by the widget itself (a cell edit writing JSON back), so
  // the field maps the existing decorations instead of rebuilding the widget —
  // which would recreate the DOM and reset the table's scroll position.
  const selfEdit = Annotation.define();

  class SmartTableWidget extends WidgetType {
    constructor(source) {
      super();
      this.source = source;
    }
    eq(other) {
      return other.source === this.source;
    }
    toDOM(view) {
      const el = document.createElement("div");
      el.className = "smart-table smart-table-lp";
      el.setAttribute("contenteditable", "false");
      renderTable(plugin.app, this.source, el, (state) =>
        persistToEditor(view, el, state, selfEdit.of(true))
      );
      return el;
    }
    ignoreEvent() {
      return true; // let the table's own inputs/menus handle events
    }
  }

  const buildDecos = (state) => {
    if (livePreviewField && !state.field(livePreviewField, false)) {
      return Decoration.none;
    }
    const doc = state.doc;
    const ranges = [];
    let i = 1;
    while (i <= doc.lines) {
      if (FENCE_OPEN.test(doc.line(i).text)) {
        let close = null;
        for (let j = i + 1; j <= doc.lines; j++) {
          if (FENCE_CLOSE.test(doc.line(j).text)) {
            close = j;
            break;
          }
        }
        if (close != null) {
          const src =
            close - 1 >= i + 1
              ? doc.sliceString(doc.line(i + 1).from, doc.line(close - 1).to)
              : "";
          ranges.push(
            Decoration.replace({
              widget: new SmartTableWidget(src),
              block: true,
            }).range(doc.line(i).from, doc.line(close).to)
          );
          i = close + 1;
          continue;
        }
      }
      i++;
    }
    return Decoration.set(ranges, true);
  };

  const field = StateField.define({
    create: (state) => buildDecos(state),
    update: (deco, tr) => {
      // Our own cell edits: keep the existing widget (the DOM was already
      // updated in place, with scroll preserved) — just map its range.
      if (tr.annotation(selfEdit) !== undefined) return deco.map(tr.changes);
      const lpChanged =
        livePreviewField &&
        tr.startState.field(livePreviewField, false) !==
          tr.state.field(livePreviewField, false);
      if (tr.docChanged || lpChanged) return buildDecos(tr.state);
      return deco.map(tr.changes);
    },
    provide: (f) => [
      EditorView.decorations.from(f),
      EditorView.atomicRanges.of((v) => v.state.field(f) || Decoration.none),
    ],
  });
  // Highest precedence so our block widget outranks Obsidian's built-in
  // code-block rendering for the same range (otherwise the widget never
  // renders and the plain processor shows through — the source of the flicker).
  return Prec ? Prec.highest(field) : field;
}

module.exports = class SmartTablePlugin extends Plugin {
  onload() {
    // Reading view only: a generic post-processor (which does NOT fire in Live
    // Preview) so it never makes Obsidian "own" the code block in the editor —
    // leaving Live Preview entirely to the CodeMirror widget below. Using
    // registerMarkdownCodeBlockProcessor instead would force Obsidian to render
    // the block in Live Preview and outrank the widget.
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (el.closest(".markdown-source-view")) return; // safety: skip editor
      el.querySelectorAll("pre > code.language-smart-table").forEach((code) => {
        const pre = code.parentElement;
        const source = code.textContent || "";
        const container = document.createElement("div");
        pre.replaceWith(container);
        renderTable(this.app, source, container, (state) =>
          persist(this.app, ctx, container, state)
        );
      });
    });

    // Live Preview: render the table as a persistent editor widget so the raw
    // JSON isn't exposed when the cursor enters the block. Guarded so a CM6
    // incompatibility can't break Reading view.
    try {
      const ext = smartTableEditorExtension(this);
      if (ext) this.registerEditorExtension(ext);
    } catch (e) {
      console.error("[SmartTable] Live Preview extension failed to load", e);
    }

    this.addCommand({
      id: "insert-smart-table",
      name: "Insert table",
      editorCallback: (editor) => insertTableBlock(editor),
    });

    // Left-sidebar ribbon button to insert a table into the active note.
    this.addRibbonIcon("table", "Insert Smart Table", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.editor) {
        new Notice("Smart Table: open a note in edit mode to insert a table.");
        return;
      }
      insertTableBlock(view.editor);
    });

    // Convert a plain Markdown table (selected, or under the cursor) in place.
    this.addCommand({
      id: "convert-md-table",
      name: "Convert Markdown table to Smart Table",
      editorCallback: (editor) => {
        const range = findTableRange(editor);
        if (!range) {
          new Notice(
            "Smart Table: select a Markdown table or place the cursor in one first."
          );
          return;
        }
        convertTableRange(editor, range);
      },
    });

    // Same conversion as a right-click menu item, shown only when the editor
    // selection or cursor is actually sitting on a Markdown table.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const range = findTableRange(editor);
        if (!range || !parseMarkdownTable(range.text)) return;
        menu.addItem((item) =>
          item
            .setTitle("Convert to Smart Table")
            .setIcon("table")
            .onClick(() => convertTableRange(editor, range))
        );
      })
    );
  }
};
