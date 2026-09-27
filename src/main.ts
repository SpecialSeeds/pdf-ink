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

export default class PdfInkPlugin extends Plugin {
	settings: PdfInkSettings = DEFAULT_SETTINGS;

	override async onload(): Promise<void> {
		// Registered before any await: a restored workspace holding a pdf-ink-view
		// leaf needs this creator to exist by the time the layout is rebuilt, or
		// the leaf comes back as an empty pane.
		//
		// registerView only — never registerExtensions, which would take over
		// every .pdf in the vault with no way to restore the core viewer.
		this.registerView(
			VIEW_TYPE_PDF_INK,
			(leaf) => new PdfInkView(leaf, this),
		);

		registerCommands(this);
		registerFileMenu(this);
		// Vault-wide, so a PDF renamed while closed does not orphan its sidecar.
		registerSidecarEvents(this);

		this.settings = mergeSettings(await this.loadData());
		this.addSettingTab(new PdfInkSettingTab(this.app, this));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// No onunload: registerView, addCommand and registerEvent all unwind on their
	// own. Detaching the view's leaves would also reset placement the user chose.
}
