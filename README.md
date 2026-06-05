# Smart Table

Interactive tables inside your notes — typed columns, sorting, filtering, and
status pills, with easy add/remove of columns and rows. The table is stored as
a fenced `smart-table` code block (JSON), so all your edits are saved right in
the note and sync like any other text.

## Usage

Run the command **Smart Table: Insert table** (Command palette, <kbd>Cmd/Ctrl</kbd>+<kbd>P</kbd>)
to drop a starter table at the cursor. The block renders as an interactive grid
in Reading view and Live Preview.

- **Sort** — open a column's ▾ menu → Sort ascending / descending.
- **Filter** — click **Filter** in the toolbar to show a per-column filter row.
- **Add / remove columns** — **+ Column** in the toolbar (pick a type), or a
  column's ▾ menu → Delete column. Rename inline in the header.
- **Add / remove rows** — **+ Row** in the toolbar; hover a row and click ✕.
- **Column types** — Text, Number, Date, Checkbox, Select, and **Status**
  (colored pills; add your own options on the fly).

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
