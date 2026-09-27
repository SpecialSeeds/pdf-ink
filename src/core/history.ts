/**
 * Undo/redo as a stack of generic operations. Pure.
 *
 * Four kinds cover everything a tool can do to a page: `add`, `remove`,
 * `transform` — which carries the whole item before and after, so moving,
 * resizing or recolouring all reuse the same machinery — and `replace`, for the
 * one-to-many case a sized erase produces.
 *
 * Three more cover the page list itself. `page-add` and `page-remove` each carry
 * both the page records and the items that go with them, so deleting a page and
 * tombstoning everything on it is one operation and one undo — a page that came
 * back empty would be worse than no undo at all.
 */

import type { Item } from './items';
import type { InsertedPage, PageKey } from './pages';

export interface ItemRef {
	readonly pageKey: PageKey;
	/** Position within that page's item list, read before any removal. */
	readonly index: number;
	readonly item: Item;
}

/** A whole-item replacement, matched by id. */
export interface ItemChange {
	readonly pageKey: PageKey;
	readonly before: Item;
	readonly after: Item;
}

/** A whole-page-record replacement, matched by id. */
export interface PageChange {
	readonly before: InsertedPage;
	readonly after: InsertedPage;
}

export type InkOperation =
	| { readonly kind: 'add'; readonly refs: readonly ItemRef[] }
	| { readonly kind: 'remove'; readonly refs: readonly ItemRef[] }
	| { readonly kind: 'transform'; readonly changes: readonly ItemChange[] }
	/**
	 * Swap one set of items for another in a single step — a sized erase cuts one
	 * stroke into several fragments, which is neither an add nor a remove.
	 */
	| {
			readonly kind: 'replace';
			readonly removed: readonly ItemRef[];
			readonly added: readonly ItemRef[];
		}
	/**
	 * An inserted page appearing, with any items that come back with it. A fresh
	 * insert carries none; the inverse of a deletion carries everything the page held.
	 */
	| {
			readonly kind: 'page-add';
			readonly pages: readonly InsertedPage[];
			readonly refs: readonly ItemRef[];
		}
	/** An inserted page and its items going away together. */
	| {
			readonly kind: 'page-remove';
			readonly pages: readonly InsertedPage[];
			readonly refs: readonly ItemRef[];
		}
	/** A page record edited in place — a template or size change. */
	| { readonly kind: 'page-transform'; readonly changes: readonly PageChange[] };

/** Enough to cover a long session without growing without bound. */
export const HISTORY_LIMIT = 200;

export class InkHistory {
	private readonly past: InkOperation[] = [];
	private readonly future: InkOperation[] = [];

	get canUndo(): boolean {
		return this.past.length > 0;
	}

	get canRedo(): boolean {
		return this.future.length > 0;
	}

	/** Record a new operation. Any redo history is no longer reachable. */
	push(operation: InkOperation): void {
		this.past.push(operation);
		if (this.past.length > HISTORY_LIMIT) this.past.shift();
		this.future.length = 0;
	}

	/** Move the newest operation onto the redo stack and hand it back. */
	undo(): InkOperation | undefined {
		const operation = this.past.pop();
		if (operation) this.future.push(operation);
		return operation;
	}

	/** Move the newest undone operation back and hand it over. */
	redo(): InkOperation | undefined {
		const operation = this.future.pop();
		if (operation) this.past.push(operation);
		return operation;
	}

	clear(): void {
		this.past.length = 0;
		this.future.length = 0;
	}
}

/** The operation that reverses `operation`. */
export function invert(operation: InkOperation): InkOperation {
	switch (operation.kind) {
		case 'add':
			return { kind: 'remove', refs: operation.refs };
		case 'remove':
			return { kind: 'add', refs: operation.refs };
		case 'transform':
			return {
				kind: 'transform',
				changes: operation.changes.map((change) => ({
					pageKey: change.pageKey,
					before: change.after,
					after: change.before,
				})),
			};
		case 'replace':
			return {
				kind: 'replace',
				removed: operation.added,
				added: operation.removed,
			};
		case 'page-add':
			return {
				kind: 'page-remove',
				pages: operation.pages,
				refs: operation.refs,
			};
		case 'page-remove':
			return { kind: 'page-add', pages: operation.pages, refs: operation.refs };
		case 'page-transform':
			return {
				kind: 'page-transform',
				changes: operation.changes.map((change) => ({
					before: change.after,
					after: change.before,
				})),
			};
	}
}

/**
 * Re-inserting several items must go in ascending index order, or an earlier
 * splice shifts the positions the later ones recorded.
 */
export function sortForInsert(refs: readonly ItemRef[]): ItemRef[] {
	return [...refs].sort(
		(a, b) =>
			(a.pageKey < b.pageKey ? -1 : a.pageKey > b.pageKey ? 1 : 0) ||
			a.index - b.index,
	);
}
