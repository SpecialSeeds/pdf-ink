import { describe, expect, it } from 'vitest';
import {
	HISTORY_LIMIT,
	InkHistory,
	type InkOperation,
	type ItemChange,
	type ItemRef,
	invert,
	sortForInsert,
} from './history';
import type { Item } from './items';
import type { InsertedPage } from './pages';
import { pdfPageKey } from './pages';
import { DEFAULT_PEN, createStroke } from './stroke';

/** Takes a page number for brevity; the schema's key is `pdf:<n>`. */
function ref(page: number, index: number, id = `s${String(index)}`): ItemRef {
	return {
		pageKey: pdfPageKey(page),
		index,
		item: createStroke(DEFAULT_PEN, id),
	};
}

/** First ref's id, for operations that carry refs. */
function refIdOf(operation: InkOperation | undefined): string | undefined {
	if (!operation) return undefined;
	if (
		operation.kind === 'transform' ||
		operation.kind === 'page-transform' ||
		operation.kind === 'group'
	) {
		return undefined;
	}
	if (operation.kind === 'replace') return operation.removed[0]?.item.id;
	return operation.refs[0]?.item.id;
}

function recoloured(item: Item, color: string): Item {
	return { ...item, color };
}

function add(...refs: ItemRef[]): InkOperation {
	return { kind: 'add', refs };
}

describe('InkHistory', () => {
	it('starts with nothing to undo or redo', () => {
		const history = new InkHistory();
		expect(history.canUndo).toBe(false);
		expect(history.canRedo).toBe(false);
		expect(history.undo()).toBeUndefined();
		expect(history.redo()).toBeUndefined();
	});

	it('undoes in reverse order', () => {
		const history = new InkHistory();
		history.push(add(ref(0, 0, 'a')));
		history.push(add(ref(0, 1, 'b')));
		expect(refIdOf(history.undo())).toBe('b');
		expect(refIdOf(history.undo())).toBe('a');
		expect(history.canUndo).toBe(false);
	});

	it('redoes in forward order', () => {
		const history = new InkHistory();
		history.push(add(ref(0, 0, 'a')));
		history.push(add(ref(0, 1, 'b')));
		history.undo();
		history.undo();
		expect(refIdOf(history.redo())).toBe('a');
		expect(refIdOf(history.redo())).toBe('b');
		expect(history.canRedo).toBe(false);
	});

	it('a new operation discards the redo branch', () => {
		const history = new InkHistory();
		history.push(add(ref(0, 0, 'a')));
		history.undo();
		expect(history.canRedo).toBe(true);
		history.push(add(ref(0, 0, 'c')));
		expect(history.canRedo).toBe(false);
	});

	it('round-trips undo then redo back to the same state', () => {
		const history = new InkHistory();
		const op = add(ref(2, 3, 'x'));
		history.push(op);
		expect(history.undo()).toBe(op);
		expect(history.redo()).toBe(op);
		expect(history.canUndo).toBe(true);
		expect(history.canRedo).toBe(false);
	});

	it('caps the stack, dropping the oldest entries', () => {
		const history = new InkHistory();
		for (let i = 0; i < HISTORY_LIMIT + 50; i++) {
			history.push(add(ref(0, i, `s${String(i)}`)));
		}
		let depth = 0;
		while (history.undo()) depth += 1;
		expect(depth).toBe(HISTORY_LIMIT);
	});

	it('clear empties both directions', () => {
		const history = new InkHistory();
		history.push(add(ref(0, 0)));
		history.undo();
		history.push(add(ref(0, 1)));
		history.clear();
		expect(history.canUndo).toBe(false);
		expect(history.canRedo).toBe(false);
	});
});

describe('transform operations', () => {
	it('inverting a transform swaps before and after', () => {
		const item = createStroke(DEFAULT_PEN, 'a');
		const changes: ItemChange[] = [
			{ pageKey: 'pdf:0', before: item, after: recoloured(item, '#ff0000') },
		];
		const inverted = invert({ kind: 'transform', changes });
		expect(inverted.kind).toBe('transform');
		if (inverted.kind !== 'transform') return;
		expect(inverted.changes[0]?.before.color).toBe('#ff0000');
		expect(inverted.changes[0]?.after.color).toBe(DEFAULT_PEN.color);
	});

	it('inverting a transform twice is the identity', () => {
		const item = createStroke(DEFAULT_PEN, 'a');
		const op: InkOperation = {
			kind: 'transform',
			changes: [{ pageKey: 'pdf:2', before: item, after: recoloured(item, '#0f0') }],
		};
		expect(invert(invert(op))).toEqual(op);
	});

	it('carries the whole item on both sides, so any field can change', () => {
		const item = createStroke(DEFAULT_PEN, 'a');
		const moved: Item = { ...item, z: 7, rotation: 90, opacity: 0.5 };
		const op: InkOperation = {
			kind: 'transform',
			changes: [{ pageKey: 'pdf:0', before: item, after: moved }],
		};
		if (op.kind !== 'transform') return;
		expect(op.changes[0]?.after.z).toBe(7);
		expect(op.changes[0]?.after.rotation).toBe(90);
		expect(op.changes[0]?.before.z).toBe(item.z);
	});

	it('undo and redo return the transform unchanged', () => {
		const history = new InkHistory();
		const item = createStroke(DEFAULT_PEN, 'a');
		const op: InkOperation = {
			kind: 'transform',
			changes: [{ pageKey: 'pdf:0', before: item, after: recoloured(item, '#00f') }],
		};
		history.push(op);
		expect(history.undo()).toBe(op);
		expect(history.redo()).toBe(op);
	});
});

describe('invert', () => {
	it('swaps add and remove, keeping the refs', () => {
		const refs = [ref(0, 0, 'a'), ref(0, 1, 'b')];
		expect(invert({ kind: 'add', refs })).toEqual({ kind: 'remove', refs });
		expect(invert({ kind: 'remove', refs })).toEqual({ kind: 'add', refs });
	});

	it('is its own inverse', () => {
		const op = add(ref(1, 2, 'z'));
		expect(invert(invert(op))).toEqual(op);
	});
});

describe('grouped operations', () => {
	const page: InsertedPage = {
		id: 'p',
		afterPdfPage: -1,
		sortKey: 'a1',
		template: 'grid5',
		size: { width: 612, height: 792 },
		updatedAt: 1,
	};
	const pageAdd: InkOperation = { kind: 'page-add', pages: [page], refs: [] };

	it('joins an operation onto the newest step', () => {
		const history = new InkHistory();
		history.push(add(ref(0, 0, 'a')));
		history.pushJoined(pageAdd);
		const undone = history.undo();
		expect(undone).toEqual({ kind: 'group', operations: [add(ref(0, 0, 'a')), pageAdd] });
		expect(history.canUndo).toBe(false);
	});

	it('records on its own when there is nothing to join', () => {
		const history = new InkHistory();
		history.pushJoined(pageAdd);
		expect(history.undo()).toEqual(pageAdd);
	});

	it('inverts last-first', () => {
		const first = add(ref(0, 0, 'a'));
		const inverted = invert({ kind: 'group', operations: [first, pageAdd] });
		expect(inverted).toEqual({
			kind: 'group',
			operations: [invert(pageAdd), invert(first)],
		});
	});
});

describe('sortForInsert', () => {
	it('orders by page then index, so splices do not shift each other', () => {
		const sorted = sortForInsert([
			ref(1, 5, 'e'),
			ref(0, 2, 'b'),
			ref(1, 0, 'd'),
			ref(0, 0, 'a'),
		]);
		expect(sorted.map((r) => [r.pageKey, r.index])).toEqual([
			['pdf:0', 0],
			['pdf:0', 2],
			['pdf:1', 0],
			['pdf:1', 5],
		]);
	});

	it('does not mutate its input', () => {
		const refs = [ref(0, 3, 'b'), ref(0, 1, 'a')];
		sortForInsert(refs);
		expect(refs.map((r) => r.index)).toEqual([3, 1]);
	});
});

describe('replace operations', () => {
	it('inverting a replace swaps removed and added', () => {
		const removed = [ref(0, 0, 'original')];
		const added = [ref(0, 0, 'piece-a'), ref(0, 1, 'piece-b')];
		const inverted = invert({ kind: 'replace', removed, added });
		expect(inverted.kind).toBe('replace');
		if (inverted.kind !== 'replace') return;
		expect(inverted.removed).toEqual(added);
		expect(inverted.added).toEqual(removed);
	});

	it('inverting a replace twice is the identity', () => {
		const op: InkOperation = {
			kind: 'replace',
			removed: [ref(0, 0, 'a')],
			added: [ref(0, 0, 'b'), ref(0, 1, 'c')],
		};
		expect(invert(invert(op))).toEqual(op);
	});

	it('is one undo step however many fragments it produced', () => {
		const history = new InkHistory();
		history.push({
			kind: 'replace',
			removed: [ref(0, 0, 'a')],
			added: [ref(0, 0, 'f1'), ref(0, 1, 'f2'), ref(0, 2, 'f3')],
		});
		expect(history.undo()).toBeDefined();
		expect(history.canUndo).toBe(false);
	});
});

describe('page operations', () => {
	function page(id: string, template = 'blank'): InsertedPage {
		return {
			id,
			afterPdfPage: 0,
			sortKey: 'a0',
			template: template as InsertedPage['template'],
			size: { width: 595, height: 842 },
			updatedAt: 1000,
		};
	}

	it('inverts an insertion into a removal', () => {
		const op: InkOperation = {
			kind: 'page-add',
			pages: [page('p1')],
			refs: [],
		};
		expect(invert(op)).toEqual({
			kind: 'page-remove',
			pages: [page('p1')],
			refs: [],
		});
	});

	it('carries a deleted page and its items through the inverse together', () => {
		// The whole point of one operation: undoing a deletion must bring back the
		// page *and* what was on it, or the user gets an empty sheet back.
		const refs = [ref(0, 0, 'a'), ref(0, 1, 'b')];
		const op: InkOperation = {
			kind: 'page-remove',
			pages: [page('p1')],
			refs,
		};
		const inverse = invert(op);
		expect(inverse.kind).toBe('page-add');
		if (inverse.kind !== 'page-add') return;
		expect(inverse.pages).toEqual([page('p1')]);
		expect(inverse.refs).toBe(refs);
	});

	it('swaps a page edit both ways', () => {
		const op: InkOperation = {
			kind: 'page-transform',
			changes: [{ before: page('p1', 'blank'), after: page('p1', 'grid5') }],
		};
		const inverse = invert(op);
		expect(inverse.kind).toBe('page-transform');
		if (inverse.kind !== 'page-transform') return;
		expect(inverse.changes[0]?.before.template).toBe('grid5');
		expect(inverse.changes[0]?.after.template).toBe('blank');
	});

	it('is its own inverse, for all three kinds', () => {
		const operations: InkOperation[] = [
			{ kind: 'page-add', pages: [page('p1')], refs: [ref(0, 0, 'a')] },
			{ kind: 'page-remove', pages: [page('p1')], refs: [ref(0, 0, 'a')] },
			{
				kind: 'page-transform',
				changes: [{ before: page('p1', 'blank'), after: page('p1', 'dot') }],
			},
		];
		for (const op of operations) {
			expect(invert(invert(op))).toEqual(op);
		}
	});

	it('takes its place on the undo stack like any other operation', () => {
		const history = new InkHistory();
		history.push({ kind: 'add', refs: [ref(0, 0, 'a')] });
		history.push({ kind: 'page-remove', pages: [page('p1')], refs: [] });
		expect(history.undo()?.kind).toBe('page-remove');
		expect(history.undo()?.kind).toBe('add');
		expect(history.canUndo).toBe(false);
		expect(history.redo()?.kind).toBe('add');
	});
});
