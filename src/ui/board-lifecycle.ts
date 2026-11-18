import { Notice, type Plugin, type WorkspaceLeaf } from 'obsidian';
import { CANVAS_FOLDER, canvasFolder, isCanvasId } from '../core/canvas';
import { createPageId } from '../core/pages';

/** The view type of a temporary board's tab. */
export const VIEW_TYPE_BOARD = 'pdf-ink-board';

/** How long a closed board can be reopened before its folder is removed, in ms. */
export const REOPEN_WINDOW_MS = 10_000;

/** What a board view does for the lifecycle when the app quits. */
export interface OpenBoard {
	/** The board it shows, if any. */
	readonly shownBoardId: string | null;
	/** Stop saving it, and wait for a save under way. */
	abandon(): Promise<void>;
}

/**
 * Making, closing and throwing away temporary boards (src/core/canvas.ts).
 *
 * A board's folder goes when its tab closes, after a short window in which it
 * can be reopened, and every board goes when the app quits. Anything left
 * behind (the app was killed, or quit without the quit event, as on a tablet)
 * is kept while a restored tab still shows it and swept away once none does.
 */
export class BoardLifecycle {
	/** Closed boards waiting out their reopen window, by id. */
	private readonly pending = new Map<string, number>();
	private readonly open = new Set<OpenBoard>();
	/**
	 * Set once the app is quitting or the plugin unloading: tabs closing then are
	 * not boards being put away, and get no reopen notice or timer.
	 */
	private stopping = false;

	constructor(private readonly plugin: Plugin) {}

	register(): void {
		const { app } = this.plugin;
		this.plugin.registerEvent(
			app.workspace.on('quit', (tasks) => {
				this.stopping = true;
				tasks.add(async () => {
					await this.removeAll();
				});
			}),
		);
		app.workspace.onLayoutReady(() => {
			void this.sweep();
		});
		// Unloading the plugin (an update, or turning it off) is not closing the
		// board: its folder stays for when the tab comes back.
		this.plugin.register(() => {
			this.stopping = true;
			for (const timer of this.pending.values()) window.clearTimeout(timer);
			this.pending.clear();
		});
	}

	/** Open a new, empty board in a tab of its own. */
	async create(): Promise<void> {
		await this.openInTab({ board: createPageId(), fresh: true });
	}

	/** A board view came up: it is not being thrown away after all. */
	attach(view: OpenBoard): void {
		this.open.add(view);
	}

	detach(view: OpenBoard): void {
		this.open.delete(view);
	}

	/** A tab is showing `id` again (reopened): stop its pending removal. */
	keep(id: string): void {
		const timer = this.pending.get(id);
		if (timer === undefined) return;
		window.clearTimeout(timer);
		this.pending.delete(id);
	}

	/** Whether a tab other than `leaf` shows board `id`. */
	isOpenElsewhere(id: string, leaf: WorkspaceLeaf): boolean {
		return this.leavesShowing(id).some((other) => other !== leaf);
	}

	/**
	 * Board `id`'s tab closed. An empty board goes at once; one with ink after
	 * {@link REOPEN_WINDOW_MS}, with a notice that can bring it back until then.
	 */
	closed(id: string, hadInk: boolean, leaf: WorkspaceLeaf): void {
		if (this.stopping) return;
		if (this.leavesShowing(id).some((other) => other !== leaf)) return;
		if (!hadInk) {
			void this.remove(id, leaf);
			return;
		}
		this.keep(id);
		const timer = window.setTimeout(() => {
			this.pending.delete(id);
			void this.remove(id, leaf);
		}, REOPEN_WINDOW_MS);
		this.pending.set(id, timer);

		const notice = new Notice(
			createFragment((frag) => {
				frag.createSpan({ text: 'Board closed. Its ink will be thrown away. ' });
				const buttonEl = frag.createEl('button', { text: 'Reopen' });
				buttonEl.addEventListener('click', () => {
					notice.hide();
					if (!this.pending.has(id)) return;
					this.keep(id);
					void this.openInTab({ board: id });
				});
			}),
			REOPEN_WINDOW_MS,
		);
	}

	private async openInTab(state: Record<string, unknown>): Promise<void> {
		const leaf = this.plugin.app.workspace.getLeaf('tab');
		// Pinned, so opening a file from the file list goes to another tab rather
		// than replacing, and so throwing away, the board.
		leaf.setPinned(true);
		await leaf.setViewState({ type: VIEW_TYPE_BOARD, state, active: true });
	}

	private leavesShowing(id: string): WorkspaceLeaf[] {
		return this.plugin.app.workspace
			.getLeavesOfType(VIEW_TYPE_BOARD)
			.filter((leaf) => leaf.getViewState().state?.['board'] === id);
	}

	/** The app is quitting: every board goes, and none is written again first. */
	private async removeAll(): Promise<void> {
		for (const timer of this.pending.values()) window.clearTimeout(timer);
		this.pending.clear();
		await Promise.all([...this.open].map((view) => view.abandon()));
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (await adapter.exists(CANVAS_FOLDER)) await adapter.rmdir(CANVAS_FOLDER, true);
		} catch (err) {
			console.error('pdf-ink: could not remove the boards', err);
		}
	}

	/** Remove board `id`'s folder, unless a tab (other than `closing`) shows it. */
	private async remove(id: string, closing?: WorkspaceLeaf): Promise<void> {
		// Reopened, or open again in another tab, while waiting.
		if (this.leavesShowing(id).some((leaf) => leaf !== closing)) return;
		const adapter = this.plugin.app.vault.adapter;
		const folder = canvasFolder(id);
		try {
			if (await adapter.exists(folder)) await adapter.rmdir(folder, true);
		} catch (err) {
			console.error(`pdf-ink: could not remove board ${id}`, err);
		}
	}

	/** Remove every board no tab shows: what a killed app or a lost quit left. */
	private async sweep(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (!(await adapter.exists(CANVAS_FOLDER))) return;
			const listed = await adapter.list(CANVAS_FOLDER);
			for (const folder of listed.folders) {
				const id = folder.slice(folder.lastIndexOf('/') + 1);
				if (!isCanvasId(id) || this.pending.has(id)) continue;
				await this.remove(id);
			}
		} catch (err) {
			console.error('pdf-ink: could not clear old boards', err);
		}
	}
}
