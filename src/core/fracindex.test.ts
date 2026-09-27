import { describe, expect, it } from 'vitest';
import { FIRST_KEY, isValidKey, keyBetween, keysBetween } from './fracindex';

describe('keyBetween', () => {
	it('starts an empty list mid-range, so there is room on both sides', () => {
		const first = keyBetween(null, null);
		expect(first).toBe('a0');
		expect(keyBetween(null, first) < first).toBe(true);
		expect(keyBetween(first, null) > first).toBe(true);
	});

	it('appends above the last key', () => {
		let last = FIRST_KEY;
		for (let i = 0; i < 200; i++) {
			const next = keyBetween(last, null);
			expect(next > last).toBe(true);
			last = next;
		}
	});

	it('prepends below the first key', () => {
		let first = FIRST_KEY;
		for (let i = 0; i < 200; i++) {
			const next = keyBetween(null, first);
			expect(next < first).toBe(true);
			first = next;
		}
	});

	it('inserts between two neighbours, repeatedly', () => {
		let lower = keyBetween(null, null);
		let upper = keyBetween(lower, null);
		for (let i = 0; i < 200; i++) {
			const mid = keyBetween(lower, upper);
			expect(lower < mid).toBe(true);
			expect(mid < upper).toBe(true);
			// Alternate sides so both the prefix and the deepening path get exercised.
			if (i % 2 === 0) lower = mid;
			else upper = mid;
		}
	});

	it('stays lexicographically sorted for a shuffled sequence of inserts', () => {
		// Build a list by always inserting at a pseudo-random position, then check
		// that sorting the keys reproduces the insertion order.
		const keys: string[] = [keyBetween(null, null)];
		let seed = 7;
		for (let i = 0; i < 300; i++) {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			const at = seed % (keys.length + 1);
			const before = at > 0 ? (keys[at - 1] ?? null) : null;
			const after = at < keys.length ? (keys[at] ?? null) : null;
			keys.splice(at, 0, keyBetween(before, after));
		}
		expect([...keys].sort()).toEqual(keys);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('never produces a fraction ending in the smallest digit', () => {
		// A trailing zero in the fraction would be a second spelling of a shorter
		// key, breaking the "always room below" property the algorithm relies on.
		// The integer part may well end in one — 'a0' is the first key of all.
		let key = keyBetween(null, null);
		for (let i = 0; i < 300; i++) {
			expect(isValidKey(key)).toBe(true);
			key = keyBetween(null, key);
		}
		let between = keyBetween('a1', 'a2');
		for (let i = 0; i < 300; i++) {
			expect(between.endsWith('0')).toBe(false);
			expect(isValidKey(between)).toBe(true);
			between = keyBetween('a1', between);
		}
	});

	it('is deterministic, so two devices inserting at one spot agree', () => {
		// This is the point of the scheme: the same neighbours give the same key on
		// both devices, so neither renumbers the other's page.
		expect(keyBetween('a1', 'a2')).toBe(keyBetween('a1', 'a2'));
		expect(keyBetween('a1', 'a2')).toBe('a1V');
		expect(keyBetween(null, 'a0')).toBe('Zz');
	});

	it('rejects bounds that are not in ascending order', () => {
		expect(() => keyBetween('a2', 'a1')).toThrow(/out of sequence/);
		expect(() => keyBetween('a1', 'a1')).toThrow(/out of sequence/);
	});

	it('rejects keys that are not valid fractions', () => {
		// A fraction may not end in the smallest digit: two spellings, one number.
		expect(() => keyBetween('a1V0', null)).toThrow(/invalid order key/);
		expect(() => keyBetween('', null)).toThrow(/invalid order key/);
		expect(() => keyBetween('a1!', null)).toThrow(/invalid order key/);
		// A head that claims more characters than the key has.
		expect(() => keyBetween(null, 'V1')).toThrow(/invalid order key/);
	});

	it('keeps keys short: appending never lengthens the key', () => {
		// The point of the integer part. A midpoint-only scheme grows by a character
		// every few appends, which would put 200-character keys in the sidecar.
		let last: string | null = null;
		let longest = 0;
		for (let i = 0; i < 5000; i++) {
			last = keyBetween(last, null);
			longest = Math.max(longest, last.length);
		}
		// 'a0'…'az', then 'b00'…'bzz', then 'c000': one character per 62x, not per
		// insert. The midpoint-only alternative reaches 200 characters here.
		expect(longest).toBe(4);
	});

	it('keeps keys short when prepending too', () => {
		let first: string | null = null;
		let longest = 0;
		for (let i = 0; i < 5000; i++) {
			first = keyBetween(null, first);
			longest = Math.max(longest, first.length);
		}
		expect(longest).toBe(4);
	});
});

describe('keysBetween', () => {
	it('returns ascending keys inside the bounds', () => {
		const keys = keysBetween('a1', 'a2', 4);
		expect(keys).toHaveLength(4);
		expect([...keys].sort()).toEqual(keys);
		for (const key of keys) {
			expect(key > 'a1').toBe(true);
			expect(key < 'a2').toBe(true);
		}
	});

	it('returns nothing for a count of zero', () => {
		expect(keysBetween(null, null, 0)).toEqual([]);
	});
});

describe('isValidKey', () => {
	it('accepts base-62 fractions with no trailing zero', () => {
		expect(isValidKey('a0')).toBe(true);
		expect(isValidKey('a1V')).toBe(true);
		expect(isValidKey('Zz')).toBe(true);
		expect(isValidKey('b00')).toBe(true);
	});

	it('rejects empty, zero-terminated and out-of-alphabet keys', () => {
		expect(isValidKey('')).toBe(false);
		expect(isValidKey('0')).toBe(false);
		// Head 'V' claims six characters.
		expect(isValidKey('V1')).toBe(false);
		expect(isValidKey('a1V0')).toBe(false);
		expect(isValidKey('a1.')).toBe(false);
		// The bottom of the range is reserved, so nothing can prepend before it.
		expect(isValidKey(`A${'0'.repeat(26)}`)).toBe(false);
	});
});
