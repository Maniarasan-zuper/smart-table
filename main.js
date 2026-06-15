"use strict";

const { Plugin, Menu, Modal, Notice, setIcon } = require("obsidian");

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

const COLUMN_TYPES = ["text", "number", "date", "checkbox", "select", "status"];
const TYPE_LABELS = {
  text: "Text",
  number: "Number",
  date: "Date",
  checkbox: "Checkbox",
  select: "Select",
  status: "Status",
};

function typeIcon(t) {
  return (
    {
      text: "text",
      number: "hash",
      date: "calendar",
      checkbox: "check-square",
      select: "chevron-down-circle",
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
  if (col.type === "number") {
    const [minS, maxS] = splitPair(fv);
    if (minS === "" && maxS === "") return true;
    const n = parseFloat(raw);
    if (isNaN(n)) return false;
    if (minS !== "" && n < parseFloat(minS)) return false;
    if (maxS !== "" && n > parseFloat(maxS)) return false;
    return true;
  }
  if (col.type === "date") {
    const [from, to] = splitPair(fv);
    if (from === "" && to === "") return true;
    // Stored as YYYY-MM-DD, which compares chronologically as strings.
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

function addColumn(state, type) {
  const col = { id: uid("c"), name: "Column " + (state.columns.length + 1), type };
  if (type === "status") col.options = defaultStatusOptions();
  if (type === "select") col.options = [];
  state.columns.push(col);
  state.rows.forEach((r) => (r.cells[col.id] = type === "checkbox" ? false : ""));
}

function changeColumnType(col, type) {
  col.type = type;
  if ((type === "status" || type === "select") && !Array.isArray(col.options)) {
    col.options = type === "status" ? defaultStatusOptions() : [];
  }
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
  const block =
    "```smart-table\n" + JSON.stringify(state, null, 2) + "\n```";
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

function exportTableCSV(state) {
  // RFC 4180 quoting: wrap fields containing quotes, commas, or newlines.
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [state.columns.map((c) => esc(c.name)).join(",")];
  viewRows(state).forEach((row) => {
    lines.push(
      state.columns
        .map((c) => {
          const v = row.cells[c.id];
          if (c.type === "checkbox") return esc(v === true || v === "true");
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
  a.download = "smart-table.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
      cells[col.id] = col.type === "checkbox" ? toBool(raw) : raw;
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
  const block = "```smart-table\n" + JSON.stringify(state, null, 2) + "\n```";
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTable(app, source, el, ctx) {
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

  // Rebuild the whole widget from `state`.
  const draw = () => build();
  // Mutation entry point: redraw immediately, then write to disk.
  const commit = () => {
    build();
    persist(app, ctx, el, state);
  };

  // Append a blank row and persist. Shared by the toolbar button and the
  // "+ New row" footer at the bottom of the grid.
  const appendRow = () => {
    const row = { id: uid("r"), cells: {} };
    state.columns.forEach(
      (c) => (row.cells[c.id] = c.type === "checkbox" ? false : "")
    );
    state.rows.push(row);
    commit();
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
          .onClick(() => {
            changeColumnType(col, t);
            commit();
          })
      )
    );
    menu.addSeparator();
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

  function openSelectMenu(evt, col, row) {
    const menu = new Menu();
    (col.options || []).forEach((o) =>
      menu.addItem((i) =>
        i
          .setTitle(o.label)
          .setIcon(row.cells[col.id] === o.label ? "check" : "circle")
          .onClick(() => {
            row.cells[col.id] = o.label;
            commit();
          })
      )
    );
    if (col.options && col.options.length) menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Clear")
        .setIcon("x")
        .onClick(() => {
          row.cells[col.id] = "";
          commit();
        })
    );
    menu.addItem((i) =>
      i
        .setTitle("New option…")
        .setIcon("plus")
        .onClick(() =>
          promptText(app, "New option", "", (label) => {
            if (label) {
              addOption(col, label);
              row.cells[col.id] = label;
              commit();
            }
          })
        )
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
    } else if (col.type === "select" || col.type === "status") {
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
    } else if (col.type === "number" || col.type === "date") {
      const [a, b] = splitPair(cur);
      const inType = col.type === "number" ? "number" : "date";
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
    if (col.type === "checkbox") {
      const cb = td.createEl("input", { attr: { type: "checkbox" } });
      cb.checked = val === true || val === "true";
      cb.onchange = () => {
        row.cells[col.id] = cb.checked;
        commit();
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
      pill.onclick = (e) => openSelectMenu(e, col, row);
    } else {
      const type = col.type === "number" ? "number" : col.type === "date" ? "date" : "text";
      const inp = td.createEl("input", {
        cls: "smart-table-cell-input",
        attr: { type },
      });
      inp.value = val == null ? "" : val;
      inp.onchange = () => {
        row.cells[col.id] = inp.value;
        commit();
      };
    }
  }

  function build() {
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
      commit();
    };

    const csvBtn = bar.createEl("button", { cls: "smart-table-btn" });
    setIcon(csvBtn.createSpan(), "download");
    csvBtn.createSpan({ text: "Export CSV" });
    csvBtn.setAttr("aria-label", "Export this table to CSV");
    csvBtn.onclick = () => exportTableCSV(state);

    const shown = viewRows(state);
    bar.createDiv({
      cls: "smart-table-count",
      text: shown.length + " of " + state.rows.length,
    });

    // Table ---------------------------------------------------------------
    const wrap = el.createDiv({ cls: "smart-table-wrap" });
    const table = wrap.createEl("table", { cls: "smart-table-grid" });

    const thead = table.createEl("thead");
    const htr = thead.createEl("tr");
    state.columns.forEach((col) => {
      const th = htr.createEl("th", { cls: "smart-table-th" });
      const inner = th.createDiv({ cls: "smart-table-th-inner" });
      setIcon(inner.createSpan({ cls: "smart-table-th-ico" }), typeIcon(col.type));
      const name = inner.createEl("input", { cls: "smart-table-th-name" });
      name.value = col.name;
      name.onchange = () => {
        col.name = name.value;
        commit();
      };
      if (state.sort && state.sort.col === col.id) {
        inner.createSpan({
          cls: "smart-table-sort",
          text: state.sort.dir === "asc" ? "↑" : "↓",
        });
      }
      const menuBtn = inner.createSpan({ cls: "smart-table-th-menu" });
      setIcon(menuBtn, "chevron-down");
      menuBtn.onclick = (e) => openColumnMenu(e, col);
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
      state.columns.forEach((col) =>
        renderFilterControl(ftr.createEl("th"), col)
      );
      ftr.createEl("th");
    }

    // One trailing column holds the delete handle.
    const fullSpan = String(state.columns.length + 1);

    const removeRow = (row) => {
      state.rows = state.rows.filter((r) => r.id !== row.id);
      commit();
    };
    // A row is "empty" when every cell is blank / unchecked — those delete
    // instantly. Rows with any content ask for confirmation first.
    const rowHasData = (row) =>
      state.columns.some((c) => {
        const v = row.cells[c.id];
        return c.type === "checkbox" ? v === true || v === "true" : v != null && v !== "";
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
      // Right-click anywhere on the row to delete it — reachable without
      // scrolling to the row's ✕ when the table has many columns.
      tr.oncontextmenu = (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((i) =>
          i
            .setTitle("Delete row")
            .setIcon("trash")
            .onClick(() => deleteRow(row))
        );
        menu.showAtMouseEvent(e);
      };
      state.columns.forEach((col) => {
        const td = tr.createEl("td", { cls: "smart-table-td" });
        renderCell(td, col, row);
      });
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
  }

  build();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = class SmartTablePlugin extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor("smart-table", (source, el, ctx) => {
      renderTable(this.app, source, el, ctx);
    });

    this.addCommand({
      id: "insert-smart-table",
      name: "Insert table",
      editorCallback: (editor) => {
        const json = JSON.stringify(defaultState(), null, 2);
        const cur = editor.getCursor();
        const atLineStart = cur.ch === 0;
        const text =
          (atLineStart ? "" : "\n") + "```smart-table\n" + json + "\n```\n";
        editor.replaceRange(text, cur);
        const added = text.split("\n").length - 1;
        editor.setCursor({ line: cur.line + added, ch: 0 });
      },
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
