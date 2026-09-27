/**
 * Splicing inserted pages into a document's original pages. Pure.
 *
 * The source document supplies geometry for its own pages and knows nothing about
 * insertions; the sidecar supplies page records and knows nothing about pdf.js.
 * This is the single place the two are put in order, and it is used by the viewer
 * and by the exporter so they cannot disagree about what page 4 is.
 */

import { syntheticViewport } from './page-viewport';
import {
	type InsertedPage,
	type PageKey,
	type PageSize,
	type PageSlot,
	insertedPageKey,
	orderPages,
} from './pages';
import type { PageGeometry } from '../types/view';

/** Geometry for one inserted page, standing in for a pdf.js page. */
export function insertedGeometry(page: InsertedPage): PageGeometry {
	const baseViewport = syntheticViewport(page.size.width, page.size.height);
	return {
		key: insertedPageKey(page.id),
		source: { kind: 'inserted', page },
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
): PageGeometry[] {
	const composed: PageGeometry[] = [];
	for (const slot of orderPages(pdfGeometry.length, inserted)) {
		if (slot.kind === 'inserted') {
			composed.push(insertedGeometry(slot.page));
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
			const template =
				geom.source.kind === 'inserted' ? geom.source.page.template : '';
			return `${geom.key}|${size}|${template}`;
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
