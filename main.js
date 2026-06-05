"use strict";

const { Plugin, Menu, Modal, setIcon } = require("obsidian");

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

// Rows after applying filters and sort (does not mutate state.rows).
function viewRows(state) {
  let rows = state.rows.slice();
  const f = state.filters || {};
  rows = rows.filter((r) =>
    state.columns.every((c) => {
      const fv = (f[c.id] || "").toString().trim().toLowerCase();
      if (!fv) return true;
      const raw = r.cells[c.id];
      if (c.type === "checkbox") {
        const want = ["true", "yes", "1", "done", "checked"].includes(fv);
        return (raw === true || raw === "true") === want;
      }
      return (raw == null ? "" : raw.toString().toLowerCase()).includes(fv);
    })
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
  const apply = (data) => {
    const lines = data.split("\n");
    lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, block);
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
          state.columns = state.columns.filter((c) => c.id !== col.id);
          state.rows.forEach((r) => delete r.cells[col.id]);
          if (state.sort && state.sort.col === col.id) state.sort = null;
          delete state.filters[col.id];
          commit();
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
    addRow.onclick = () => {
      const row = { id: uid("r"), cells: {} };
      state.columns.forEach((c) => (row.cells[c.id] = c.type === "checkbox" ? false : ""));
      state.rows.push(row);
      commit();
    };

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
      state.columns.forEach((col) => {
        const fth = ftr.createEl("th");
        const fi = fth.createEl("input", {
          cls: "smart-table-filter-input",
          attr: { type: "text", placeholder: "Filter…" },
        });
        fi.value = state.filters[col.id] || "";
        fi.onchange = () => {
          state.filters[col.id] = fi.value;
          commit();
        };
      });
      ftr.createEl("th");
    }

    const tbody = table.createEl("tbody");
    if (!shown.length) {
      const tr = tbody.createEl("tr");
      const td = tr.createEl("td", {
        cls: "smart-table-empty",
        attr: { colspan: String(state.columns.length + 1) },
      });
      td.setText(state.rows.length ? "No rows match the filters." : "No rows yet.");
    }
    shown.forEach((row) => {
      const tr = tbody.createEl("tr");
      state.columns.forEach((col) => {
        const td = tr.createEl("td", { cls: "smart-table-td" });
        renderCell(td, col, row);
      });
      const tdDel = tr.createEl("td", { cls: "smart-table-td-del" });
      const del = tdDel.createSpan({ cls: "smart-table-row-del" });
      setIcon(del, "x");
      del.setAttr("aria-label", "Delete row");
      del.onclick = () => {
        state.rows = state.rows.filter((r) => r.id !== row.id);
        commit();
      };
    });
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
  }
};
