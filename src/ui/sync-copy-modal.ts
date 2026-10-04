import { type App, Modal, Setting, type TFile } from 'obsidian';
import type { CopyDecision } from '../pdf/annotation-store';

/**
 * Ask whether a numbered copy of a notebook is a sync conflict to merge, resolved
 * as a promise. Null when dismissed, so the question comes back next time rather
 * than being answered by a stray Escape.
 */
export function askAboutSyncCopy(
	app: App,
	copy: TFile,
	notebook: TFile,
): Promise<CopyDecision> {
	return new Promise((resolve) => {
		new SyncCopyModal(app, copy, notebook, resolve).open();
	});
}

class SyncCopyModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly copy: TFile,
		private readonly notebook: TFile,
		private readonly respond: (decision: CopyDecision) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('Sync conflict copy?');
		contentEl.createEl('p', {
			text: `${this.copy.name} looks like a sync conflict copy of ${this.notebook.name}. Merge it?`,
		});
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Merging adds its pages and ink to this notebook and moves the copy to the trash. Keeping it separate leaves both notebooks as they are, and you will not be asked about it again.',
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Keep separate').onClick(() => {
					this.answer('keep');
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Merge')
					.setCta()
					.onClick(() => {
						this.answer('merge');
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.answer(null);
	}

	private answer(decision: CopyDecision): void {
		if (this.answered) return;
		this.answered = true;
		this.respond(decision);
		this.close();
	}
}
