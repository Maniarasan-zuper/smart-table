# Smart Table

Interactive tables inside your notes — typed columns, sorting, filtering, and
status pills, with easy add/remove of columns and rows. The table is stored as
a fenced `smart-table` code block (JSON), so all your edits are saved right in
the note and sync like any other text.

![Smart Table demo](https://raw.githubusercontent.com/Maniarasan-zuper/smart-table/main/demo.gif)

Wrap headers and cells, resize and align columns, drag to reorder rows and
columns, and delete safely:

![Smart Table header/text wrap, resize, align, reorder and safe-delete demo](https://raw.githubusercontent.com/Maniarasan-zuper/smart-table/main/demo-features.gif)

## Usage

Run the command **Smart Table: Insert table** (Command palette, <kbd>Cmd/Ctrl</kbd>+<kbd>P</kbd>)
to drop a starter table at the cursor. The block renders as an interactive grid
in Reading view and Live Preview.

- **Sort** — open a column's ▾ menu → Sort ascending / descending.
- **Filter** — click **Filter** in the toolbar to show a per-column filter row.
- **Add / remove columns** — **+ Column** in the toolbar (pick a type), or a
  column's ▾ menu → Delete column. Rename inline in the header.
- **Add / remove rows** — **+ Row** in the toolbar or the **+ New row** strip at
  the bottom of the grid (no scrolling back up); delete a row by hovering it and
  clicking ✕, or right-click anywhere on the row → **Delete row**.
- **Safe deletes** — deleting a column always asks for confirmation, and so does
  deleting a row that has data; blank rows are removed instantly.
- **Resize columns** — drag a column header's right edge; the width is saved
  with the table.
- **Wrapping text** — text columns and column headers wrap long content onto
  multiple lines and grow to fit.
- **Align text** — a column's ▾ menu → **Text align** sets Left / Center / Right
  for every cell in that column.
- **Reorder** — drag a column by its type icon to move it; hover a row and drag
  the ⠿ grip to reorder rows (dragging a sorted row switches to manual order).
- **Column types** — Text, Number, Date, Checkbox, Select, and **Status**
  (colored pills; add your own options on the fly).
- **Export CSV** — the toolbar **Export CSV** button downloads the table as
  currently sorted and filtered (RFC 4180 quoting, UTF-8 BOM for Excel).

### Convert an existing Markdown table

Already have a plain pipe table? Select it (or just place the cursor inside it)
and either right-click → **Convert to Smart Table**, or run the command
**Smart Table: Convert Markdown table to Smart Table**. The table is replaced
in place, and column types are inferred from the data — numbers become Number,
`YYYY-MM-DD` values become Date, and `[x]` / `true` / `yes` become Checkbox.

## How data is stored

Everything lives in the code block as JSON:

````markdown
```smart-table
{
  "columns": [ ... ],
  "rows": [ ... ],
  "sort": { "col": "...", "dir": "asc" },
  "filters": {}
}
```
````

To edit a table's source directly, place your cursor inside the block in Live
Preview (or switch to Source mode).

## Install

### Manually

1. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<your vault>/.obsidian/plugins/smart-table/`.
2. **Settings → Community plugins → Enable Smart Table.**

## License

MIT © maniarasan.s
