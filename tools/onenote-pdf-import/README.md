# OneNote PDF importer

Turns OneNote PDF exports into pdf-ink notebooks, one `.inknote` per PDF, named
after the file. Runs offline on a desktop with Node; it is not part of the plugin.

```sh
npm run import-onenote -- <input folder> [output folder] [--dry-run] [--only <text>] [--simplify <pt>]
```

- `--dry-run` lists each note, its export format, canvas size, path and text
  counts, and whether it becomes a board or Letter pages. Nothing is written.
- `--only <text>` imports only notes whose name contains the text.
- `--simplify <pt>` sets the simplification tolerance (default 0.1 pt; 0 keeps
  every exported point).
- Notes already written are skipped, so a rerun picks up where the last stopped.

## Formats

- **iOS export**: one page holding the whole canvas. Used as is.
- **Mac export**: several Letter pages, each holding nearly all of the note's ink,
  shifted so its own slice shows through a clip window. The importer finds each
  page's shift from the ink it shares with the pages before, drops the copies,
  and undoes the export's scale-to-fit.

A canvas wider than tall, or wider than 1.5 Letter widths, becomes a board: one
page at the canvas's size. Anything else is split into Letter pages.

Ink becomes `path` items in its exact exported colours. Typed text becomes text
boxes where it was, except the page title: when the note opens with its own name
(the file name) and a date line, those become the notebook's title header
instead, dated from that line. Notebooks imported before this can be converted
with the plugin's "Convert imported titles to headers" command.

Everything imported goes into `<name>.inknote.gz`, a gzipped base layer written
once and never again. The `.inknote` beside it names the base by its SHA-256 and
holds only what you change afterwards, so the file the plugin saves on every
stroke stays small.

## Known Mac export losses

Compared against an iOS export of the same note, the Mac export:

- omits some strokes outright (4 of 2,273 in the test note, near the bottom);
- retraces some strokes with about 30% fewer outline points (13 in the test
  note). Their outlines lie 0.41 to 0.70 pt from the iPad ones.

The importer warns whenever it reads a Mac export.

## Fixtures

The tests look for fixtures in `fixtures/`. They are personal notes, so they are
git-ignored (`*.pdf`). Tests that need one are skipped when it is absent.
