/**
 * Transcripts of handwriting: where they live, what they say, and how a line
 * in one leads back to the ink it was read from. Pure.
 *
 * A transcript is a hidden index, never a destination. It mirrors its source's
 * vault path under the transcript folder, names its source in frontmatter, and
 * tags every line with the block it came from ("[B3] …" under "## Page 2").
 */

import type { BlockBox } from './blocks';
import type { BasePages } from './base-layer';
import type { InkData } from './items';

export const DEFAULT_TRANSCRIPT_FOLDER = '_system/transcripts';
export const DEFAULT_RENDER_FOLDER = '.pdf-ink-render';
export const INSTRUCTIONS_FILE = 'TRANSCRIBE.md';
export const MANIFEST_FILE = 'manifest.json';

/** A folder setting cleaned up: no leading or trailing slashes, never empty. */
export function normalizeFolder(folder: string, fallback: string): string {
	const cleaned = folder.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
	return cleaned.length > 0 ? cleaned : fallback;
}

/** The kinds of file that have handwriting to transcribe. */
export function isTranscribable(path: string): boolean {
	return /\.(inknote|pdf)$/i.test(path);
}

/**
 * Where `source`'s transcript lives: its vault path mirrored under `folder`, as
 * Markdown. A notebook drops its extension; a PDF keeps it in the name, so a
 * PDF and a notebook called the same never share a transcript.
 *
 *   classes/Notes/1.3 Modeling.inknote -> _system/transcripts/classes/Notes/1.3 Modeling.md
 *   classes/Notes/Paper.pdf            -> _system/transcripts/classes/Notes/Paper.pdf.md
 */
export function transcriptPathFor(source: string, folder: string): string {
	const stem = /\.inknote$/i.test(source) ? source.replace(/\.inknote$/i, '') : source;
	return `${folder}/${stem}.md`;
}

/** Whether `path` is a transcript, rather than the instructions or anything else. */
export function isTranscriptPath(path: string, folder: string): boolean {
	return (
		path.startsWith(`${folder}/`) &&
		path.endsWith('.md') &&
		path !== `${folder}/${INSTRUCTIONS_FILE}`
	);
}

/** Where a source's page renders go: its vault path mirrored under the render folder. */
export function renderDirFor(source: string, renderFolder: string): string {
	return `${renderFolder}/${source}`;
}

export function renderPagePath(source: string, renderFolder: string, page: number): string {
	return `${renderDirFor(source, renderFolder)}/page-${String(page)}.png`;
}

/**
 * The newest edit anywhere in a document: items in both layers, tombstones
 * included, and page records. A transcript is current while its
 * `source_updated` equals this.
 */
export function latestUpdatedAt(data: InkData, base?: Readonly<BasePages>): number {
	let latest = 0;
	for (const items of Object.values(data.pages)) {
		for (const item of items) latest = Math.max(latest, item.updatedAt, item.deletedAt ?? 0);
	}
	for (const items of Object.values(base ?? {})) {
		for (const item of items) latest = Math.max(latest, item.updatedAt);
	}
	for (const page of data.insertedPages) latest = Math.max(latest, page.updatedAt, page.deletedAt ?? 0);
	return latest;
}

/**
 * Whether a source needs rendering again: when it has no render, or changed
 * after its render was made. `sourceMtimes` are the times its files (the PDF or
 * notebook, its sidecar, its base layer) were last written.
 */
export function isRenderStale(renderMtime: number | null, sourceMtimes: readonly number[]): boolean {
	if (renderMtime === null) return true;
	return sourceMtimes.some((mtime) => mtime > renderMtime);
}

/** Whether a transcript is up to date with its source. */
export function isTranscriptCurrent(sourceUpdated: unknown, latest: number): boolean {
	const value = typeof sourceUpdated === 'string' ? Number(sourceUpdated) : sourceUpdated;
	return typeof value === 'number' && Number.isFinite(value) && value === latest;
}

/**
 * Whether a source's renders can go: the setting is on and its transcript is
 * current, so nothing needs the images any more.
 */
export function shouldDeleteRenders(enabled: boolean, sourceUpdated: unknown, latest: number): boolean {
	return enabled && isTranscriptCurrent(sourceUpdated, latest);
}

/** One line of a transcript, as the index keeps it. */
export interface TranscriptLine {
	readonly page: number;
	/** `B3`, or null for a line not tagged with a block. */
	readonly block: string | null;
	/** The text after its block tag. */
	readonly text: string;
	/** 0-based line number in the file. */
	readonly line: number;
}

const PAGE_HEADING = /^##\s+Page\s+(\d+)\s*$/i;
const BLOCK_LINE = /^\[(B\d+)\]\s?(.*)$/;

/** Where the body starts: after a leading YAML frontmatter block, if any. */
function bodyStart(lines: readonly string[]): number {
	if (lines[0]?.trim() !== '---') return 0;
	for (let i = 1; i < lines.length; i++) if (lines[i]?.trim() === '---') return i + 1;
	return 0;
}

/** Every page-tagged line of a transcript, with its page and block. */
export function parseTranscript(text: string): TranscriptLine[] {
	const lines = text.split(/\r?\n/);
	const out: TranscriptLine[] = [];
	let page = 0;
	for (let i = bodyStart(lines); i < lines.length; i++) {
		const raw = lines[i] ?? '';
		const heading = PAGE_HEADING.exec(raw.trim());
		if (heading) {
			page = Number(heading[1]);
			continue;
		}
		if (page === 0 || raw.trim().length === 0) continue;
		const tagged = BLOCK_LINE.exec(raw.trim());
		out.push({
			page,
			block: tagged?.[1] ?? null,
			text: tagged ? (tagged[2] ?? '') : raw.trim(),
			line: i,
		});
	}
	return out;
}

/** Where a place in the handwriting is: a page, and perhaps a block on it. */
export interface InkTarget {
	/** 1-based page in display order. */
	readonly page: number;
	readonly block?: string;
}

/**
 * Where opening a transcript at `cursorLine` should land in its source: the
 * block of that line, or of the nearest tagged line on the same page; failing
 * that the page of the nearest "## Page N" heading above; failing that page 1.
 */
export function resolveRedirect(text: string, cursorLine: number): InkTarget {
	const lines = text.split(/\r?\n/);
	let page = 0;
	for (let i = Math.min(cursorLine, lines.length - 1); i >= 0; i--) {
		const heading = PAGE_HEADING.exec((lines[i] ?? '').trim());
		if (heading) {
			page = Number(heading[1]);
			break;
		}
	}
	if (page === 0) {
		// Above the first heading (in the frontmatter, say): the first page.
		const first = parseTranscript(text)[0];
		return first?.block ? { page: first.page, block: first.block } : { page: first?.page ?? 1 };
	}
	const onPage = parseTranscript(text).filter((l) => l.page === page && l.block !== null);
	let nearest: TranscriptLine | null = null;
	for (const line of onPage) {
		if (!nearest || Math.abs(line.line - cursorLine) < Math.abs(nearest.line - cursorLine)) nearest = line;
	}
	return nearest?.block ? { page, block: nearest.block } : { page };
}

/**
 * The target in a link's subpath: `#page=3`, `#page=3&block=B2`. Null when the
 * subpath says neither.
 */
export function parseInkSubpath(subpath: string): InkTarget | null {
	const params = new URLSearchParams(subpath.replace(/^#/, ''));
	const page = Number(params.get('page'));
	if (!Number.isInteger(page) || page < 1) return null;
	const block = params.get('block');
	return block && /^B\d+$/.test(block) ? { page, block } : { page };
}

/** The `blocks` frontmatter field: page -> block id -> [x, y, w, h]. */
export type BlocksField = Record<string, Record<string, BlockBox>>;

/** A box from the `blocks` field, or null when the page or block is not there or malformed. */
export function blockBoxFrom(field: unknown, page: number, block: string): BlockBox | null {
	if (field === null || typeof field !== 'object') return null;
	const onPage = (field as Record<string, unknown>)[String(page)];
	if (onPage === null || typeof onPage !== 'object') return null;
	const box = (onPage as Record<string, unknown>)[block];
	if (!Array.isArray(box) || box.length !== 4) return null;
	const nums = box.map(Number);
	return nums.every((n) => Number.isFinite(n)) ? (nums as unknown as BlockBox) : null;
}

/**
 * The instructions for Claudian, with the two folders as configured. The text
 * is otherwise exactly as given.
 */
export function transcriptionInstructions(renderFolder: string, transcriptFolder: string): string {
	return `Transcription instructions. Run when asked to "transcribe notes".
1. Read ${renderFolder}/${MANIFEST_FILE}.
2. For each source whose transcript is missing or whose transcript's
   source_updated differs from the manifest's updatedAt, read its page
   PNGs and write the transcript at the manifest's transcript path.
3. Format (machine index, not for human reading):
   - YAML frontmatter: source, source_updated, transcribed (today),
     topics (key terms).
   - "## Page N" per page. Every line starts with its block id in
     brackets, e.g. "[B3] Newton's law of cooling: $\\frac{dT}{dt} =
     -k(T - T_0)$". One or more lines per block, in block order.
   - Math in LaTeX; diagrams as one bracketed description with labels,
     e.g. "[B7] [diagram: tank with inflow F_in, C_in and outflow F_out]".
4. Transcribe only what is written; mark unreadable parts [illegible].
5. Never modify .inknote, .inknote.gz, .pdf, or .ink.json files.
6. When answering questions about my notes, search ${transcriptFolder} and
   cite as [[<source>#page=N&block=BX]] links.
`;
}
