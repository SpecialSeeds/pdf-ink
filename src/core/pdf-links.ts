/**
 * A PDF's own links. Pure: pdf.js annotation data in, links and hits out.
 *
 * The source PDF is never modified; links are only read and followed.
 */

/** Where a link goes. */
export type LinkTarget =
	/** A place in this document: a destination array, or a name to look up. */
	| { readonly kind: 'dest'; readonly dest: string | readonly unknown[] }
	| { readonly kind: 'url'; readonly url: string }
	/** A named action: NextPage, PrevPage, FirstPage or LastPage. */
	| { readonly kind: 'named'; readonly action: NamedAction };

export type NamedAction = 'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage';

export interface PdfLink {
	/** [x1, y1, x2, y2] in PDF space, x1 < x2 and y1 < y2. */
	readonly rect: readonly [number, number, number, number];
	readonly target: LinkTarget;
}

const NAMED: readonly string[] = ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'];

/** Only these open outside the app; anything else in a PDF is not followed. */
const SAFE_SCHEMES = /^(https?|mailto):/i;

/**
 * The links among a page's annotations, as pdf.js reports them.
 *
 * Takes `unknown` because annotation data is loosely shaped and varies between
 * pdf.js versions; anything that is not a usable link is dropped.
 */
export function linksFrom(annotations: readonly unknown[]): PdfLink[] {
	const links: PdfLink[] = [];
	for (const raw of annotations) {
		if (typeof raw !== 'object' || raw === null) continue;
		const a = raw as Record<string, unknown>;
		if (a['subtype'] !== 'Link') continue;
		const rect = a['rect'];
		if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => typeof n === 'number')) continue;
		const [x1, y1, x2, y2] = rect as [number, number, number, number];
		const target = targetOf(a);
		if (!target) continue;
		links.push({
			rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
			target,
		});
	}
	return links;
}

function targetOf(a: Record<string, unknown>): LinkTarget | null {
	const dest = a['dest'];
	if (typeof dest === 'string' || Array.isArray(dest)) return { kind: 'dest', dest };
	const url = a['url'] ?? a['unsafeUrl'];
	if (typeof url === 'string' && SAFE_SCHEMES.test(url)) return { kind: 'url', url };
	const action = a['action'];
	if (typeof action === 'string' && NAMED.includes(action)) {
		return { kind: 'named', action: action as NamedAction };
	}
	return null;
}

/**
 * The link under a point in PDF space, allowing `slop` points around each.
 *
 * Where links overlap or a finger falls between two, the nearest wins, and a
 * point inside a link beats one beside it.
 */
export function linkAt(links: readonly PdfLink[], x: number, y: number, slop: number): PdfLink | null {
	let best: PdfLink | null = null;
	let bestDistance = Infinity;
	for (const link of links) {
		const [x1, y1, x2, y2] = link.rect;
		const dx = Math.max(x1 - x, 0, x - x2);
		const dy = Math.max(y1 - y, 0, y - y2);
		const distance = Math.hypot(dx, dy);
		if (distance <= slop && distance < bestDistance) {
			best = link;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * The PDF-space y a destination asks to show at the top of the view, or null
 * when it names only a page.
 *
 * `[page, /XYZ, left, top, zoom]`, `[page, /FitH, top]`, `[page, /FitBH, top]`
 * and `[page, /FitR, left, bottom, right, top]` carry one; the rest do not.
 */
export function destinationTop(dest: readonly unknown[]): number | null {
	const kind = dest[1];
	const name =
		typeof kind === 'object' && kind !== null ? (kind as { name?: unknown }).name : undefined;
	const at = (i: number): number | null => {
		const value = dest[i];
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	};
	switch (name) {
		case 'XYZ':
			return at(3);
		case 'FitH':
		case 'FitBH':
			return at(2);
		case 'FitR':
			return at(5);
		default:
			return null;
	}
}
