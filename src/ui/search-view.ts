import { ItemView, type TFile, type WorkspaceLeaf, debounce } from 'obsidian';
import { type BlockBox, segmentPage } from '../core/blocks';
import { type SearchEntry, groupBySource, searchEntries } from '../core/search';
import { blockBoxFrom, isTranscriptPath, parseTranscript } from '../core/transcripts';
import { openSourceAt } from '../transcription/navigate';
import { rasterisePage } from '../transcription/raster';
import { type OpenSource, openSource } from '../transcription/sources';
import { frontmatterOf } from '../transcription/frontmatter';

export const VIEW_TYPE_NOTE_SEARCH = 'pdf-ink-note-search';
export const NOTE_SEARCH_ICON = 'scan-search';

/** How many results get a picture of their handwriting. */
const MAX_THUMBNAILS = 40;
/** A thumbnail's width, in CSS px. */
const THUMBNAIL_WIDTH = 260;

/** What the search view needs from the plugin. */
export interface NoteSearchHost {
	readonly settings: { readonly transcriptFolder: string };
}

interface IndexEntry extends SearchEntry {
	/** The transcript's `blocks` field: where each block was when transcribed. */
	readonly blocks: unknown;
}

/**
 * Full-text search over the transcripts, landing on the handwriting.
 *
 * Results show the transcribed line, its page and a picture of the block drawn
 * live from the notebook; choosing one opens the notebook or PDF itself at that
 * block. The transcript is only ever the index, never shown as a destination.
 */
export class NoteSearchView extends ItemView {
	private inputEl!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private index: IndexEntry[] | null = null;
	/** Sources opened for thumbnails, closed when the index is rebuilt or the view closes. */
	private readonly sources = new Map<string, Promise<OpenSource | null>>();
	/** Bumped per query, so a slow thumbnail for an old query is dropped. */
	private generation = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: NoteSearchHost,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return VIEW_TYPE_NOTE_SEARCH;
	}

	override getDisplayText(): string {
		return 'Search notes';
	}

	override getIcon(): string {
		return NOTE_SEARCH_ICON;
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('pdf-ink-note-search');
		this.inputEl = root.createEl('input', {
			type: 'search',
			cls: 'pdf-ink-note-search-input',
			attr: { placeholder: 'Search your handwriting…', spellcheck: 'false' },
		});
		this.resultsEl = root.createDiv({ cls: 'pdf-ink-note-search-results' });
		const run = debounce(
			() => {
				void this.search(this.inputEl.value);
			},
			200,
			true,
		);
		this.registerDomEvent(this.inputEl, 'input', () => run());
		// A transcript written, moved or removed makes the index stale.
		const stale = (file: { path: string }): void => {
			if (isTranscriptPath(file.path, this.host.settings.transcriptFolder)) this.invalidate();
		};
		this.registerEvent(this.app.metadataCache.on('changed', stale));
		this.registerEvent(this.app.vault.on('delete', stale));
		this.registerEvent(this.app.vault.on('rename', stale));
		this.inputEl.focus();
		await Promise.resolve();
	}

	override async onClose(): Promise<void> {
		await this.closeSources();
	}

	/** Put a query in the box and run it. */
	setQuery(query: string): void {
		this.inputEl.value = query;
		void this.search(query);
	}

	private invalidate(): void {
		this.index = null;
		void this.closeSources();
	}

	private async closeSources(): Promise<void> {
		const open = [...this.sources.values()];
		this.sources.clear();
		for (const source of open) await (await source)?.close();
	}

	private async buildIndex(): Promise<IndexEntry[]> {
		const folder = this.host.settings.transcriptFolder;
		const entries: IndexEntry[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!isTranscriptPath(file.path, folder)) continue;
			const frontmatter = frontmatterOf(this.app, file);
			const source = frontmatter?.['source'];
			if (typeof source !== 'string') continue;
			const text = await this.app.vault.cachedRead(file);
			for (const line of parseTranscript(text)) {
				entries.push({ source, page: line.page, block: line.block, text: line.text, blocks: frontmatter?.['blocks'] });
			}
		}
		return entries;
	}

	private async search(query: string): Promise<void> {
		const generation = ++this.generation;
		this.index ??= await this.buildIndex();
		if (generation !== this.generation) return;
		this.resultsEl.empty();
		if (query.trim().length === 0) return;
		const hits = searchEntries(this.index, query, 100);
		if (hits.length === 0) {
			this.resultsEl.createDiv({ cls: 'pdf-ink-note-search-empty', text: 'No handwriting matches.' });
			return;
		}
		let thumbnails = 0;
		for (const group of groupBySource(hits)) {
			const sourceFile = this.app.vault.getFileByPath(group.source);
			const groupEl = this.resultsEl.createDiv({ cls: 'pdf-ink-note-search-group' });
			groupEl.createDiv({
				cls: 'pdf-ink-note-search-source',
				text: sourceFile?.basename ?? group.source,
				attr: { title: group.source },
			});
			for (const { entry } of group.hits) {
				const hitEl = groupEl.createDiv({ cls: 'pdf-ink-note-search-hit' });
				hitEl.createDiv({ cls: 'pdf-ink-note-search-line', text: entry.text });
				hitEl.createDiv({ cls: 'pdf-ink-note-search-page', text: `Page ${String(entry.page)}` });
				const box = entry.block ? blockBoxFrom(entry.blocks, entry.page, entry.block) : null;
				if (sourceFile && thumbnails < MAX_THUMBNAILS) {
					thumbnails += 1;
					const thumbEl = hitEl.createDiv({ cls: 'pdf-ink-note-search-thumb' });
					void this.drawThumbnail(thumbEl, sourceFile, entry, box, generation);
				}
				if (sourceFile) {
					this.registerDomEvent(hitEl, 'click', (evt) => {
						const leaf = this.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey ? 'tab' : false);
						void openSourceAt(this.app, sourceFile, leaf, {
							page: entry.page,
							...(entry.block ? { block: entry.block } : {}),
							...(box ? { box } : {}),
						});
					});
				}
			}
		}
	}

	private sourceFor(file: TFile): Promise<OpenSource | null> {
		let open = this.sources.get(file.path);
		if (!open) {
			open = openSource(this.app, file).catch(() => null);
			this.sources.set(file.path, open);
		}
		return open;
	}

	/** The block's handwriting, drawn from the source as it is now. */
	private async drawThumbnail(
		thumbEl: HTMLElement,
		file: TFile,
		entry: IndexEntry,
		recorded: BlockBox | null,
		generation: number,
	): Promise<void> {
		const source = await this.sourceFor(file);
		const page = source?.pages[entry.page - 1];
		if (!page || generation !== this.generation) return;
		const box =
			recorded ??
			(() => {
				const base = page.geometry.baseViewport;
				const found = segmentPage(page.items, base.width, base.height).find((b) => b.id === entry.block);
				return found
					? ([found.bounds.minX, found.bounds.minY, found.bounds.maxX - found.bounds.minX, found.bounds.maxY - found.bounds.minY] as const)
					: null;
			})();
		const pad = 6;
		const region = box
			? { minX: box[0] - pad, minY: box[1] - pad, maxX: box[0] + box[2] + pad, maxY: box[1] + box[3] + pad }
			: undefined;
		const widthPt = region ? region.maxX - region.minX : page.geometry.baseViewport.width;
		const ratio = Math.max(1, window.devicePixelRatio || 1);
		const scale = Math.min(3, (THUMBNAIL_WIDTH * ratio) / Math.max(1, widthPt));
		const raster = await rasterisePage(page, { scale, ...(region ? { region } : {}), maxPixels: 1 << 21 });
		if (generation !== this.generation) return;
		raster.canvas.addClass('pdf-ink-note-search-canvas');
		raster.canvas.setCssProps({ '--pdf-ink-result-w': `${String(raster.canvas.width / ratio)}px` });
		thumbEl.appendChild(raster.canvas);
	}
}
