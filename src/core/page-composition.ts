/**
 * Splicing inserted pages into a document's original pages. Pure.
 *
 * The source document supplies geometry for its own pages and knows nothing about
 * insertions; the sidecar supplies page records and knows nothing about pdf.js.
 * This is the single place the two are put in order, and it is used by the viewer
 * and by the exporter so they cannot disagree about what page 4 is.
 */

import type { HeaderText } from './header';
import { syntheticViewport } from './page-viewport';
import {
	type InsertedPage,
	type PageKey,
	type PageSize,
	type PageSlot,
	insertedPageKey,
	orderPages,
	pageOrigin,
} from './pages';
import type { PageGeometry } from '../types/view';

/** Geometry for one inserted page, standing in for a pdf.js page. */
export function insertedGeometry(page: InsertedPage, header?: HeaderText): PageGeometry {
	const origin = pageOrigin(page);
	const baseViewport = syntheticViewport(
		page.size.width,
		page.size.height,
		1,
		0,
		0,
		origin.x,
		origin.y,
	);
	return {
		key: insertedPageKey(page.id),
		source: header ? { kind: 'inserted', page, header } : { kind: 'inserted', page },
		baseViewport,
		baseWidth: baseViewport.width,
		baseHeight: baseViewport.height,
		rotation: 0,
	};
}

/**
 * The document's pages in display order.
 *
 * A record whose page is missing from `pdfGeometry` is skipped rather than
 * substituted: `orderPages` already parks out-of-range insertions at the end, so
 * reaching this case means the two sides genuinely disagree.
 */
export function composePages(
	pdfGeometry: readonly PageGeometry[],
	inserted: readonly InsertedPage[],
	/** A notebook's title header, drawn on whatever page comes first. */
	header?: HeaderText,
): PageGeometry[] {
	const composed: PageGeometry[] = [];
	for (const slot of orderPages(pdfGeometry.length, inserted)) {
		if (slot.kind === 'inserted') {
			composed.push(insertedGeometry(slot.page, slot.index === 0 ? header : undefined));
			continue;
		}
		const geom = pdfGeometry[slot.pdfIndex];
		if (geom) composed.push(geom);
	}
	return composed;
}

/**
 * A signature that changes exactly when the page list needs rebuilding.
 *
 * Compared instead of diffing records: a page's key, its size and its template are
 * the only things the viewer's layout and rasterisation depend on, so anything else
 * changing — an item edited, a stroke added — must not cost a structural rebuild.
 */
export function pagesSignature(geometry: readonly PageGeometry[]): string {
	return geometry
		.map((geom) => {
			const size = `${geom.baseWidth.toFixed(3)}x${geom.baseHeight.toFixed(3)}`;
			const inserted = geom.source.kind === 'inserted' ? geom.source.page : null;
			const template = inserted?.template ?? '';
			// A board grown downward keeps its size key's height change, but its
			// origin moves too, and every point on it maps differently.
			const origin = inserted ? pageOrigin(inserted) : { x: 0, y: 0 };
			// A header changes what the page shows: a rename or a new date format.
			const header = geom.source.kind === 'inserted' ? geom.source.header : undefined;
			const heading = header ? `|${header.title}|${header.date}` : '';
			return `${geom.key}|${size}|${template}|${origin.x.toFixed(3)},${origin.y.toFixed(3)}${heading}`;
		})
		.join(',');
}

/** The size of each page in display order, for `sizeForInsertion`. */
export function pageSizes(
	geometry: readonly PageGeometry[],
): Map<PageKey, PageSize> {
	const sizes = new Map<PageKey, PageSize>();
	for (const geom of geometry) {
		sizes.set(geom.key, { width: geom.baseWidth, height: geom.baseHeight });
	}
	return sizes;
}

/** Look a slot's size up in the map `pageSizes` produced. */
export function sizeLookup(
	sizes: ReadonlyMap<PageKey, PageSize>,
): (slot: PageSlot) => PageSize | undefined {
	return (slot) => sizes.get(slot.key);
}
