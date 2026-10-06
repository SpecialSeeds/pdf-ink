import { type App, FuzzySuggestModal, Modal, Notice, Setting, TFolder } from 'obsidian';
import { formatHeaderDate } from '../core/header';
import { SKIP_REASONS } from '../core/title-migration';
import {
	type ConversionPlan,
	applyTitleConversions,
	planTitleConversions,
} from '../utils/convert-titles';

function isFolder(value: unknown): value is TFolder {
	return value instanceof TFolder;
}

/** Pick a folder, show what would change, and convert only once confirmed. */
export function convertImportedTitles(app: App): void {
	new FolderPicker(app, (folder) => {
		void (async () => {
			const plan = await planTitleConversions(app, folder);
			new ConversionSummary(app, folder, plan).open();
		})();
	}).open();
}

/** Choose a folder of the vault, the root included. */
export class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly chosen: (folder: TFolder) => void,
		placeholder = 'Convert imported titles to headers in which folder?',
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter(isFolder);
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot() ? '/' : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.chosen(folder);
	}
}

/** The dry run's findings, with the one button that writes anything. */
class ConversionSummary extends Modal {
	constructor(
		app: App,
		private readonly folder: TFolder,
		private readonly plan: ConversionPlan,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, titleEl, plan } = this;
		titleEl.setText('Convert imported titles to headers');
		const where = this.folder.isRoot() ? 'the vault' : this.folder.path;
		if (plan.matches.length === 0) {
			contentEl.createEl('p', { text: `No notebook in ${where} opens with its own title and a date line.` });
		} else {
			contentEl.createEl('p', {
				text: `${String(plan.matches.length)} notebook(s) in ${where} open with their title and date as text. Each would get a header in their place:`,
			});
			const list = contentEl.createEl('ul', { cls: 'pdf-ink-conversion-list' });
			for (const match of plan.matches) {
				list.createEl('li', {
					text: `${match.file.path}: ${formatHeaderDate(match.createdAt, 'onenote')}`,
				});
			}
		}
		if (plan.skipped.length > 0) {
			contentEl.createEl('p', {
				text: `${String(plan.skipped.length)} other notebook(s) were checked and are left as they are:`,
			});
			const list = contentEl.createEl('ul', { cls: 'pdf-ink-conversion-list' });
			for (const skipped of plan.skipped) {
				list.createEl('li', { text: `${skipped.file.path}: ${SKIP_REASONS[skipped.reason]}` });
			}
		}
		if (plan.unreadable.length > 0) {
			contentEl.createEl('p', {
				text: `Could not read: ${plan.unreadable.join(', ')}.`,
			});
		}

		const buttons = new Setting(contentEl).addButton((button) =>
			button.setButtonText('Cancel').onClick(() => {
				this.close();
			}),
		);
		if (plan.matches.length > 0) {
			buttons.addButton((button) =>
				button
					.setButtonText(`Convert ${String(plan.matches.length)}`)
					.setCta()
					.onClick(() => {
						this.close();
						void (async () => {
							const done = await applyTitleConversions(this.app, plan.matches);
							new Notice(`Gave ${String(done)} notebook(s) a title header.`);
						})();
					}),
			);
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
