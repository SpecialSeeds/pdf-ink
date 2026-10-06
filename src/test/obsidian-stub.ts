/**
 * Minimal stand-ins for the Obsidian runtime, used only by unit tests.
 *
 * The real `obsidian` package ships types but no runtime, so vitest aliases
 * imports of it to this module (see vitest.config.ts).
 */

export class Notice {
	/** Every message raised during a test, for assertions. */
	static readonly messages: string[] = [];

	static reset(): void {
		Notice.messages.length = 0;
	}

	constructor(message: string) {
		Notice.messages.push(message);
	}
}

export interface Debouncer<T extends unknown[], V> {
	(...args: [...T]): Debouncer<T, V>;
	cancel(): Debouncer<T, V>;
	run(): V | void;
}

/** Same contract as Obsidian's `debounce`, including `cancel` and `run`. */
export function debounce<T extends unknown[], V>(
	cb: (...args: [...T]) => V,
	timeout = 0,
	resetTimer = false,
): Debouncer<T, V> {
	let handle: ReturnType<typeof setTimeout> | null = null;
	let pending: [...T] | null = null;

	const debounced = ((...args: [...T]) => {
		pending = args;
		if (handle !== null) {
			if (!resetTimer) return debounced;
			clearTimeout(handle);
		}
		handle = setTimeout(() => {
			handle = null;
			const call = pending;
			pending = null;
			if (call) cb(...call);
		}, timeout);
		return debounced;
	}) as Debouncer<T, V>;

	debounced.cancel = () => {
		if (handle !== null) {
			clearTimeout(handle);
			handle = null;
		}
		pending = null;
		return debounced;
	};

	debounced.run = () => {
		if (handle === null) return undefined;
		clearTimeout(handle);
		handle = null;
		const call = pending;
		pending = null;
		return call ? cb(...call) : undefined;
	};

	return debounced;
}

/** Enough of the file classes for `instanceof` checks. */
export class TAbstractFile {
	path = '';
	name = '';
}
export class TFile extends TAbstractFile {
	basename = '';
	extension = '';
	stat = { mtime: 0, ctime: 0, size: 0 };
}
export class TFolder extends TAbstractFile {
	isRoot(): boolean {
		return this.path === '' || this.path === '/';
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
}

export const Platform = { isMobile: false, isDesktop: true };
