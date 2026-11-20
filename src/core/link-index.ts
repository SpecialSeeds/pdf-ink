/**
 * The vault's link index, as text box links contribute to it. Pure: which file
 * a link belongs to, and what it adds to Obsidian's resolved and unresolved
 * links.
 *
 * Obsidian only reads links out of markdown, so a PDF or a notebook never has
 * an entry of its own. The plugin writes one for it, keyed by the PDF or the
 * notebook itself, never by a sidecar: the sidecar is storage, and the graph
 * should show the file the user sees.
 */

import { BASE_SUFFIX } from './base-layer';
import { NOTEBOOK_SUFFIX, SIDECAR_SUFFIX } from './ink-serialization';
import { isNotebookPath } from './new-notebook';

/** A link's counts per target, as `metadataCache.resolvedLinks` holds them. */
export type LinkCounts = Record<string, number>;

/**
 * The source a stored file speaks for: a sidecar's PDF, a base layer's
 * notebook, a notebook itself. Null for anything else, a sidecar's `.bak` and
 * `.tmp` included: those are not what the source holds.
 */
export function sourceOfStorage(path: string): string | null {
	if (path.endsWith(SIDECAR_SUFFIX)) {
		const source = path.slice(0, -SIDECAR_SUFFIX.length);
		return source.toLowerCase().endsWith('.pdf') ? source : null;
	}
	if (path.endsWith(BASE_SUFFIX)) return `${path.slice(0, -BASE_SUFFIX.length)}${NOTEBOOK_SUFFIX}`;
	if (isNotebookPath(path)) return path;
	return null;
}

/** What one source's links add: counts per resolved file path, and per missing link path. */
export interface SourceLinks {
	readonly resolved: LinkCounts;
	readonly unresolved: LinkCounts;
	/** The file each link path found, for following its target's renames. */
	readonly targets: Readonly<Record<string, string>>;
}

/**
 * Resolve a source's link paths, Obsidian's way: `resolve` is
 * `getFirstLinkpathDest` from the source. Repeats count, as they do in a note.
 */
export function resolveSourceLinks(
	linkpaths: readonly string[],
	resolve: (linkpath: string) => string | null,
): SourceLinks {
	const resolved: LinkCounts = {};
	const unresolved: LinkCounts = {};
	const targets: Record<string, string> = {};
	const seen = new Map<string, string | null>();
	for (const linkpath of linkpaths) {
		let target = seen.get(linkpath);
		if (target === undefined) {
			target = resolve(linkpath);
			seen.set(linkpath, target);
		}
		if (target === null) {
			unresolved[linkpath] = (unresolved[linkpath] ?? 0) + 1;
		} else {
			resolved[target] = (resolved[target] ?? 0) + 1;
			targets[linkpath] = target;
		}
	}
	return { resolved, unresolved, targets };
}

/** Whether two count tables say the same thing, whatever their key order. */
export function sameCounts(a: LinkCounts | undefined, b: LinkCounts | undefined): boolean {
	const left = a ?? {};
	const right = b ?? {};
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => left[key] === right[key]);
}

/** A source's links as last read, cached so an unchanged file is never re-read. */
export interface CachedLinks {
	/** The file the links were read from: the notebook, or the PDF's sidecar. */
	readonly store: string;
	readonly mtime: number;
	readonly size: number;
	/** Every link path, repeats kept, in no particular order. */
	readonly links: readonly string[];
	/**
	 * Set when a notebook names a base layer that could not be read, so its
	 * links were read from the user's layer alone. Read again next time.
	 */
	readonly baseMissing?: true;
}

export const LINK_CACHE_VERSION = 1;

export interface LinkCache {
	readonly version: number;
	readonly sources: Record<string, CachedLinks>;
}

/** Whether a cache entry still describes its store, by modification time and size. */
export function isCacheFresh(
	entry: CachedLinks | undefined,
	store: string,
	stat: { readonly mtime: number; readonly size: number },
): entry is CachedLinks {
	return (
		entry !== undefined &&
		entry.baseMissing !== true &&
		entry.store === store &&
		entry.mtime === stat.mtime &&
		entry.size === stat.size
	);
}

/** A cache read from disk, keeping only well-formed entries. Anything else is an empty cache. */
export function readLinkCache(raw: unknown): LinkCache {
	const empty: LinkCache = { version: LINK_CACHE_VERSION, sources: {} };
	if (raw === null || typeof raw !== 'object') return empty;
	const data = raw as Record<string, unknown>;
	if (data['version'] !== LINK_CACHE_VERSION) return empty;
	const stored = data['sources'];
	if (stored === null || typeof stored !== 'object') return empty;
	const sources: Record<string, CachedLinks> = {};
	for (const [source, value] of Object.entries(stored as Record<string, unknown>)) {
		if (value === null || typeof value !== 'object') continue;
		const e = value as Record<string, unknown>;
		const links = e['links'];
		if (
			typeof e['store'] !== 'string' ||
			typeof e['mtime'] !== 'number' ||
			typeof e['size'] !== 'number' ||
			!Array.isArray(links) ||
			!links.every((l) => typeof l === 'string')
		) {
			continue;
		}
		sources[source] = {
			store: e['store'],
			mtime: e['mtime'],
			size: e['size'],
			links,
			...(e['baseMissing'] === true ? { baseMissing: true as const } : {}),
		};
	}
	return { version: LINK_CACHE_VERSION, sources };
}

/** The new path of `path` when the folder `from` moved to `to`, or null when it is not inside. */
export function movedWithFolder(path: string, from: string, to: string): string | null {
	return path.startsWith(`${from}/`) ? `${to}/${path.slice(from.length + 1)}` : null;
}
