import type { Component } from 'obsidian';

/**
 * Tracks the device pixel ratio of the window an element actually lives in.
 *
 * Reading the global `devicePixelRatio` is wrong here: an Obsidian leaf can be
 * dragged into a popout window on a monitor with a different ratio, and the
 * bitmaps have to be re-rasterised when that happens.
 */
export class DprWatcher {
	private current: number;
	private query: MediaQueryList | null = null;
	private readonly onQueryChange = (): void => {
		this.refresh();
	};

	constructor(
		private readonly component: Component,
		private readonly el: HTMLElement,
		private readonly onChange: (dpr: number) => void,
	) {
		this.current = el.win.devicePixelRatio || 1;
	}

	get value(): number {
		return this.current;
	}

	start(): void {
		this.rewatch();

		this.component.register(
			this.el.onWindowMigrated(() => {
				this.refresh();
			}),
		);
		// Backstop: some setups do not fire the resolution media query.
		this.component.registerDomEvent(this.el.win, 'resize', () => {
			this.refresh();
		});
		this.component.register(() => {
			this.unwatch();
		});
	}

	private rewatch(): void {
		this.unwatch();
		// An exact-resolution query, so it has to be recreated after each change:
		// once the ratio moves away, it stays false forever.
		const query = this.el.win.matchMedia(
			`(resolution: ${String(this.current)}dppx)`,
		);
		query.addEventListener('change', this.onQueryChange);
		this.query = query;
	}

	private unwatch(): void {
		this.query?.removeEventListener('change', this.onQueryChange);
		this.query = null;
	}

	private refresh(): void {
		const next = this.el.win.devicePixelRatio || 1;
		if (next === this.current) return;
		this.current = next;
		this.rewatch();
		this.onChange(next);
	}
}
