import { describe, expect, it } from 'vitest';
import { InkStore } from './ink-store';
import { DEFAULT_PEN, createStroke } from './stroke';

describe('page versions', () => {
	it('move on only for the page whose items changed', () => {
		const store = new InkStore(() => 1);
		store.add('pdf:0', createStroke(DEFAULT_PEN, 'a'));
		store.add('pdf:1', createStroke(DEFAULT_PEN, 'b'));
		const first = store.pageVersion('pdf:0');
		const second = store.pageVersion('pdf:1');

		store.add('pdf:1', createStroke(DEFAULT_PEN, 'c'));
		store.removeById('pdf:1', 'b');
		expect(store.pageVersion('pdf:0')).toBe(first);
		expect(store.pageVersion('pdf:1')).toBeGreaterThan(second);
	});

	it('all move on when the whole document is replaced', () => {
		const store = new InkStore(() => 1);
		store.add('pdf:0', createStroke(DEFAULT_PEN, 'a'));
		const before = store.pageVersion('pdf:5');
		store.load(store.toData());
		expect(store.pageVersion('pdf:0')).toBeGreaterThan(before);
		expect(store.pageVersion('pdf:5')).toBeGreaterThan(before);
	});
});
