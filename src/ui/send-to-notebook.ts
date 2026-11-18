import { type App, Notice, SuggestModal, type TFile } from 'obsidian';
import { isCanvasPath, withSentPage } from '../core/canvas';
import { parseInkData, serializeInkData } from '../core/ink-serialization';
import { INK_DATA_VERSION, type InkData, type Item } from '../core/items';
import { NOTEBOOK_EXTENSION, createDocId, isNotebookPath, newNotebookData } from '../core/new-notebook';
import { untitledPath } from '../core/new-pdf';
import { createStrokeId } from '../core/stroke';
import type { PdfInkSettings } from '../core/settings-schema';
import { saveImage } from '../utils/images';

/** Where ink sent from a board goes. */
type Destination =
	| { readonly kind: 'new'; readonly name: string }
	| { readonly kind: 'existing'; readonly file: TFile };

/** The most notebooks listed at once; typing narrows them. */
const MAX_LISTED = 50;

/**
 * Pick a notebook to send ink to, or name a new one: what is typed is offered
 * first as a new notebook's name, then every notebook whose path matches it,
 * most recently changed first.
 */
class NotebookChooser extends SuggestModal<Destination> {
	constructor(
		app: App,
		private readonly onChoose: (destination: Destination) => void,
	) {
		super(app);
		this.setPlaceholder('Add to a notebook, or type a name for a new one');
		this.emptyStateText = 'No notebooks match.';
	}

	getSuggestions(query: string): Destination[] {
		const typed = query.trim();
		const needle = typed.toLowerCase();
		const notebooks = this.app.vault
			.getFiles()
			.filter((file) => isNotebookPath(file.path))
			.filter((file) => needle === '' || file.path.toLowerCase().includes(needle))
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, MAX_LISTED);
		return [
			{ kind: 'new', name: typed },
			...notebooks.map((file) => ({ kind: 'existing' as const, file })),
		];
	}

	renderSuggestion(destination: Destination, el: HTMLElement): void {
		if (destination.kind === 'new') {
			el.createDiv({
				text: destination.name ? `New notebook “${destination.name}”` : 'New notebook',
			});
			el.createEl('small', { text: 'Starts a notebook with this on its first page', cls: 'pdf-ink-muted' });
			return;
		}
		el.createDiv({ text: destination.file.basename });
		el.createEl('small', { text: destination.file.path, cls: 'pdf-ink-muted' });
	}

	onChooseSuggestion(destination: Destination): void {
		this.onChoose(destination);
	}
}

/**
 * Ask where, then copy `items` from a temporary board onto a new page at the
 * end of that notebook (or the first page of a new one). The board keeps its
 * ink. Pictures are copied out of the board's hidden folder into the `images`
 * folder beside the notebook, since the board's go when it does.
 */
export function sendToNotebook(app: App, settings: PdfInkSettings, items: readonly Item[]): void {
	new NotebookChooser(app, (destination) => {
		void send(app, settings, items, destination);
	}).open();
}

async function send(
	app: App,
	settings: PdfInkSettings,
	items: readonly Item[],
	destination: Destination,
): Promise<void> {
	try {
		if (destination.kind === 'new') {
			const path = newNotebookPath(app, destination.name);
			const now = Date.now();
			// No page yet: the sent ink becomes page 1, below the header if any.
			const fresh: InkData = {
				...newNotebookData(now),
				insertedPages: [],
				...(settings.addTitleHeader ? { header: { createdAt: now } } : {}),
			};
			const placed = await withPictures(app, items, path);
			const sent = withSentPage(fresh, placed, createStrokeId, now);
			if (!sent) return;
			const file = await app.vault.create(path, serializeInkData(sent.data));
			new Notice(`Sent to a new notebook, ${file.basename}.`);
			return;
		}

		const file = destination.file;
		// Read first, so a notebook that cannot take the page is found out before
		// any picture is copied beside it.
		readNotebook(await app.vault.read(file), file);
		const placed = await withPictures(app, items, file.path);
		let pageNumber = 0;
		// In place, as the ink view writes a notebook; one open on it merges the
		// new page in like any edit from another device.
		await app.vault.process(file, (raw) => {
			const sent = withSentPage(readNotebook(raw, file), placed, createStrokeId, Date.now());
			if (!sent) return raw;
			pageNumber = sent.pageNumber;
			return serializeInkData(sent.data);
		});
		if (pageNumber > 0) new Notice(`Sent to ${file.basename}, page ${String(pageNumber)}.`);
	} catch (err) {
		console.error('pdf-ink: could not send the board to a notebook', err);
		new Notice(err instanceof NotebookUnreadable ? err.message : 'Could not send that to the notebook.');
	}
}

class NotebookUnreadable extends Error {}

/** A notebook's data, an empty file being an empty notebook. Throws when unreadable. */
function readNotebook(raw: string, file: TFile): InkData {
	if (raw.trim().length === 0) {
		return { version: INK_DATA_VERSION, pages: {}, insertedPages: [], docId: createDocId() };
	}
	const parsed = parseInkData(raw);
	if (!parsed.ok) throw new NotebookUnreadable(`Could not read ${file.basename}, so nothing was added to it.`);
	return parsed.data;
}

/** Where a new notebook named `name` goes: beside new notes, never over a file. */
function newNotebookPath(app: App, name: string): string {
	const parent = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? '');
	const taken = (candidate: string): boolean => app.vault.getAbstractFileByPath(candidate) !== null;
	const stem = name.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\.inknote$/i, '').trim();
	if (!stem) return untitledPath(parent.path, NOTEBOOK_EXTENSION, taken);
	const prefix = parent.path === '' || parent.path === '/' ? '' : `${parent.path}/`;
	let path = `${prefix}${stem}.${NOTEBOOK_EXTENSION}`;
	for (let n = 1; taken(path); n++) path = `${prefix}${stem} ${String(n)}.${NOTEBOOK_EXTENSION}`;
	return path;
}

/**
 * `items` with every picture from a board's hidden folder copied beside the
 * notebook at `notebookPath`, and pointing at the copy. A picture that cannot
 * be copied is left out, with a notice, rather than left pointing at a file
 * that is about to go.
 */
async function withPictures(app: App, items: readonly Item[], notebookPath: string): Promise<Item[]> {
	const copied = new Map<string, string | null>();
	const out: Item[] = [];
	for (const item of items) {
		if (item.type !== 'image' || !isCanvasPath(item.src)) {
			out.push(item);
			continue;
		}
		if (!copied.has(item.src)) copied.set(item.src, await copyPicture(app, item.src, notebookPath));
		const src = copied.get(item.src);
		if (src) out.push({ ...item, src });
	}
	const lost = [...copied.values()].filter((src) => src === null).length;
	if (lost > 0) new Notice(`Could not copy ${String(lost)} picture(s); they were left out.`);
	return out;
}

async function copyPicture(app: App, src: string, notebookPath: string): Promise<string | null> {
	try {
		const adapter = app.vault.adapter;
		if (!(await adapter.exists(src))) return null;
		const bytes = await adapter.readBinary(src);
		const name = src.slice(src.lastIndexOf('/') + 1);
		// Named by type, so PNG and JPEG are kept byte for byte.
		const type = /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png';
		const saved = await saveImage(app, new Blob([bytes], { type }), name, notebookPath);
		return saved.path;
	} catch (err) {
		console.error(`pdf-ink: could not copy ${src}`, err);
		return null;
	}
}
