import { type App, Modal, Setting } from 'obsidian';

/**
 * Ask which position to move a page to, 1 to `count`. Resolves the 0-based
 * position chosen, or null when the dialog is dismissed.
 */
export function askPagePosition(app: App, current: number, count: number): Promise<number | null> {
	return new Promise((resolve) => {
		new MovePageModal(app, current, count, resolve).open();
	});
}

class MovePageModal extends Modal {
	private answered = false;
	private value: string;

	constructor(
		app: App,
		private readonly current: number,
		private readonly count: number,
		private readonly respond: (position: number | null) => void,
	) {
		super(app);
		this.value = String(current + 1);
	}

	override onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('Move page');
		const submit = (): void => {
			const n = Number.parseInt(this.value, 10);
			if (!Number.isInteger(n) || n < 1 || n > this.count) return;
			this.answered = true;
			this.respond(n - 1);
			this.close();
		};
		new Setting(contentEl)
			.setName('Position')
			.setDesc(`Where the page should be, from 1 to ${String(this.count)}. It is page ${String(this.current + 1)} now.`)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = String(this.count);
				text.setValue(this.value).onChange((value) => {
					this.value = value;
				});
				text.inputEl.addEventListener('keydown', (evt) => {
					if (evt.key === 'Enter') {
						evt.preventDefault();
						submit();
					}
				});
				window.setTimeout(() => {
					text.inputEl.select();
				}, 0);
			});
		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => {
					this.close();
				}),
			)
			.addButton((button) => button.setButtonText('Move').setCta().onClick(submit));
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.respond(null);
	}
}
