import { type App, type Plugin, type TAbstractFile, TFile, TFolder, debounce } from 'obsidian';
import { basePathFor, unpackBase } from '../core/base-layer';
import { parseInkData, sidecarPathFor } from '../core/ink-serialization';
import { documentLinkpaths, rewriteLinks } from '../core/ink-links';
import {
	type CachedLinks,
	LINK_CACHE_VERSION,
	type LinkCounts,
	type SourceLinks,
	isCacheFresh,
	movedWithFolder,
	readLinkCache,
	resolveSourceLinks,
	sameCounts,
	sourceOfStorage,
} from '../core/link-index';
import { isNotebookPath } from '../core/new-notebook';

/** Writes landing in a burst — a save is a temp file, a rename and a delete — settle into one update. */
const UPDATE_DEBOUNCE_MS = 400;
/** Obsidian rebuilding its links fires `resolved` in runs; put ours back once they stop. */
const RESTORE_DEBOUNCE_MS = 500;
/** The cache is written once indexing goes quiet, not on every change. */
const CACHE_WRITE_DEBOUNCE_MS = 5000;

/**
 * The parts of the metadata cache this writes to. `resolvedLinks` and
 * `unresolvedLinks` are in the API as read-only views; writing them is not, so
 * every access is guarded and a failure turns the feature off quietly.
 */
interface LinkTables {
	resolvedLinks: Record<string, LinkCounts>;
	unresolvedLinks: Record<string, LinkCounts>;
}

function linkTables(app: App): LinkTables | null {
	const cache = app.metadataCache as unknown as Partial<LinkTables>;
	const { resolvedLinks, unresolvedLinks } = cache;
	if (
		resolvedLinks === null ||
		typeof resolvedLinks !== 'object' ||
		unresolvedLinks === null ||
		typeof unresolvedLinks !== 'object'
	) {
		return null;
	}
	return cache as LinkTables;
}

/** Obsidian's "Automatically update internal links", a private vault setting. */
function alwaysUpdateLinks(app: App): boolean {
	try {
		const vault = app.vault as unknown as { getConfig?: (key: string) => unknown };
		return vault.getConfig?.('alwaysUpdateLinks') === true;
	} catch {
		return false;
	}
}

/** Rewrites a source's text boxes, through its open view if there is one. */
export type RewriteSource = (sourcePath: string, rewrite: (text: string) => string | null) => Promise<void>;

/**
 * Text box links in Obsidian's link index, so a PDF or notebook that links to
 * something shows a line to it in the graph.
 *
 * Every PDF with a sidecar and every notebook is read once, at layout ready,
 * and its links cached by the file's mtime and size, so a restart only reads
 * what changed. After that a file is read again when it is written, by this
 * plugin or by sync. The entries are put back whenever Obsidian rebuilds its
 * tables, and `resolved` is triggered once per batch, never once per file.
 */
export class InkLinkIndex {
	/** Link paths per source, as last read. Persisted. */
	private sources = new Map<string, CachedLinks>();
	/** What each source's links resolved to when last written into the tables. */
	private written = new Map<string, SourceLinks>();
	private readonly pending = new Set<string>();
	private running = false;
	private started = false;
	/** Set while this triggers `resolved`, so its own event is not taken for a rebuild. */
	private triggering = false;

	private readonly flushSoon = debounce(() => void this.flushPending(), UPDATE_DEBOUNCE_MS, true);
	private readonly restoreSoon = debounce(() => this.restore(), RESTORE_DEBOUNCE_MS, true);
	private readonly saveCacheSoon = debounce(() => void this.saveCache(), CACHE_WRITE_DEBOUNCE_MS, true);

	constructor(
		private readonly plugin: Plugin,
		private readonly enabled: () => boolean,
		private readonly rewriteSource: RewriteSource,
	) {}

	private get app(): App {
		return this.plugin.app;
	}

	private get cachePath(): string {
		return `${this.plugin.manifest.dir ?? '.'}/link-index.json`;
	}

	/** Register the vault and metadata events. Indexing starts at layout ready. */
	register(): void {
		const { app, plugin } = this;
		plugin.registerEvent(
			app.vault.on('create', (file) => {
				// A file a link was waiting for may just have arrived.
				if (this.started) this.restoreSoon();
				this.onWritten(file);
			}),
		);
		plugin.registerEvent(app.vault.on('modify', (file) => this.onWritten(file)));
		plugin.registerEvent(app.vault.on('delete', (file) => this.onDeleted(file)));
		plugin.registerEvent(app.vault.on('rename', (file, oldPath) => this.onRenamed(file, oldPath)));
		plugin.registerEvent(
			app.metadataCache.on('resolved', () => {
				if (!this.triggering && this.started && this.enabled()) this.restoreSoon();
			}),
		);
		app.workspace.onLayoutReady(() => {
			if (this.enabled()) void this.start();
		});
		plugin.register(() => {
			this.flushSoon.cancel();
			this.restoreSoon.cancel();
			this.saveCacheSoon.run();
			this.clear();
		});
	}

	/** The setting changed: index everything, or take every entry back out. */
	async setEnabled(on: boolean): Promise<void> {
		if (on) await this.start();
		else this.clear();
	}

	/** Read every source, from the cache where it is still current, and write the tables once. */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await this.loadCache();
		const sources = new Set<string>();
		for (const file of this.app.vault.getFiles()) {
			const source = sourceOfStorage(file.path);
			if (source !== null && !file.path.endsWith('.gz')) sources.add(source);
		}
		for (const cached of [...this.sources.keys()]) {
			if (!sources.has(cached)) this.sources.delete(cached);
		}
		for (const source of sources) {
			if (!this.started) return;
			await this.read(source);
		}
		if (!this.started) return;
		this.writeAll();
		this.saveCacheSoon();
	}

	/** Remove every entry this put in the tables, and stop indexing until started again. */
	clear(): void {
		this.started = false;
		this.pending.clear();
		this.flushSoon.cancel();
		this.restoreSoon.cancel();
		const tables = linkTables(this.app);
		if (tables && this.written.size > 0) {
			try {
				for (const source of this.written.keys()) {
					delete tables.resolvedLinks[source];
					delete tables.unresolvedLinks[source];
				}
				this.trigger();
			} catch (err) {
				console.error('pdf-ink: could not remove ink links from the link index', err);
			}
		}
		this.written.clear();
	}

	// --- events ---------------------------------------------------------

	private onWritten(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const source = sourceOfStorage(file.path);
		if (source !== null) this.schedule(source);
	}

	private onDeleted(file: TAbstractFile): void {
		// A link to it now resolves elsewhere, or nowhere.
		if (this.started) this.restoreSoon();
		if (file instanceof TFolder) {
			for (const source of [...this.sources.keys(), ...this.written.keys()]) {
				if (source.startsWith(`${file.path}/`)) this.schedule(source);
			}
			return;
		}
		const source = sourceOfStorage(file.path) ?? (this.isKnown(file.path) ? file.path : null);
		if (source !== null) this.schedule(source);
	}

	private onRenamed(file: TAbstractFile, oldPath: string): void {
		if (this.started) this.restoreSoon();
		if (file instanceof TFolder) {
			for (const source of [...new Set([...this.sources.keys(), ...this.written.keys()])]) {
				const moved = movedWithFolder(source, oldPath, file.path);
				if (moved === null) continue;
				this.schedule(source);
				this.schedule(moved);
			}
			return;
		}
		if (!(file instanceof TFile)) return;
		// A source renamed: its key moves. The sidecar follows the PDF on its own
		// (registerSidecarEvents), and that rename lands here too.
		for (const path of [oldPath, file.path]) {
			const source = sourceOfStorage(path) ?? (path.toLowerCase().endsWith('.pdf') ? path : null);
			if (source !== null) this.schedule(source);
		}
		if (this.enabled() && this.started) void this.followTargetRename(file, oldPath);
	}

	private isKnown(path: string): boolean {
		return this.sources.has(path) || this.written.has(path);
	}

	private schedule(source: string): void {
		if (!this.started || !this.enabled()) return;
		this.pending.add(source);
		this.flushSoon();
	}

	/** Read every source that changed, then write the tables once for all of them. */
	private async flushPending(): Promise<void> {
		if (this.running) {
			// The run in progress picks these up when it finishes.
			return;
		}
		this.running = true;
		try {
			while (this.pending.size > 0 && this.started) {
				const batch = [...this.pending];
				this.pending.clear();
				for (const source of batch) await this.read(source);
				this.writeSome(batch);
			}
			this.saveCacheSoon();
		} finally {
			this.running = false;
		}
	}

	// --- reading --------------------------------------------------------

	/** The file a source's links are stored in, if it exists along with the source. */
	private storeOf(source: string): TFile | null {
		const vault = this.app.vault;
		if (!vault.getFileByPath(source)) return null;
		if (isNotebookPath(source)) return vault.getFileByPath(source);
		if (!source.toLowerCase().endsWith('.pdf')) return null;
		return vault.getFileByPath(sidecarPathFor(source));
	}

	/** Bring one source's cached links up to date, reading its file only if it changed. */
	private async read(source: string): Promise<void> {
		const store = this.storeOf(source);
		if (!store) {
			this.sources.delete(source);
			return;
		}
		if (isCacheFresh(this.sources.get(source), store.path, store.stat)) return;
		try {
			const raw = await this.app.vault.cachedRead(store);
			if (raw.trim().length === 0) {
				this.sources.set(source, { store: store.path, mtime: store.stat.mtime, size: store.stat.size, links: [] });
				return;
			}
			const parsed = parseInkData(raw);
			// Unreadable, or from a newer version: leave whatever was known before.
			if (!parsed.ok) return;
			let base: Awaited<ReturnType<typeof unpackBase>> | null = null;
			const ref = parsed.data.base;
			if (isNotebookPath(source) && ref) {
				// Only the base beside the notebook: searching the vault for a
				// missing one is the viewer's job, and too slow to do for every
				// notebook at startup.
				const file = this.app.vault.getFileByPath(basePathFor(source));
				base = file ? await unpackBase(new Uint8Array(await this.app.vault.readBinary(file)), ref) : null;
			}
			const baseRead = base?.ok === true ? base.pages : undefined;
			this.sources.set(source, {
				store: store.path,
				mtime: store.stat.mtime,
				size: store.stat.size,
				links: documentLinkpaths(parsed.data.pages, baseRead),
				...(ref && !baseRead ? { baseMissing: true as const } : {}),
			});
		} catch (err) {
			console.error(`pdf-ink: could not read the links in ${store.path}`, err);
		}
	}

	// --- the tables -----------------------------------------------------

	private resolve(source: string): SourceLinks {
		const links = this.sources.get(source)?.links ?? [];
		return resolveSourceLinks(
			links,
			(linkpath) => this.app.metadataCache.getFirstLinkpathDest(linkpath, source)?.path ?? null,
		);
	}

	/**
	 * Write `sources`' entries, resolved afresh, into the tables. Returns whether
	 * anything there changed; triggers nothing.
	 */
	private apply(tables: LinkTables, sources: Iterable<string>): boolean {
		let changed = false;
		for (const source of sources) {
			const links = this.sources.has(source) ? this.resolve(source) : null;
			const has = links !== null && (Object.keys(links.resolved).length > 0 || Object.keys(links.unresolved).length > 0);
			if (!has) {
				// Only ever a key this wrote: Obsidian keeps none for a PDF or notebook.
				if (this.written.delete(source)) {
					delete tables.resolvedLinks[source];
					delete tables.unresolvedLinks[source];
					changed = true;
				}
				continue;
			}
			if (
				!sameCounts(tables.resolvedLinks[source], links.resolved) ||
				!sameCounts(tables.unresolvedLinks[source], links.unresolved)
			) {
				tables.resolvedLinks[source] = { ...links.resolved };
				tables.unresolvedLinks[source] = { ...links.unresolved };
				changed = true;
			}
			this.written.set(source, links);
		}
		return changed;
	}

	private writeSome(sources: readonly string[]): void {
		this.update(() => sources);
	}

	private writeAll(): void {
		this.update(() => new Set([...this.sources.keys(), ...this.written.keys()]));
	}

	/**
	 * Obsidian rebuilt its tables, or a file appeared that a link was waiting
	 * for: resolve every source again and put back what is missing or stale.
	 * Nothing is triggered when everything is already in place, which is what
	 * stops this answering its own event.
	 */
	private restore(): void {
		if (!this.started || !this.enabled()) return;
		this.writeAll();
	}

	private update(sources: () => Iterable<string>): void {
		if (!this.enabled()) return;
		const tables = linkTables(this.app);
		if (!tables) return;
		try {
			if (this.apply(tables, sources())) this.trigger();
		} catch (err) {
			console.error('pdf-ink: could not write ink links into the link index', err);
		}
	}

	private trigger(): void {
		this.triggering = true;
		try {
			this.app.metadataCache.trigger('resolved');
		} finally {
			this.triggering = false;
		}
	}

	// --- renames --------------------------------------------------------

	/**
	 * A file was renamed: rewrite every text box link that pointed at it, when
	 * Obsidian is set to update links automatically. Each source is written
	 * through its open view, or loaded, merged and saved the usual way.
	 */
	private async followTargetRename(file: TFile, oldPath: string): Promise<void> {
		if (!alwaysUpdateLinks(this.app)) return;
		const affected: [string, Set<string>][] = [];
		for (const [source, links] of this.written) {
			const linkpaths = new Set(
				Object.entries(links.targets)
					.filter(([, target]) => target === oldPath)
					.map(([linkpath]) => linkpath),
			);
			if (linkpaths.size > 0) affected.push([source, linkpaths]);
		}
		for (const [oldSource, linkpaths] of affected) {
			// The source may be the renamed file itself, or inside it.
			const source = oldSource === oldPath ? file.path : oldSource;
			if (!this.app.vault.getFileByPath(source)) continue;
			const next = this.app.metadataCache.fileToLinktext(file, source, true);
			try {
				await this.rewriteSource(source, (text) =>
					rewriteLinks(text, (link) => (linkpaths.has(link.linkpath) ? next : null)),
				);
			} catch (err) {
				console.error(`pdf-ink: could not update the links in ${source}`, err);
			}
		}
	}

	// --- the cache ------------------------------------------------------

	private async loadCache(): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.cachePath))) return;
			const cache = readLinkCache(JSON.parse(await adapter.read(this.cachePath)));
			this.sources = new Map(Object.entries(cache.sources));
		} catch (err) {
			console.warn('pdf-ink: ignoring an unreadable link cache', err);
		}
	}

	private async saveCache(): Promise<void> {
		try {
			const sources = Object.fromEntries(this.sources);
			await this.app.vault.adapter.write(this.cachePath, JSON.stringify({ version: LINK_CACHE_VERSION, sources }));
		} catch (err) {
			console.warn('pdf-ink: could not write the link cache', err);
		}
	}
}
