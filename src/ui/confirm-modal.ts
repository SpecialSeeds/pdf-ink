import { type App, Modal, Setting } from 'obsidian';

export interface ConfirmOptions {
	readonly title: string;
	readonly message: string;
	/** Label for the confirming button. */
	readonly cta: string;
	/** Style the confirm button as destructive. */
	readonly warning?: boolean;
}

/**
 * A yes/no modal, resolved as a promise.
 *
 * Resolves false when dismissed by Escape or by clicking away, so a caller can
 * treat "no answer" and "no" identically.
 */
export function confirm(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, options, resolve).open();
	});
}

class ConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly options: ConfirmOptions,
		private readonly respond: (confirmed: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.options.title);
		contentEl.createEl('p', { text: this.options.message });

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => {
					this.answer(false);
				}),
			)
			.addButton((button) => {
				button.setButtonText(this.options.cta).onClick(() => {
					this.answer(true);
				});
				if (this.options.warning === true) button.setWarning();
				else button.setCta();
			});
	}

	override onClose(): void {
		this.contentEl.empty();
		// Dismissing without choosing is a no.
		this.answer(false);
	}

	private answer(confirmed: boolean): void {
		if (this.answered) return;
		this.answered = true;
		this.respond(confirmed);
		this.close();
	}
}
