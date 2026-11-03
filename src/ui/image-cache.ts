/**
 * The pictures behind image items, decoded once and shared by every view.
 *
 * Renderers are synchronous and pictures are not, so a renderer asks for a
 * picture, gets nothing the first time, and the load starts. When it lands the
 * generation goes up, which is part of the painter's cache key, and listeners
 * repaint: the next paint draws it.
 */

/** Reads a picture's bytes by vault path; null when there is no such file. */
export type ImageLoader = (src: string) => Promise<ArrayBuffer | null>;

type Entry =
	| { readonly state: 'loading' }
	| { readonly state: 'ready'; readonly image: ImageBitmap }
	| { readonly state: 'missing' };

let loader: ImageLoader | null = null;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let generation = 0;

/** Set by the plugin on load, cleared on unload. */
export function setImageLoader(next: ImageLoader | null): void {
	loader = next;
	if (!next) {
		for (const entry of entries.values()) {
			if (entry.state === 'ready') entry.image.close();
		}
		entries.clear();
	}
}

/** Counts every picture that arrived or went, for a cache key. */
export function imageGeneration(): number {
	return generation;
}

/** Called whenever a picture arrives or is forgotten. Returns an unsubscribe. */
export function onImagesChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * The decoded picture, or null while it loads or when it cannot be found. A
 * picture that is not ready yet starts loading here.
 */
export function imageFor(src: string): ImageBitmap | null {
	const entry = entries.get(src);
	if (entry) return entry.state === 'ready' ? entry.image : null;
	entries.set(src, { state: 'loading' });
	void load(src);
	return null;
}

/** Whether a picture was looked for and is not there. */
export function isImageMissing(src: string): boolean {
	return entries.get(src)?.state === 'missing';
}

/** Drop a picture, so it is read again: the file changed, moved or appeared. */
export function forgetImage(src: string): void {
	const entry = entries.get(src);
	if (!entry) return;
	if (entry.state === 'ready') entry.image.close();
	entries.delete(src);
	changed();
}

/** Drop every picture that could not be found, so each is looked for again. */
export function retryMissingImages(): void {
	let any = false;
	for (const [src, entry] of entries) {
		if (entry.state !== 'missing') continue;
		entries.delete(src);
		any = true;
	}
	if (any) changed();
}

async function load(src: string): Promise<void> {
	let next: Entry = { state: 'missing' };
	try {
		const bytes = loader ? await loader(src) : null;
		if (bytes) next = { state: 'ready', image: await createImageBitmap(new Blob([bytes])) };
	} catch {
		// Unreadable or undecodable: drawn as missing.
	}
	// Forgotten while loading: a newer read has been asked for.
	if (entries.get(src)?.state !== 'loading') {
		if (next.state === 'ready') next.image.close();
		return;
	}
	entries.set(src, next);
	changed();
}

function changed(): void {
	generation += 1;
	for (const listener of listeners) listener();
}
