import { type IconName, Notice, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { BOARD_ICON } from '../constants';
import { isCanvasId, newCanvasData } from '../core/canvas';
import { isLive } from '../core/items';
import type { PdfInkHost } from '../settings';
import { type BoardLifecycle, type OpenBoard, VIEW_TYPE_BOARD } from './board-lifecycle';
import { PdfInkView } from './pdf-ink-view';

/**
 * A temporary board's tab: the ink view with no file behind it. Its state names
 * the board; the ink is read from and saved to the board's hidden folder, and
 * the folder goes when the tab closes (see BoardLifecycle).
 */
export class BoardView extends PdfInkView implements OpenBoard {
	constructor(
		leaf: WorkspaceLeaf,
		host: PdfInkHost,
		private readonly boards: BoardLifecycle,
	) {
		super(leaf, host);
		this.allowNoFile = true;
		this.icon = BOARD_ICON;
		// Never navigated to another file: that would throw the board away.
		this.navigation = false;
	}

	override getViewType(): string {
		return VIEW_TYPE_BOARD;
	}

	override getIcon(): IconName {
		return BOARD_ICON;
	}

	override canAcceptExtension(): boolean {
		return false;
	}

	get shownBoardId(): string | null {
		return this.boardId;
	}

	override getState(): Record<string, unknown> {
		const state = super.getState();
		// Not `fresh`: a restored tab must never start its board over.
		if (this.boardId !== null) state['board'] = this.boardId;
		return state;
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const raw = (typeof state === 'object' && state !== null ? state : {}) as Record<string, unknown>;
		const id = raw['board'];
		if (!isCanvasId(id) || id === this.boardId) return;
		if (this.boards.isOpenElsewhere(id, this.leaf)) {
			// Two tabs saving one board would each overwrite the other.
			new Notice('That board is already open in another tab.');
			this.closeSoon();
			return;
		}
		this.boards.keep(id);
		const fresh = raw['fresh'] === true ? newCanvasData(Date.now()) : null;
		const found = await this.loadScratchBoard(id, fresh);
		// Thrown away when the app quit: the restored tab has nothing to show.
		if (!found) this.closeSoon();
	}

	protected override async onOpen(): Promise<void> {
		await super.onOpen();
		this.boards.attach(this);
	}

	protected override async onClose(): Promise<void> {
		const id = this.boardId;
		const hadInk = this.boardItems().some(isLive);
		this.boards.detach(this);
		// Saves what is pending, so a reopen within the window loses nothing.
		await super.onClose();
		this.boardId = null;
		if (id !== null) this.boards.closed(id, hadInk, this.leaf);
	}

	/** Send the selection, or with none the whole board, to a notebook. */
	sendToNotebook(): void {
		this.sendBoardToNotebook();
	}

	async abandon(): Promise<void> {
		await this.abandonScratchBoard();
	}

	/** Close this tab, outside whatever workspace change is running now. */
	private closeSoon(): void {
		window.setTimeout(() => {
			this.leaf.detach();
		}, 0);
	}
}
