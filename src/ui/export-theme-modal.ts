import { type App, Modal, Setting } from 'obsidian';
import type { ThemeName } from '../core/theme';
import type { PdfInkHost } from '../settings';

/** How to export: the theme for inserted pages, and whether to include them at all. */
export interface ExportChoice {
	readonly theme: ThemeName;
	/** False exports the original PDF's pages only, with their ink. */
	readonly insertedPages: boolean;
}

/**
 * Ask how to export, resolved as a promise: the choice, or null when dismissed.
 * `preselected` is the call-to-action button, so Enter takes it. `offerOriginal`
 * adds a button for the original PDF's pages alone, which a notebook has none of.
 */
export function chooseExport(
	app: App,
	preselected: ThemeName,
	offerOriginal: boolean,
): Promise<ExportChoice | null> {
	return new Promise((resolve) => {
		new ExportThemeModal(app, preselected, offerOriginal, resolve).open();
	});
}

class ExportThemeModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly preselected: ThemeName,
		private readonly offerOriginal: boolean,
		private readonly respond: (choice: ExportChoice | null) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('Export theme');
		contentEl.createEl('p', {
			text: 'Notebook and inserted pages export with this paper, grid and ink. Pages of the original PDF stay as they are.',
		});
		if (this.offerOriginal) {
			contentEl.createEl('p', {
				text: 'Original pages only leaves out the inserted pages and keeps the ink on the rest.',
			});
		}

		const buttons = new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Light').onClick(() => {
					this.answer({ theme: 'light', insertedPages: true });
				});
				if (this.preselected === 'light') button.setCta();
			})
			.addButton((button) => {
				button.setButtonText('Dark').onClick(() => {
					this.answer({ theme: 'dark', insertedPages: true });
				});
				if (this.preselected === 'dark') button.setCta();
			});
		if (this.offerOriginal) {
			buttons.addButton((button) => {
				button.setButtonText('Original pages only').onClick(() => {
					// Original pages always export light, so the theme is moot.
					this.answer({ theme: this.preselected, insertedPages: false });
				});
			});
		}

		// Enter takes the preselected theme, as it would in any dialog.
		this.scope.register([], 'Enter', (evt) => {
			evt.preventDefault();
			this.answer({ theme: this.preselected, insertedPages: true });
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		// Dismissing without choosing cancels the export.
		this.answer(null);
	}

	private answer(choice: ExportChoice | null): void {
		if (this.answered) return;
		this.answered = true;
		this.respond(choice);
		this.close();
	}
}

/**
 * How to export: asked for, preselecting the last theme, or — with "Ask for
 * theme on export" off — the last theme with every page straight away. A new
 * theme is remembered; leaving out inserted pages is a one-off. Null when the
 * user dismissed the question.
 */
export async function resolveExportChoice(
	app: App,
	host: PdfInkHost,
	offerOriginal: boolean,
): Promise<ExportChoice | null> {
	const last = host.settings.exportTheme;
	if (!host.settings.askExportTheme) return { theme: last, insertedPages: true };
	const chosen = await chooseExport(app, last, offerOriginal);
	if (chosen?.insertedPages && chosen.theme !== last) {
		host.settings.exportTheme = chosen.theme;
		await host.saveSettings();
	}
	return chosen;
}
