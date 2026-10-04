# pdf-ink: Obsidian plugin for pen annotation on PDFs

## Invariants (never violate)
- Never modify the source PDF. Annotations live in `<file>.ink.json` beside it.
- All stroke points are stored in PDF user space (points, y up), obtained via
  pdf.js `viewport.convertToPdfPoint`. Never store screen or canvas pixels.
- No Node or Electron APIs (fs, path, require). Use `app.vault` only. Must run on mobile.
- Use Obsidian's `loadPdfJs()`; do not bundle a second pdf.js.
- Export uses pdf-lib on the original bytes. Every original page keeps its size and
  its relative order; the only pages the output adds are inserted pages, spliced in
  at the positions their records describe.

## Stack
TypeScript, esbuild (sample plugin config), pdf-lib, perfect-freehand.

## Identity
- Author and GitHub owner: specialseeds (github.com/specialseeds). Use that handle
  everywhere — manifest, package.json, README, LICENSE, workflows. Never write any
  other account name or email into the repo, including one picked up from the git
  config or the environment.
## Data schema (version 5)
{ version: 5, pages: { [pageKey]: Item[] }, insertedPages: InsertedPage[],
  docId?, layout?: "board" }
PageKey = "pdf:<0-based index>" for a page of the source PDF
        | "ins:<uuid>"          for an inserted page
Item = Stroke | Shape | TextBox | Path, all coordinates in PDF user space
Base  = { id, type, color, opacity, rotation, z, updatedAt, deletedAt? }
Stroke  = Base & { type: "stroke", tool: "pen"|"highlighter", width, points: [x,y,p][] }
Shape   = Base & { type: "shape", kind: ShapeKind, box: {x,y,w,h}, width, fill: null|color }
ShapeKind = "line" | "arrow" | "rect" | "ellipse" | "triangle"
          | "axes2d_q" | "axes2d_c" | "axes3d_c"
TextBox = Base & { type: "text", box: {x,y,w,h}, text, fontSize }
Path    = Base & { type: "path", d, strokeWidth?, highlight? }
  d = SVG-style path data, absolute M, L, C, Z only, in PDF user space
InsertedPage = { id, afterPdfPage, sortKey, template, size: {width,height},
                 origin?: {x,y}, updatedAt, deletedAt? }
  origin = the page's bottom-left corner in PDF space, (0, 0) when absent
PageTemplate = "blank" | "lined" | "lined7.5" | "lined10" | "grid5" | "dot"
- Items are keyed by page identity, never by position. An index cannot survive an
  insertion: putting a page before page 3 would re-home every annotation after it.
  Migrate v1, v2 and v3 sidecars by rewriting the numeric key as "pdf:<n>".
- Page order is derived, never stored: inserted pages sit after `afterPdfPage`
  (-1 means before the first page), ordered by `sortKey` and then by `id`.
  src/core/pages.ts owns this; the viewer and the exporter both go through it, so
  they cannot disagree about what page 4 is.
- `sortKey` is a fractional index (src/core/fracindex.ts), not a position. Two
  devices inserting into the same gap compute the *same* key from the same
  neighbours, so both pages survive a merge and the `id` tiebreak orders them
  identically on both. Inserting between two pages that already share a key is not
  possible, so the new page goes after the tied run instead.
- Merge page records by id with the same rule as items: newest `updatedAt` wins, a
  tombstone wins an exact tie, and tombstones are pruned on the same 90-day window.
- Deleting a page tombstones the page and every item on it as ONE history
  operation, so a single undo restores both. A page that came back empty would be
  worse than no undo at all.
- Only inserted pages can be deleted or re-ruled. The source PDF is never modified
  and there is no record that could represent a missing original page.
- Every template has ONE geometry function in src/core/templates.ts returning lines
  and dots in PDF space. Canvas rendering and pdf-lib export both consume it.
- An inserted page has no pdf.js page, so it gets a synthetic PageViewport
  (src/core/page-viewport.ts) that behaves exactly like pdf.js's for an unrotated
  page. Everything downstream converts coordinates through a viewport as usual.
- Every shape kind has ONE geometry function in src/core/shapes.ts returning
  path commands in PDF space. Canvas rendering and pdf-lib export both consume it.
- Path geometry has ONE function, `pathGeometry` in src/core/path.ts, which the
  canvas renderer and the pdf-lib exporter both draw. A path is filled unless it
  has `strokeWidth`; `highlight` puts it on the highlighter layer and blend. Lasso
  transforms bake into its points (rotation stays 0), recolour changes `color`,
  the stroke eraser hits it, and the sized eraser removes it WHOLE, never cuts it.
- A v4 file reads as v5 unchanged; only its version is bumped on the next save.
- Migrate v1 (strokes only) and v2 (no timestamps) sidecars on load. Items from an
  older file are stamped updatedAt = 0, so any genuine remote edit beats them.
- Deletion is a tombstone (deletedAt), never a splice: a removal that left no
  trace would be resurrected by another device's stale copy.
- On load, and before every write, merge the file on disk item by item: newest
  updatedAt wins, and a tombstone wins an exact tie. Sync conflict copies beside
  the sidecar are merged in and trashed.
- Write sidecars through a temp file and a rename, keeping one .bak. On load,
  recover a missing sidecar from .tmp, then .bak, accepting only one that parses.
- Ignore vault modify events whose content hash matches our last write.
- Prune tombstones older than 90 days on save.
- 3D axes are right-handed: y right, z up, x out of the page (drawn down-left,
  solid and arrow-tipped; the into-page half is dashed). The out-of-page axis is
  drawn at 45 degrees and 75% of the in-plane axis length.
- There is only one 3D axes kind. A sidecar naming the removed "axes3d_q" is
  migrated to "axes3d_c" on load.
- Stroke gains optional `taper: { start: boolean, end: boolean }` (default both
  true). Eraser fragments set taper false on any end created by a cut.

## Notebooks (.inknote)
- A `.inknote` file IS the v4 document (same schema, no sidecar). It has no PDF, so
  every page is an inserted page in gap -1 (`afterPdfPage: -1`).
- Never rename or delete an open notebook to save it: write `.tmp`, copy the notebook
  as opened to `.bak` once per session, then `vault.modify` it in place and drop the
  `.tmp`. Recovery is by content, never by rename. An empty file is an empty
  notebook, not a corrupt one.
- Ink near the bottom of the last page appends a page in the SAME undo step as the
  ink (`InkHistory.pushJoined`), so one undo removes both.
- A notebook has `docId` (uuid), set at creation and assigned on load if missing.
  Merges keep ours; reconcile adopts a docId reassigned on disk. Any path that
  creates a notebook from another must give it a new docId (`withNewDocId`).
- `Notes 2.inknote` beside `Notes.inknote` with the SAME docId is offered for
  merging in a modal (Merge: merge then trash; Keep separate: new docId on the
  copy). Never merge a numbered copy silently; a different or missing docId is
  never asked about.

## Boards
- A board is a notebook with `layout: "board"` and ONE inserted page, as wide as
  it needs to be. It never appends a page. Ink committed within 10% of the right
  or bottom edge grows that page (src/core/board.ts) in the SAME undo step as the
  ink (`resizePageJoined`, a joined `page-transform`).
- Growing down lowers the page's `origin`; it never moves items. Moving every item
  would rewrite thousands of imported paths and misplace another device's ink on
  merge. Everything that maps a page (the synthetic viewport, ruling, export
  MediaBox) honours the origin.
- Growth comes in whole multiples of the template's spacing, so the ruling under
  existing ink never shifts.
- A board opens at fit-height and pans both ways. Two fingers pan while pinching.
- Export: a board is one PDF page at its size. A side over 14,400 pt (PDF's limit)
  is scaled uniformly to fit, and the export notice says so.

## Page themes
- Theme is render-time only: never rewrite a stored colour. Only base ink (near
  black or near white, per channel) maps to the theme's base ink; every other colour
  renders exactly as stored.
- Original PDF pages always use the light mapping, whatever the view's theme.
- Default colours live in ONE place, `DEFAULT_PAGE_THEMES` in src/core/theme.ts.
  Settings store only overrides; `effectiveThemes` lays them over the defaults. The
  screen and the exporter both use the effective themes.
- Highlighter blend comes from the paper's luminance (multiply on light, screen on
  dark), never from the theme's name.

## Workflow
- Small commits per feature. Run `npm run build` and fix all type errors before finishing.
- Pure geometry and serialization logic goes in `src/core/` with unit tests (vitest).