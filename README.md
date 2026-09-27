# PDF ink

**Handwritten annotation for PDFs inside Obsidian.** Pen, highlighter, shapes, text,
two erasers, lasso select — and blank pages you can add anywhere in the document.

[![release](https://img.shields.io/github/v/release/specialseeds/pdf-ink?display_name=tag&sort=semver)](https://github.com/specialseeds/pdf-ink/releases/latest)
[![downloads](https://img.shields.io/github/downloads/specialseeds/pdf-ink/total)](https://github.com/specialseeds/pdf-ink/releases)
[![licence](https://img.shields.io/badge/licence-0BSD-blue)](LICENSE)

The source PDF is never modified. Annotations live in a sidecar JSON file beside it,
recorded in PDF coordinates rather than pixels, so they stay put at any zoom, on any
screen, on any device. When you want something shareable, export a flattened copy — or
one whose strokes are still editable in Acrobat and Preview.

Works on desktop and on mobile.

---

## Why a separate view

This plugin does **not** take over `.pdf` files. Obsidian's built-in viewer stays the
default and the ink view is opened deliberately, per file. Nothing about your existing
PDF reading changes, and you can keep the plain viewer open in a tab beside the
annotated one.

## Install

Not yet in the community plugin browser.

**With [BRAT](https://github.com/TfTHacker/obsidian42-brat)** — add
`specialseeds/pdf-ink` as a beta plugin and BRAT will keep it updated.

**By hand** — download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/specialseeds/pdf-ink/releases/latest) into
`<vault>/.obsidian/plugins/pdf-ink/`, then enable **PDF ink** in
**Settings → Community plugins**.

Requires Obsidian 1.7.2 or later.

## Getting started

1. Open a PDF.
2. Run **PDF ink: Annotate current PDF** from the command palette, or right-click the
   PDF in the file explorer and choose **Annotate with ink**.

The current tab becomes the ink view. `Cmd`/`Ctrl`-click the menu item to open it in a
new tab instead; the back button returns the tab to the built-in viewer.

## Moving around

The bar along the top carries the same controls as Obsidian's own PDF viewer, in the
same order — page navigation, a page number you can type into, zoom, and fit width or
fit page. The ink tools live in a separate floating palette so the two never compete
for room on a tablet.

The leftmost button opens a panel with **page thumbnails** and the PDF's **outline**.
Thumbnails include pages you have added, drawn with their ruling, so the panel shows
the document as it will export rather than the source file. Outline entries jump to
the right page even when you have inserted pages above it.

## Tools

| Tool | What it does |
|---|---|
| **Pen** | Pressure-sensitive freehand ink. |
| **Highlighter** | Flat, translucent ink that multiplies with the page, so text reads through it. |
| **Shapes** | Line, arrow, rectangle, ellipse, equilateral triangle, 2D and 3D axes. |
| **Text** | A resizable text box with wrapping. |
| **Eraser** | Whole-stroke, or a sized rubber that cuts strokes into fragments. |
| **Select** | Lasso or click, then move, scale, rotate, recolour, duplicate or reorder. |

Colours sit on the toolbar: four to hand, twelve more behind the chevron, and a native
colour picker for anything else. A colour applies to the active tool, and each tool
remembers its own. With something selected, picking a colour recolours the selection
in one undoable step.

### Drawing

A stylus reports real pressure; a mouse or trackpad draws at a constant width.

**Palm rejection** is on by default: once a stylus has been seen, touches scroll the
document instead of drawing, so a hand resting on the page does no harm. Whether a
stylus has been used is remembered, so rejection is armed from the first touch in a new
tab rather than only after the pen lands. Turn it off in settings if you have no stylus
and want every touch to draw.

On iPad, the Apple Pencil draws and never scrolls, while fingers scroll and never
draw. A hand resting on the page no longer interrupts a stroke.

### Switching tools without putting the pen down

**Tap two fingers** anywhere on the document to switch to the eraser, and tap again
to go back to whatever you were using. A tap means both fingers down and up without
dragging; a pinch or a pan is unaffected, and taps are ignored while the pen is on
the page.

The same thing is available as the **Toggle eraser** command, along with **Toggle
selection tool**, if you would rather bind a key.

> **Why not the Apple Pencil's own gestures?** Double-tap and squeeze are delivered
> to native code through `UIPencilInteraction`, and the web view Obsidian renders in
> does not pass them to plugins — there is no browser event for either, so no plugin
> can see them. The two-finger tap is the closest thing the platform allows.

### Shapes

Drag to create. Hold **Shift** to constrain — line and arrow snap to 15°, rectangles
become squares, ellipses become circles. The equilateral triangle always locks its
height to `√3/2 × side`.

3D axes are right-handed, drawn the way physics and engineering diagrams are: **y** to
the right, **z** up, and **x** out of the page toward you — down-left on paper, solid
and arrow-tipped, with the into-page half dashed.

### Text

Tap for a default-width box, or drag to size one. Editing uses a real textarea overlaid
on the box, so the caret, selection, IME and the mobile keyboard all behave normally.
Commit with **Escape** or by clicking away, and double-tap a box with the text or select
tool to edit it again.

Scaling a box vertically changes the font size; scaling it horizontally only changes
where the text wraps.

### Erasing

**Whole stroke** removes an entire mark. **Sized** behaves like a rubber: it takes away
only what the circle touches, splitting a stroke into fragments and leaving blunt ends
where it cut. The radius is set in screen pixels, so it feels the same at any zoom, and
a whole drag is one undo step.

An Apple Pencil's eraser end — or a tablet pen's eraser tip — switches to the eraser for
as long as it is held, using whichever mode is selected.

### Selecting

Click an object, or lasso a group. A stroke is selected when at least 60% of it falls
inside the loop; shapes and text when their centre does. The selection box has corner
handles for scaling, a rotation handle, and a bar for delete, duplicate, bring forward
and send back. Drag inside the box to move it.

## Adding pages

Hover between two pages and a **+** appears in the gap. Click it to slip a new sheet in
there. Right-click any page for **Insert page above** and **Insert page below**, which
is also how to do it on a tablet.

A new page takes the size of the page above it, and its ruling too when that page is one
you added — so extending a PDF into a notebook is one click per sheet. Right-click a page
you added to re-rule it or delete it.

| Ruling | |
|---|---|
| **Blank** | Nothing. |
| **Lined** | Horizontal rules at 8 mm, 7.5 mm or 10 mm. |
| **Grid** | 5 mm squares. |
| **Dot grid** | 5 mm dots. |

Deleting a page takes its annotations with it, and a single undo brings back both.

Pages of the source PDF cannot be deleted, reordered or re-ruled — the original file is
never touched. Pages you add live entirely in the sidecar until you export.

## Keyboard

| Shortcut | Action |
|---|---|
| `Mod+Z` | Undo |
| `Mod+Shift+Z` | Redo |
| `Mod+Shift+E` | Toggle eraser mode (whole-stroke or sized) |
| `Escape` | Deselect, or commit an open text box |

These are scoped to the ink view, so they never shadow Obsidian's own shortcuts
elsewhere. Every action also has a command, so you can rebind it — including
**Toggle eraser** and **Toggle selection tool**, which switch to a tool and back to
whatever you were using.

Zoom with `Ctrl`/`Cmd` and the scroll wheel, a two-finger pinch, or the toolbar.

## Exporting

Run **PDF ink: Export annotated PDF**. The result is written beside the original with a
configurable suffix, and you are asked before an earlier export is replaced. The source
PDF is only ever read.

Two modes, in settings:

- **Flatten into the page** — annotations become page content. Identical in every
  viewer, and not editable afterwards.
- **Keep strokes editable** — strokes are written as real PDF `/Ink` annotations, so
  they stay selectable and editable in Acrobat and Preview. Each carries an appearance
  stream, so it still renders in viewers that do not synthesise one. Shapes and text are
  flattened in both modes.

Pages you added are spliced into the exported file exactly where they sit on screen,
ruling and all. Every original page keeps its own size and its place relative to the
others.

Text is exported with a bundled subset of **Noto Sans**, measured with the embedded font
so the line breaks match what you saw. Greek letters, `µ` and `±` survive intact.

## Where annotations live

Beside the PDF, as `<name>.pdf.ink.json`:

```json
{
  "version": 4,
  "pages": { "pdf:0": [ { "type": "stroke", "...": "..." } ] },
  "insertedPages": []
}
```

- Coordinates are in **PDF user space**, not pixels, so they are independent of zoom,
  device pixel ratio and page rotation.
- Annotations are filed under a page's **identity** — `pdf:0` for the first page of the
  document, `ins:<uuid>` for a page you added — never its position, so inserting a page
  cannot move anyone else's ink. Older sidecars are upgraded on load.
- A page you added is a record in `insertedPages` holding its position, size and ruling.
  Its position is "after this original page" plus a fractional sort key rather than a
  number, so two devices adding a page at the same spot both keep theirs.
- The sidecar follows the PDF when it is renamed or moved, and goes to the trash with it
  when it is deleted.
- Saves are debounced and flushed when the view closes, so nothing is lost on a tab
  switch.
- Writes go through a temp file and a rename, keeping one `.bak`. If a save is
  interrupted, the next load recovers from the `.tmp`, or from the `.bak` if the temp
  file is incomplete.

### Syncing

Two devices editing the same PDF are merged item by item and page by page: the newer
edit wins, and deletions are tombstones so a stale copy cannot resurrect them.
Sync conflict files are merged in and moved to the trash. Tombstones are dropped after
90 days.

A sidecar written by a newer version of the plugin is never overwritten — the view says
it cannot read it and refuses to save over it.

## Settings

- Default **zoom**, and how many pages to keep rendered either side of the view.
- **Palm rejection** on or off.
- Default **colour** and **width** per tool, and the default text size.
- Default eraser **mode**, whole-stroke reach and sized radius.
- Export **mode** and filename **suffix**.
- **Input diagnostics**, for reporting a problem with a pen or tablet.

### Input diagnostics

Turning this on overlays a live log of what the touchscreen and stylus are actually
reporting — pointer types, pressure, how many fingers landed, and why a tap was or
was not recognised — with a **Copy** button.

Input behaviour differs between devices in ways that cannot be reproduced at a desk,
so if a pen or a gesture misbehaves, switching this on, reproducing it and pasting
the log into an issue is by far the most useful thing you can send.

## Limitations

- The ink view is opened explicitly; it is not the default PDF handler.
- There is no text search yet, and no text selection or copying: the viewer draws
  pages rather than laying out a selectable text layer over them.
- Undo history does not survive switching tabs, because Obsidian unloads backgrounded
  views. Your annotations do survive — only the ability to undo them is lost.
- Sized-erasing a shape converts it to pen strokes. Dash patterns and fills do not
  survive that conversion.
- Pages of the source PDF cannot be deleted, reordered or rotated.
- `main.js` is around 1.5 MB, because `pdf-lib` and `@pdf-lib/fontkit` are bundled for
  export.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run lint
npm run build   # typecheck + production bundle
```

Pure geometry, serialisation, merging and layout live in `src/core/` and are unit
tested. `src/ui/` holds the view and its overlays, `src/pdf/` the pdf.js and pdf-lib
layers, and `src/commands/` the palette entries.

To develop against a vault, symlink the repo into it:

```bash
ln -s /path/to/pdf-ink /path/to/vault/.obsidian/plugins/pdf-ink
```

Then enable **PDF ink** in **Settings → Community plugins**. With the
[Hot Reload](https://github.com/pjeby/hot-reload) plugin installed, `npm run dev`
reloads it on every build.

Releases are cut by pushing a tag matching `manifest.json`'s version, with no leading
`v`. The workflow builds the plugin and attaches `main.js`, `manifest.json` and
`styles.css` to the release.

## Licence

Code: [0-BSD](LICENSE). The bundled Noto Sans subset is used under the SIL Open Font
License — see [src/assets/NotoSans-LICENSE.txt](src/assets/NotoSans-LICENSE.txt).
