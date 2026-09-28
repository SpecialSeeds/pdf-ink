/** View type id. Takes over `.pdf` only through DefaultPdfViewer. */
export const VIEW_TYPE_PDF_INK = 'pdf-ink-view';

export const PDF_INK_ICON = 'pen-tool';

/**
 * 96 CSS px/in over 72 pt/in. Zoom 1.0 means "100%" — physical size at 96 dpi,
 * matching pdf.js's own viewer. A raw pdf.js scale of 1 would make a 30-inch
 * scanned page 2179 px wide, so zoom and scale are deliberately not the same.
 */
export const PDF_TO_CSS_UNITS = 96 / 72;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export const ZOOM_LADDER: readonly number[] = [
	0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4,
];

/** Pages kept on each side of the visible range. "Plus one buffer page". */
export const BUFFER_PAGES = 1;

/** Hard ceiling on live canvases, for a zoomed-out view of a long document. */
export const MAX_RETAINED_PAGES = 12;

/** Vertical gap between pages, in CSS px. Mirrored into --pdf-ink-page-gap. */
export const PAGE_GAP = 12;

/** Horizontal breathing room on each side of the widest page, in CSS px. */
export const FIT_WIDTH_GUTTER = 16;

/** Delay before dropping a page's decoded images after it scrolls away. */
export const PAGE_CLEANUP_DELAY_MS = 5000;

/** Debounce for re-rasterising after a resize or a zoom gesture settles. */
export const SETTLE_DELAY_MS = 140;

/** Quiet period after the last stroke before the sidecar is written. */
export const SAVE_DEBOUNCE_MS = 500;
