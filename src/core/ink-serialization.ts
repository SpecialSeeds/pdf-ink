/**
 * Reading and writing the `<file>.ink.json` sidecar. Pure — no vault, no DOM.
 *
 * Older sidecars are migrated on load: v1 held strokes only, v2 and v3 filed items
 * under a numeric page index. A version newer than this build understands is
 * refused rather than rewritten, and individual malformed items are dropped so one
 * bad record cannot cost the user a whole page.
 *
 * Page records are more forgiving than items: a page whose template or size cannot
 * be read is repaired with a default rather than dropped, because dropping it would
 * also orphan every annotation on it. Only a missing id — the merge key — is fatal.
 */

import { DEFAULT_PRESSURE } from './coords';
import { FIRST_KEY, isValidKey } from './fracindex';
import {
	BEFORE_FIRST_PAGE,
	FALLBACK_PAGE_SIZE,
	type InsertedPage,
	type PageKey,
	type PageSize,
	parsePageKey,
	pdfPageKey,
} from './pages';
import { type PageTemplate, isPageTemplate } from './templates';
import {
	type Box,
	INK_DATA_VERSION,
	type InkData,
	type Item,
	OLDEST_SUPPORTED_VERSION,
	type ShapeItem,
	type Stroke,
	type StrokeSample,
	type TextItem,
	isShapeKind,
} from './items';

export const SIDECAR_SUFFIX = '.ink.json';

/** Written while a save is in flight, then renamed into place. */
export const TEMP_SUFFIX = '.tmp';

/** The previous good version, kept after every successful save. */
export const BACKUP_SUFFIX = '.bak';

/**
 * FNV-1a over the serialised sidecar.
 *
 * Used to recognise our own writes: the vault reports a modify event for them too,
 * and mtime alone is not enough to tell them apart from a sync client's write that
 * landed in the same millisecond.
 */
export function hashContent(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		// 16777619, via shifts to stay in 32 bits.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * `notes/paper.pdf` becomes `notes/paper.pdf.ink.json` — beside the PDF, keeping
 * the full filename so `a.pdf` and `a.png` cannot collide on one sidecar.
 */
export function sidecarPathFor(pdfPath: string): string {
	return `${pdfPath}${SIDECAR_SUFFIX}`;
}

export function isSidecarPath(path: string): boolean {
	return path.endsWith(SIDECAR_SUFFIX);
}

/**
 * Whether `candidate` is a sync service's conflicting copy of `sidecar`.
 *
 * Every syncer names these differently — Obsidian Sync appends
 * " (conflict 2024-01-01 12.00.00)", others just " (conflict)", and some insert it
 * before the extension while others append a second one. Rather than encode each
 * format, this accepts any sibling JSON whose name starts with the sidecar's own
 * stem and mentions a conflict.
 */
export function isConflictCopy(sidecarPath: string, candidate: string): boolean {
	if (candidate === sidecarPath) return false;
	if (!candidate.endsWith('.json')) return false;

	const folder = (path: string): string => {
		const slash = path.lastIndexOf('/');
		return slash < 0 ? '' : path.slice(0, slash);
	};
	if (folder(candidate) !== folder(sidecarPath)) return false;

	// The stem is the sidecar path without its trailing ".json".
	const stem = sidecarPath.slice(0, -'.json'.length);
	if (!candidate.startsWith(stem)) return false;

	return /conflict/i.test(candidate.slice(stem.length));
}

/**
 * Whether `candidate` is a stray copy of `sidecar`, its backup or its temp file,
 * left by a sync client.
 *
 * iCloud Drive names a conflicting copy by adding " 2", " 3" … before the last
 * extension, and never says "conflict" at all: `a.pdf.ink.json` becomes
 * `a.pdf.ink 2.json`, and its backup `a.pdf.ink.json 3.bak`. A doubled
 * `.json.json` turns up beside those too. None of these is ever written by the
 * plugin itself; the live sidecar, `.bak` and `.tmp` never match.
 *
 * Only the part after the PDF's own name is examined, so a PDF that is itself
 * called "Homework 3.pdf" is not mistaken for a copy.
 */
export function isSyncLeftover(sidecarPath: string, candidate: string): boolean {
	const pdfPath = sidecarPath.slice(0, -SIDECAR_SUFFIX.length);
	if (!candidate.startsWith(pdfPath)) return false;
	if (
		candidate === sidecarPath ||
		candidate === `${sidecarPath}${BACKUP_SUFFIX}` ||
		candidate === `${sidecarPath}${TEMP_SUFFIX}`
	) {
		return false;
	}
	const rest = candidate.slice(pdfPath.length);
	// Anything under a subfolder is not a sibling.
	if (rest.includes('/')) return false;
	const numbered = / \d+(?=\.|$)/.test(rest);
	const plain = rest.replace(/ \d+(?=\.|$)/g, '');
	const kinds = [
		SIDECAR_SUFFIX,
		`${SIDECAR_SUFFIX}${BACKUP_SUFFIX}`,
		`${SIDECAR_SUFFIX}${TEMP_SUFFIX}`,
		`${SIDECAR_SUFFIX}.json`,
	];
	if (!kinds.includes(plain)) return false;
	return numbered || plain === `${SIDECAR_SUFFIX}.json`;
}

/** Whether a sidecar's text was written in the old indented format. */
export function isIndented(raw: string): boolean {
	return raw.includes('\n\t');
}

export type ParseFailure =
	| 'invalid-json'
	| 'not-an-object'
	| 'unsupported-version';

export type ParseResult =
	| {
			readonly ok: true;
			readonly data: InkData;
			/** Items skipped because they did not validate. */
			readonly dropped: number;
			/** The version read from the file, before migration. */
			readonly sourceVersion: number;
			/** True when the file was older and had to be upgraded. */
			readonly migrated: boolean;
		}
	| {
			readonly ok: false;
			readonly reason: ParseFailure;
			readonly version?: number;
		};

/**
 * The sidecar as written to disk: compact, with stroke points rounded.
 *
 * Indented JSON put every coordinate of every sample on its own line at full
 * double precision, so a few pages of handwriting ran to ten megabytes — slow to
 * hash and write on every save, and slow enough to sync that a cloud drive kept
 * producing conflict copies of it. A hundredth of a point is about 0.004 mm,
 * far below anything a pen or a screen can show.
 */
export function serializeInkData(data: InkData): string {
	return `${JSON.stringify(data, roundPoints)}\n`;
}

/** Decimal places kept for stroke samples. */
const POINT_DECIMALS = 2;
const POINT_FACTOR = 10 ** POINT_DECIMALS;

function roundPoints(key: string, value: unknown): unknown {
	if (key !== 'points' || !Array.isArray(value)) return value;
	return value.map((sample: unknown) =>
		Array.isArray(sample)
			? sample.map((n: unknown) =>
					typeof n === 'number' ? Math.round(n * POINT_FACTOR) / POINT_FACTOR : n,
				)
			: sample,
	);
}

export function parseInkData(raw: string): ParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: 'invalid-json' };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, reason: 'not-an-object' };
	}

	const root = parsed as Record<string, unknown>;
	const version = root['version'];
	if (typeof version !== 'number' || !Number.isFinite(version)) {
		return { ok: false, reason: 'unsupported-version' };
	}
	// A newer file belongs to a newer plugin. The caller blocks writes on this
	// rather than destroying data it cannot represent.
	if (version > INK_DATA_VERSION || version < OLDEST_SUPPORTED_VERSION) {
		return { ok: false, reason: 'unsupported-version', version };
	}

	/*
	 * Items in a pre-v3 file have no timestamp. They are stamped with 0 rather than
	 * "now": a migrated item must lose to any genuine edit from another device,
	 * because we have no idea when it was actually made.
	 */
	const migratedStamp = 0;

	const pages: Record<PageKey, Item[]> = {};
	let dropped = 0;

	const rawPages = root['pages'];
	if (rawPages !== null && typeof rawPages === 'object' && !Array.isArray(rawPages)) {
		for (const [rawKey, value] of Object.entries(rawPages)) {
			const key = migratePageKey(rawKey);
			if (key === null) {
				dropped += Array.isArray(value) ? value.length : 1;
				continue;
			}
			if (!Array.isArray(value)) {
				dropped += 1;
				continue;
			}
			const items: Item[] = [];
			value.forEach((candidate, position) => {
				const item =
					version === 1
						? migrateV1Stroke(candidate, position, migratedStamp)
						: parseItem(candidate, position, migratedStamp);
				if (item) items.push(item);
				else dropped += 1;
			});
			// Two keys can migrate onto one page key only if the file was malformed;
			// merging rather than overwriting keeps both pages' work.
			if (items.length > 0) pages[key] = [...(pages[key] ?? []), ...items];
		}
	}

	const insertedPages: InsertedPage[] = [];
	const rawInserted = root['insertedPages'];
	if (Array.isArray(rawInserted)) {
		for (const candidate of rawInserted) {
			const page = parseInsertedPage(candidate, migratedStamp);
			if (page) insertedPages.push(page);
			else dropped += 1;
		}
	}

	return {
		ok: true,
		data: { version: INK_DATA_VERSION, pages, insertedPages },
		dropped,
		sourceVersion: version,
		migrated: version !== INK_DATA_VERSION,
	};
}

/**
 * A page key as written by any schema version this build reads.
 *
 * Versions 1 to 3 used the page index as the key, so `"4"` becomes `"pdf:4"`. A
 * numeric key is accepted from a v4 file too: it can only be there by mistake, and
 * reading it as an original page is right far more often than dropping the page.
 */
function migratePageKey(key: string): PageKey | null {
	if (parsePageKey(key)) return key;
	// Strict, because Number('') is 0 and Number('1e1') is 10 — either would file
	// items onto a page they do not belong to.
	if (!/^\d+$/.test(key)) return null;
	return pdfPageKey(Number(key));
}

function parseInsertedPage(value: unknown, stamp: number): InsertedPage | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const id = raw['id'];
	// The id is the merge key, so a record without one cannot be reconciled and is
	// the only case worth dropping.
	if (typeof id !== 'string' || id.length === 0) return null;

	const rawAfter = raw['afterPdfPage'];
	const afterPdfPage = isFiniteNumber(rawAfter)
		? Math.max(BEFORE_FIRST_PAGE, Math.trunc(rawAfter))
		: BEFORE_FIRST_PAGE;

	// An unusable sort key has to be replaced, not kept: keyBetween validates its
	// bounds, so a bad key left in place would break the next insertion near it.
	const rawSortKey = raw['sortKey'];
	const sortKey =
		typeof rawSortKey === 'string' && isValidKey(rawSortKey)
			? rawSortKey
			: FIRST_KEY;

	const template: PageTemplate = isPageTemplate(raw['template'])
		? raw['template']
		: 'blank';

	const updatedAt = isFiniteNumber(raw['updatedAt']) ? raw['updatedAt'] : stamp;
	const rawDeleted = raw['deletedAt'];
	const deletedAt =
		isFiniteNumber(rawDeleted) && rawDeleted > 0 ? rawDeleted : undefined;

	const page: InsertedPage = {
		id,
		afterPdfPage,
		sortKey,
		template,
		size: parsePageSize(raw['size']),
		updatedAt,
	};
	return deletedAt === undefined ? page : { ...page, deletedAt };
}

function parsePageSize(value: unknown): PageSize {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return FALLBACK_PAGE_SIZE;
	}
	const raw = value as Record<string, unknown>;
	const width = raw['width'];
	const height = raw['height'];
	if (!isFiniteNumber(width) || width <= 0) return FALLBACK_PAGE_SIZE;
	if (!isFiniteNumber(height) || height <= 0) return FALLBACK_PAGE_SIZE;
	return { width, height };
}

/**
 * A version 1 stroke becomes a version 2 item of type `"stroke"`.
 *
 * v1 had no `type`, `rotation` or `z`. Paint order was the array order, so that
 * position becomes the z value, which preserves exactly how the page looked.
 */
function migrateV1Stroke(
	value: unknown,
	position: number,
	stamp: number,
): Stroke | null {
	const base = readStrokeFields(value);
	if (!base) return null;
	return { ...base, rotation: 0, z: position, updatedAt: stamp };
}

function parseItem(
	value: unknown,
	position: number,
	stamp: number,
): Item | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const id = raw['id'];
	const color = raw['color'];
	const opacity = raw['opacity'];
	if (typeof id !== 'string' || id.length === 0) return null;
	if (typeof color !== 'string' || color.length === 0) return null;
	if (!isFiniteNumber(opacity) || opacity <= 0 || opacity > 1) return null;

	const rotation = isFiniteNumber(raw['rotation']) ? raw['rotation'] : 0;
	// A missing z falls back to array order, which is what v1 meant by it.
	const z = isFiniteNumber(raw['z']) ? raw['z'] : position;
	const updatedAt = isFiniteNumber(raw['updatedAt']) ? raw['updatedAt'] : stamp;
	const rawDeleted = raw['deletedAt'];
	const deletedAt =
		isFiniteNumber(rawDeleted) && rawDeleted > 0 ? rawDeleted : undefined;
	const timestamps =
		deletedAt === undefined ? { updatedAt } : { updatedAt, deletedAt };

	switch (raw['type']) {
		case 'stroke': {
			const fields = readStrokeFields(value);
			return fields ? { ...fields, rotation, z, ...timestamps } : null;
		}
		case 'shape':
			return parseShape(raw, { id, color, opacity, rotation, z, ...timestamps });
		case 'text':
			return parseText(raw, { id, color, opacity, rotation, z, ...timestamps });
		default:
			return null;
	}
}

/** The fields a stroke has in both v1 and v2, without the v2-only base fields. */
function readStrokeFields(
	value: unknown,
): Omit<Stroke, 'rotation' | 'z' | 'updatedAt' | 'deletedAt'> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const id = raw['id'];
	const tool = raw['tool'];
	const color = raw['color'];
	const width = raw['width'];
	const opacity = raw['opacity'];
	const points = raw['points'];

	if (typeof id !== 'string' || id.length === 0) return null;
	if (tool !== 'pen' && tool !== 'highlighter') return null;
	if (typeof color !== 'string' || color.length === 0) return null;
	if (!isFiniteNumber(width) || width <= 0) return null;
	if (!isFiniteNumber(opacity) || opacity <= 0 || opacity > 1) return null;
	if (!Array.isArray(points)) return null;

	const samples: StrokeSample[] = [];
	for (const candidate of points) {
		const sample = parseSample(candidate);
		if (sample) samples.push(sample);
	}
	// A stroke with no usable geometry is not worth keeping.
	if (samples.length === 0) return null;

	const cutStart = raw['cutStart'] === true;
	const cutEnd = raw['cutEnd'] === true;
	return {
		type: 'stroke',
		id,
		tool,
		color,
		width,
		opacity,
		points: samples,
		cutStart,
		cutEnd,
	};
}

type BaseFields = Pick<
	Item,
	'id' | 'color' | 'opacity' | 'rotation' | 'z' | 'updatedAt' | 'deletedAt'
>;

/**
 * The quarter-origin 3D axes were removed. A sidecar that still names one is
 * migrated to the centred variant rather than having the shape dropped.
 */
function migrateShapeKind(kind: unknown): unknown {
	return kind === 'axes3d_q' ? 'axes3d_c' : kind;
}

function parseShape(
	raw: Record<string, unknown>,
	base: BaseFields,
): ShapeItem | null {
	const kind = migrateShapeKind(raw['kind']);
	const width = raw['width'];
	const fill = raw['fill'];
	const box = parseBox(raw['box']);
	if (!isShapeKind(kind)) return null;
	if (!isFiniteNumber(width) || width <= 0) return null;
	if (!box) return null;
	if (fill !== null && (typeof fill !== 'string' || fill.length === 0)) {
		return null;
	}
	return { ...base, type: 'shape', kind, box, width, fill };
}

function parseText(
	raw: Record<string, unknown>,
	base: BaseFields,
): TextItem | null {
	const text = raw['text'];
	const fontSize = raw['fontSize'];
	const box = parseBox(raw['box']);
	if (typeof text !== 'string') return null;
	if (!isFiniteNumber(fontSize) || fontSize <= 0) return null;
	if (!box) return null;
	return { ...base, type: 'text', box, text, fontSize };
}

function parseBox(value: unknown): Box | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const x = raw['x'];
	const y = raw['y'];
	const w = raw['w'];
	const h = raw['h'];
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
	if (!isFiniteNumber(w) || !isFiniteNumber(h)) return null;
	return { x, y, w, h };
}

function parseSample(value: unknown): StrokeSample | null {
	if (!Array.isArray(value) || value.length < 2) return null;
	const x: unknown = value[0];
	const y: unknown = value[1];
	const pressure: unknown = value[2];
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
	// Pressure is optional in the schema, and a zero would render invisibly.
	const usable =
		isFiniteNumber(pressure) && pressure > 0
			? Math.min(1, pressure)
			: DEFAULT_PRESSURE;
	return [x, y, usable];
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}
