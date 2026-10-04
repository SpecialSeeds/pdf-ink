/**
 * The base layer: a notebook's imported ink, kept out of the file it saves.
 *
 * An imported note is thousands of paths that never change. Writing them into
 * the `.inknote` would rewrite megabytes on every stroke and hand a sync client
 * megabytes to conflict over. Instead they live in a sibling file, gzipped,
 * written once at import and never again, and the `.inknote` names it by the
 * SHA-256 of its bytes. The `.inknote` then holds only what the user did.
 *
 * Layering is by id. A record in the `.inknote` with a base item's id replaces
 * it: an edited copy (copy on write), or a tombstone. Base items never change,
 * so nothing else is needed, and the `.inknote`'s merge rules apply unchanged.
 *
 * Pure apart from the Web platform's CompressionStream and SubtleCrypto, which
 * Obsidian has on desktop and mobile, and Node has too.
 */

import { isPackedPath, packPath, unpackPath } from './base-encoding';
import { parseInkData } from './ink-serialization';
import { INK_DATA_VERSION, type Item, isLive } from './items';
import type { PageKey } from './pages';

/**
 * A base file's suffix. Not `.base`: Obsidian claims that extension for its own
 * Bases, and would show every base layer as a broken one.
 */
export const BASE_SUFFIX = '.inknote.gz';

/** `notes/Week 2.inknote` keeps its base layer in `notes/Week 2.inknote.gz`. */
export function basePathFor(notebookPath: string): string {
	const stem = notebookPath.endsWith('.inknote') ? notebookPath.slice(0, -'.inknote'.length) : notebookPath;
	return `${stem}${BASE_SUFFIX}`;
}

/** What a `.inknote` records about its base layer. */
export interface BaseRef {
	/** Lowercase hex SHA-256 of the base file's bytes, exactly as stored. */
	readonly hash: string;
}

/**
 * Marks the file as ours, and its layout version. Version 2 packs paths (see
 * src/core/base-encoding.ts); version 1 kept their data as text, and still reads.
 */
export const BASE_FORMAT = 'pdf-ink-base';
export const BASE_FORMAT_VERSION = 2;

export type BasePages = Record<PageKey, Item[]>;

/** The base file's uncompressed text, with every path packed. */
export function encodeBase(pages: BasePages): string {
	const packed: Record<PageKey, unknown[]> = {};
	for (const [key, items] of Object.entries(pages)) {
		packed[key] = items.map((item) => (item.type === 'path' ? packPath(item) : item));
	}
	return JSON.stringify({ format: BASE_FORMAT, version: BASE_FORMAT_VERSION, pages: packed });
}

/** A base file's pages with paths unpacked to path data, ready to validate. */
function unpackPages(pages: unknown): unknown {
	if (pages === null || typeof pages !== 'object' || Array.isArray(pages)) return pages;
	const out: Record<string, unknown> = {};
	for (const [key, items] of Object.entries(pages as Record<string, unknown>)) {
		// A path whose letters and numbers disagree is dropped by validation.
		out[key] = Array.isArray(items)
			? (items as unknown[]).map((item: unknown): unknown =>
					isPackedPath(item) ? (unpackPath(item) ?? { type: 'path' }) : item,
				)
			: items;
	}
	return out;
}

/**
 * The pages in a base file's text, or null when it is not one. Items go through
 * the same validation as the `.inknote`'s, so a damaged record is dropped
 * rather than drawn wrong.
 */
export function decodeBase(text: string): BasePages | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object') return null;
	const root = parsed as Record<string, unknown>;
	if (root['format'] !== BASE_FORMAT) return null;
	const version = root['version'];
	if (typeof version !== 'number' || version > BASE_FORMAT_VERSION) return null;
	const result = parseInkData(
		JSON.stringify({ version: INK_DATA_VERSION, pages: unpackPages(root['pages']), insertedPages: [] }),
	);
	return result.ok ? result.data.pages : null;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

export async function gzip(text: string): Promise<Uint8Array> {
	const input = new Blob([new TextEncoder().encode(text)]).stream();
	return collect(input.pipeThrough(new CompressionStream('gzip')));
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
	const input = new Blob([bytes.slice()]).stream();
	const output = await collect(input.pipeThrough(new DecompressionStream('gzip')));
	return new TextDecoder().decode(output);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A base file's bytes and the reference a `.inknote` keeps to them. */
export async function packBase(pages: BasePages): Promise<{ bytes: Uint8Array; ref: BaseRef }> {
	const bytes = await gzip(encodeBase(pages));
	return { bytes, ref: { hash: await sha256Hex(bytes) } };
}

export type UnpackFailure = 'hash-mismatch' | 'unreadable';

/** A base file's pages, checked against the reference the `.inknote` holds. */
export async function unpackBase(
	bytes: Uint8Array,
	ref: BaseRef,
): Promise<{ ok: true; pages: BasePages } | { ok: false; reason: UnpackFailure }> {
	if ((await sha256Hex(bytes)) !== ref.hash) return { ok: false, reason: 'hash-mismatch' };
	try {
		const pages = decodeBase(await gunzip(bytes));
		return pages ? { ok: true, pages } : { ok: false, reason: 'unreadable' };
	} catch {
		return { ok: false, reason: 'unreadable' };
	}
}

/**
 * One page's items as drawn: base items the user has not replaced, then the
 * user's own records, tombstones included. A user record replaces the base item
 * with its id whatever their timestamps: the base never changes, so any record
 * for it is the user's later word.
 */
export function layerItems(base: readonly Item[] | undefined, user: readonly Item[]): Item[] {
	if (!base || base.length === 0) return [...user];
	const replaced = new Set(user.map((item) => item.id));
	return [...base.filter((item) => !replaced.has(item.id)), ...user];
}

/** Every page of both layers, combined. For export, which reads the files. */
export function layerPages(
	base: Readonly<BasePages> | undefined,
	user: Readonly<Record<PageKey, Item[]>>,
): Record<PageKey, Item[]> {
	const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(user)]);
	const pages: Record<PageKey, Item[]> = {};
	for (const key of keys) pages[key] = layerItems(base?.[key], user[key] ?? []);
	return pages;
}

/**
 * The `.inknote`'s records as written: a tombstone over a base path keeps only a
 * stub of its geometry. The base holds the real outline, and copying it into
 * the file would undo the point of having a base at all.
 */
export function compactBaseTombstones(
	pages: Readonly<Record<PageKey, Item[]>>,
	isBase: (id: string) => boolean,
): Record<PageKey, Item[]> {
	const out: Record<PageKey, Item[]> = {};
	for (const [key, items] of Object.entries(pages)) {
		out[key] = items.map((item) =>
			item.type === 'path' && !isLive(item) && isBase(item.id) ? { ...item, d: STUB_PATH } : item,
		);
	}
	return out;
}

/** The smallest path data that still parses, for a tombstone's geometry. */
export const STUB_PATH = 'M0 0';
