# Lark Base Analytics (Chrome Extension)

Open a **Lark Base (Bitable)** table and the extension **automatically generates
a summary analytics report** on the page — no clicks, no manual export.

It works by reading the JSON the Base page already loads over the network (your
existing logged-in session), decompressing it in the browser, resolving cell
values to readable labels, and rendering a report panel. Nothing leaves your
machine; the page and your data are never modified.

> Works on Lark **Base** URLs (`…/base/<token>?table=…`). It does **not** work on
> classic Lark **Sheets** (`/sheets/`), which render on a canvas with no data to read.

## Install (developer mode)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. **Load unpacked** → select this folder (`handover_ext`)

## Use

1. Open your Lark Base table. **Reload the tab once** after installing so the
   network hook is active from page load.
2. A **📊 Productivity** button appears bottom-right and the panel auto-opens once
   the data has loaded (a couple of seconds for large tables).
3. On the **translation work-log** table the panel is **pivot-focused**: it shows
   the colored Translator-productivity pivot with a month-range picker and buttons
   to **⬇ Load all rows**, **⛶ Open full view**, **⬇ Excel**, **CSV**, and **📋 Copy**.
   On any other table it falls back to the generic per-column analytics (filter +
   field cards + HTML/CSV/Raw-CSV export).
4. Clicking the toolbar icon opens the same view in a popup (handy if the on-page
   panel is closed).

## What it reports

Per column, the field type is detected (number / date / single & multi select /
checkbox / user / text / link) and the relevant stats are shown:

- **Number** — count, sum, mean, median, min, max, std dev
- **Date** — earliest, latest, span in days
- **Checkbox** — checked / unchecked
- **Select / user / text / link** — distinct count + top values with counts
- **All** — filled vs. empty cells

Columns are ordered most-populated first. Top line: rows, columns, and how many
are numeric / categorical / date.

## How it works

```
Lark Base tab
 └─ src/interceptor.js  (page context) patches fetch/XHR, captures record + schema JSON
      └─ src/content.js (isolated)  decompresses (gzip+base64), builds dataset,
           │                        auto-renders the on-page report panel (Shadow DOM)
           ├─ src/lark-core.js      shared engine: parse → resolve cells → analytics → render/export
           └─ src/popup.js          same report in the toolbar popup
```

Key endpoints consumed:
- `…/space/api/v1/bitable/<token>/records` → `data.records` = base64(gzip(JSON)) →
  `recordMap` (record → field → `{value}`), order from `groupList[].recordIDList`
- `…/space/api/v1/bitable/<token>/clientvars` → `data.table` = base64(gzip(JSON)) →
  `fieldMap` (names, types, select options) + `userMap`

## Translator productivity report (Handover pivot)

When the open table contains the fields **Translator**, **Proofreader**,
**Word Count** (and optionally **UI Reviewer** + **#UI Review Word Count** and
**Translation Completion Time**), the extension also auto-builds a **pivot**:

- **Rows** = Translation Completion Date (per day; records with no completion date
  fall under *(in progress)*)
- **Columns** = each person × {**Translate**, **Proofread**, **Haibao**}
- **Values** = summed word counts — a record's `Word Count` is added to its
  Translator's *Translate* and its Proofreader's *Proofread*; `#UI Review Word
  Count` is added to the UI Reviewer's *Haibao*.

Each **person** gets a consistent pastel color band across their Translate /
Proofread / Haibao columns, with a two-row grouped header (person name over stage).

Reviewing & exporting the pivot:

- **⛶ Open full view** opens the complete, colored pivot in a **new browser tab** —
  a full-screen, scrollable page (sticky header + first column) with a **🖨 Print /
  Save as PDF** button and self-contained **Excel** + **CSV** download links.
- **⬇ Excel** downloads a real **`.xlsx`** styled like the handover sheet: per-person
  colored headers, merged person bands, frozen header rows + date column, thousands
  separators, and a highlighted Total / Task-Canceled / Task-in-progress / Banner row.
  (Built in-browser with a tiny dependency-free OOXML writer — no upload, no library.)
- **CSV** / **📋 Copy** export the same grid as CSV / tab-separated text.

Note: the pivot lives in the *translation work-log* table — not the request-system
table — so open that table for it to appear.

## Limitations

- Only rows the page has loaded are analyzed. Lark sends a large initial batch;
  if your table is bigger than what loaded, scroll to load more and the report
  refreshes automatically.
- **Dynamic single-selects** (options synced from another field/table) may show
  raw option IDs (e.g. `optQQklYSj`) when the label isn't included in the loaded
  schema. The counts/grouping are still correct — only the human label is missing.
- Classic Sheets (`/sheets/`) are unsupported (canvas-rendered).
