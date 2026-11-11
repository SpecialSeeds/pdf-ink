import { type App, Modal, Setting } from 'obsidian';
import type { ThemeName } from '../core/theme';
import {
	EXPORT_QUALITIES,
	type ExportQuality,
	QUALITY_PROFILES,
	formatFileSize,
} from '../core/export-quality';
import type { PdfInkHost } from '../settings';

/** How to export: the theme for inserted pages, whether to include them, and quality. */
export interface ExportChoice {
	readonly theme: ThemeName;
	/** False exports the original PDF's pages only, with their ink. */
	readonly insertedPages: boolean;
	readonly quality: ExportQuality;
}

export interface ExportQuestion {
	/** Adds a button for the original PDF's pages alone, which a notebook has none of. */
	readonly offerOriginal: boolean;
	/** The exported file's size in bytes for a choice, built in memory. */
	readonly measure: (choice: ExportChoice) => Promise<number>;
	/** The source PDF's size, shown beside the export's, since it is the floor. */
	readonly originalSize?: number;
}

/** Waits this long after the slider settles before building, so dragging stays smooth. */
const MEASURE_DELAY_MS = 200;

/**
 * Ask how to export, resolved as a promise: the choice, or null when dismissed.
 * `preselected` is the call-to-action button, so Enter takes it.
 */
export function chooseExport(
	app: App,
	preselected: ThemeName,
	quality: ExportQuality,
	question: ExportQuestion,
): Promise<ExportChoice | null> {
	return new Promise((resolve) => {
		new ExportThemeModal(app, preselected, quality, question, resolve).open();
	});
}

class ExportThemeModal extends Modal {
	private answered = false;
	private quality: ExportQuality;
	private sizeEl!: HTMLElement;
	private levelEl!: HTMLElement;
	/** Bumped on every change, so a slow build of an older quality cannot overwrite a newer one. */
	private measuring = 0;
	private timer: number | null = null;

	constructor(
		app: App,
		private readonly preselected: ThemeName,
		quality: ExportQuality,
		private readonly question: ExportQuestion,
		private readonly respond: (choice: ExportChoice | null) => void,
	) {
		super(app);
		this.quality = quality;
	}

	override onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('Export');

		const qualitySetting = new Setting(contentEl)
			.setName('Quality')
			.setDesc('Lower quality simplifies ink outlines and shrinks pictures.')
			.addSlider((slider) => {
				slider
					.setLimits(0, EXPORT_QUALITIES.length - 1, 1)
					.setValue(EXPORT_QUALITIES.indexOf(this.quality))
					.onChange((index) => {
						this.setQuality(index);
					});
				// Some builds only report a slider's value on release; the label
				// follows the thumb either way.
				slider.sliderEl.addEventListener('input', () => {
					this.setQuality(Number(slider.sliderEl.value));
				});
			});
		this.levelEl = qualitySetting.controlEl.createSpan({ cls: 'pdf-ink-export-level' });
		this.sizeEl = contentEl.createEl('p', { cls: 'pdf-ink-export-size' });
		// A notebook's pages are all ink; a PDF's own pages are a floor quality cannot lower.
		if (this.question.originalSize !== undefined) {
			contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: `Pages of the original PDF are copied as they are, so the export is never smaller than the PDF itself (${formatFileSize(this.question.originalSize)}).`,
			});
		}

		contentEl.createEl('p', {
			text: 'Notebook and inserted pages export with this paper, grid and ink. Pages of the original PDF stay as they are.',
		});
		if (this.question.offerOriginal) {
			contentEl.createEl('p', {
				text: 'Original pages only leaves out the inserted pages and keeps the ink on the rest.',
			});
		}

		const buttons = new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Light').onClick(() => {
					this.answer({ theme: 'light', insertedPages: true, quality: this.quality });
				});
				if (this.preselected === 'light') button.setCta();
			})
			.addButton((button) => {
				button.setButtonText('Dark').onClick(() => {
					this.answer({ theme: 'dark', insertedPages: true, quality: this.quality });
				});
				if (this.preselected === 'dark') button.setCta();
			});
		if (this.question.offerOriginal) {
			buttons.addButton((button) => {
				button.setButtonText('Original pages only').onClick(() => {
					// Original pages always export light, so the theme is moot.
					this.answer({
						theme: this.preselected,
						insertedPages: false,
						quality: this.quality,
					});
				});
			});
		}

		// Enter takes the preselected theme, as it would in any dialog.
		this.scope.register([], 'Enter', (evt) => {
			evt.preventDefault();
			this.answer({ theme: this.preselected, insertedPages: true, quality: this.quality });
		});

		this.showLevel();
		this.measure(0);
	}

	override onClose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.measuring++;
		this.contentEl.empty();
		// Dismissing without choosing cancels the export.
		this.answer(null);
	}

	private setQuality(index: number): void {
		const quality = EXPORT_QUALITIES[Math.round(index)];
		if (quality === undefined || quality === this.quality) return;
		this.quality = quality;
		this.showLevel();
		this.measure(MEASURE_DELAY_MS);
	}

	private showLevel(): void {
		this.levelEl.setText(QUALITY_PROFILES[this.quality].label);
	}

	/** Build the export at the current quality and show its size. */
	private measure(delay: number): void {
		const ticket = ++this.measuring;
		this.sizeEl.setText('File size: measuring…');
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			const quality = this.quality;
			this.question
				.measure({ theme: this.preselected, insertedPages: true, quality })
				.then((bytes) => {
					if (ticket !== this.measuring) return;
					this.sizeEl.setText(`File size: ${formatFileSize(bytes)}`);
				})
				.catch((err: unknown) => {
					console.error('pdf-ink: could not measure the export', err);
					if (ticket === this.measuring) this.sizeEl.setText('File size: unknown');
				});
		}, delay);
	}

	private answer(choice: ExportChoice | null): void {
		if (this.answered) return;
		this.answered = true;
		this.respond(choice);
		this.close();
	}
}

/**
 * How to export: asked for, preselecting the last theme and quality, or — with
 * "Ask for theme on export" off — the last theme and quality with every page
 * straight away. A new theme or quality is remembered; leaving out inserted pages
 * is a one-off. Null when the user dismissed the question.
 */
export async function resolveExportChoice(
	app: App,
	host: PdfInkHost,
	question: ExportQuestion,
): Promise<ExportChoice | null> {
	const last = host.settings.exportTheme;
	const lastQuality = host.settings.exportQuality;
	if (!host.settings.askExportTheme) {
		return { theme: last, insertedPages: true, quality: lastQuality };
	}
	const chosen = await chooseExport(app, last, lastQuality, question);
	if (chosen === null) return null;
	let changed = false;
	if (chosen.insertedPages && chosen.theme !== last) {
		host.settings.exportTheme = chosen.theme;
		changed = true;
	}
	if (chosen.quality !== lastQuality) {
		host.settings.exportQuality = chosen.quality;
		changed = true;
	}
	if (changed) await host.saveSettings();
	return chosen;
}
