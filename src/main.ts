import { Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { VIEW_TYPE_PDF_INK } from './constants';
import { registerFileMenu } from './menus/file-menu';
import { registerSidecarEvents } from './pdf/sidecar';
import {
	DEFAULT_SETTINGS,
	type PdfInkSettings,
	PdfInkSettingTab,
	mergeSettings,
} from './settings';
import { PdfInkView } from './ui/pdf-ink-view';
import { DefaultPdfViewer } from './utils/default-viewer';

export default class PdfInkPlugin extends Plugin {
	settings: PdfInkSettings = DEFAULT_SETTINGS;
	private readonly defaultViewer = new DefaultPdfViewer(this);

	override async onload(): Promise<void> {
		// Registered before any await: a restored workspace holding a pdf-ink-view
		// leaf needs this creator to exist by the time the layout is rebuilt, or
		// the leaf comes back as an empty pane.
		//
		// Taking over `.pdf` goes through DefaultPdfViewer rather than
		// registerExtensions, so the core viewer can always be handed it back.
		this.registerView(
			VIEW_TYPE_PDF_INK,
			(leaf) => new PdfInkView(leaf, this),
		);

		registerCommands(this);
		registerFileMenu(this);
		// Vault-wide, so a PDF renamed while closed does not orphan its sidecar.
		registerSidecarEvents(this);

		this.settings = mergeSettings(await this.loadData());
		this.defaultViewer.apply(this.settings.openByDefault);
		this.addSettingTab(new PdfInkSettingTab(this.app, this));
	}

	/** The view type that shows a PDF without ink, for leaving the ink view. */
	get plainPdfViewType(): string {
		return this.defaultViewer.plainViewType;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.defaultViewer.apply(this.settings.openByDefault);
		// Settings that change how an open view behaves — the diagnostics overlay —
		// take effect where the user can see them, not on the next reopen.
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_INK)) {
			const view = leaf.view;
			if (view instanceof PdfInkView) view.refreshSettings();
		}
	}

	// No onunload: registerView, addCommand and registerEvent all unwind on their
	// own, and DefaultPdfViewer hands `.pdf` back to the core viewer. Detaching
	// the view's leaves would also reset placement the user chose.
}
