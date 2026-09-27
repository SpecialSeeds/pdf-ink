import { type Component, Notice, Platform } from 'obsidian';

/** Lines kept on screen. Enough to cover a gesture, short enough to read. */
const MAX_LINES = 14;

/** Lines kept for copying, which wants the run-up as well as the moment. */
const MAX_HISTORY = 400;

/**
 * A live readout of what the touchscreen and stylus are actually reporting.
 *
 * Input bugs on a tablet are close to undebuggable from a desk: the same code
 * behaves differently on WebKit, the pointer type is not always what it claims,
 * and the only evidence is what the device says at the moment it misbehaves. This
 * puts that evidence on screen, and on the clipboard.
 *
 * Off unless switched on in settings, and it costs nothing when off — the ink
 * layer checks before it formats anything.
 */
export class InputDiagnostics {
	private readonly rootEl: HTMLElement;
	private readonly logEl: HTMLElement;
	private readonly history: string[] = [];
	private enabled = false;
	private readonly startedAt = Date.now();

	constructor(
		parentEl: HTMLElement,
		private readonly component: Component,
	) {
		this.rootEl = parentEl.createDiv({ cls: 'pdf-ink-diagnostics is-hidden' });

		const headerEl = this.rootEl.createDiv({
			cls: 'pdf-ink-diagnostics-header',
		});
		headerEl.createSpan({ text: 'Input diagnostics' });

		const copyEl = headerEl.createEl('button', {
			cls: 'pdf-ink-diagnostics-button',
			text: 'Copy',
			attr: { type: 'button' },
		});
		this.component.registerDomEvent(copyEl, 'click', () => {
			void this.copy();
		});

		const clearEl = headerEl.createEl('button', {
			cls: 'pdf-ink-diagnostics-button',
			text: 'Clear',
			attr: { type: 'button' },
		});
		this.component.registerDomEvent(clearEl, 'click', () => {
			this.history.length = 0;
			this.logEl.empty();
		});

		this.logEl = this.rootEl.createDiv({ cls: 'pdf-ink-diagnostics-log' });
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.rootEl.toggleClass('is-hidden', !enabled);
		if (enabled && this.history.length === 0) {
			this.log('ready', { note: 'tap, draw, or rest a palm to record' });
		}
	}

	/**
	 * Record one event. `fields` is rendered as `key=value`, so a line stays short
	 * enough to read on a phone and to paste into a bug report.
	 */
	log(event: string, fields: Record<string, string | number | boolean>): void {
		if (!this.enabled) return;
		const parts = Object.entries(fields).map(
			([key, value]) => `${key}=${String(value)}`,
		);
		const at = Date.now() - this.startedAt;
		const line = `${String(at).padStart(6)}ms ${event} ${parts.join(' ')}`;

		this.history.push(line);
		if (this.history.length > MAX_HISTORY) this.history.shift();

		this.logEl.createDiv({ cls: 'pdf-ink-diagnostics-line', text: line });
		while (this.logEl.childElementCount > MAX_LINES) {
			this.logEl.firstElementChild?.remove();
		}
		// Newest at the bottom, always in view.
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	/** What kind of device this is, which is most of what a report needs. */
	private static describePlatform(): string {
		const flags: [string, boolean][] = [
			['desktop', Platform.isDesktopApp],
			['mobile', Platform.isMobileApp],
			['ios', Platform.isIosApp],
			['android', Platform.isAndroidApp],
			['tablet', Platform.isTablet],
			['phone', Platform.isPhone],
			['macos', Platform.isMacOS],
			['win', Platform.isWin],
			['linux', Platform.isLinux],
			['safari', Platform.isSafari],
		];
		return flags
			.filter(([, on]) => on)
			.map(([name]) => name)
			.join(' ');
	}

	private async copy(): Promise<void> {
		const text = [
			`pdf-ink input diagnostics (${String(this.history.length)} lines)`,
			`platform: ${InputDiagnostics.describePlatform()}`,
			'',
			...this.history,
		].join('\n');
		try {
			await navigator.clipboard.writeText(text);
			new Notice('Input diagnostics copied.');
		} catch (err) {
			// The log is the point, so put it somewhere retrievable regardless.
			console.error('pdf-ink: could not copy diagnostics\n', text, err);
			new Notice('Could not copy. The log was written to the console.');
		}
	}
}
