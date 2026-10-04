import { type App, Modal, Setting } from 'obsidian';
import type { ThemeName } from '../core/theme';
import type { PdfInkHost } from '../settings';

/**
 * Ask which theme to export in, resolved as a promise: the chosen theme, or null
 * when dismissed. `preselected` is the call-to-action button, so Enter takes it.
 */
export function chooseExportTheme(
	app: App,
	preselected: ThemeName,
): Promise<ThemeName | null> {
	return new Promise((resolve) => {
		new ExportThemeModal(app, preselected, resolve).open();
	});
}

class ExportThemeModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly preselected: ThemeName,
		private readonly respond: (theme: ThemeName | null) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('Export theme');
		contentEl.createEl('p', {
			text: 'Notebook and inserted pages export with this paper, grid and ink. Pages of the original PDF stay as they are.',
		});

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Light').onClick(() => {
					this.answer('light');
				});
				if (this.preselected === 'light') button.setCta();
			})
			.addButton((button) => {
				button.setButtonText('Dark').onClick(() => {
					this.answer('dark');
				});
				if (this.preselected === 'dark') button.setCta();
			});

		// Enter takes the preselected theme, as it would in any dialog.
		this.scope.register([], 'Enter', (evt) => {
			evt.preventDefault();
			this.answer(this.preselected);
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		// Dismissing without choosing cancels the export.
		this.answer(null);
	}

	private answer(theme: ThemeName | null): void {
		if (this.answered) return;
		this.answered = true;
		this.respond(theme);
		this.close();
	}
}

/**
 * The theme to export in: asked for, preselecting the last choice, or — with
 * "Ask for theme on export" off — the last choice straight away. A new choice is
 * remembered. Null when the user dismissed the question.
 */
export async function resolveExportTheme(
	app: App,
	host: PdfInkHost,
): Promise<ThemeName | null> {
	const last = host.settings.exportTheme;
	if (!host.settings.askExportTheme) return last;
	const chosen = await chooseExportTheme(app, last);
	if (chosen !== null && chosen !== last) {
		host.settings.exportTheme = chosen;
		await host.saveSettings();
	}
	return chosen;
}
