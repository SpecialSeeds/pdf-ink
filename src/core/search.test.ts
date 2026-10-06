import { describe, expect, it } from 'vitest';
import { groupBySource, normalizeForSearch, scoreLine, searchEntries, stripLatex } from './search';

describe('stripLatex', () => {
	it('reads a fraction as a/b and drops the markup', () => {
		expect(stripLatex('$\\frac{dT}{dt} = -k(T - T_0)$')).toBe('dT/dt = -k(T - T_0)');
		expect(stripLatex('$\\frac{\\frac{a}{b}}{c}$')).toBe('a/b/c');
		expect(stripLatex('$\\left( \\alpha \\cdot x \\right)$')).toBe('( alpha * x )');
	});
});

describe('scoreLine', () => {
	const line = "Newton's law of cooling: $\\frac{dT}{dt} = -k(T - T_0)$";

	it('finds "dT/dt" in a LaTeX fraction', () => {
		expect(scoreLine('dT/dt', line)).toBeGreaterThan(0);
		expect(scoreLine('dt / dt', line)).toBeGreaterThan(0);
	});

	it('forgives a typo and a half typed word', () => {
		expect(scoreLine('newtons cooling', line)).toBeGreaterThan(0);
		expect(scoreLine('coolng', line)).toBeGreaterThan(0);
		expect(scoreLine('newt', line)).toBeGreaterThan(0);
	});

	it('wants every word', () => {
		expect(scoreLine('cooling banana', line)).toBe(0);
		expect(scoreLine('', line)).toBe(0);
	});

	it('ranks the phrase as typed above its words apart, above typos', () => {
		const exact = scoreLine('law of cooling', line);
		const apart = scoreLine('cooling law', line);
		const typo = scoreLine('coolign law', line);
		expect(exact).toBeGreaterThan(apart);
		expect(apart).toBeGreaterThan(typo);
		expect(typo).toBeGreaterThan(0);
	});
});

describe('searchEntries', () => {
	const entries = [
		{ source: 'a.inknote', page: 1, block: 'B1', text: 'Proportionality: A = kB' },
		{ source: 'b.inknote', page: 2, block: 'B3', text: 'cooling of coffee: $\\frac{dT}{dt}$' },
		{ source: 'a.inknote', page: 3, block: 'B2', text: 'Newton\'s law of cooling' },
		{ source: 'c.pdf', page: 1, block: 'B1', text: 'nothing relevant' },
	];

	it('ranks best first and drops what does not match', () => {
		const hits = searchEntries(entries, 'law of cooling');
		expect(hits.map((h) => `${h.entry.source}:${String(h.entry.page)}`)).toEqual(['a.inknote:3']);
		// Both match as typed; the one where the match is more of its line ranks first.
		const broad = searchEntries(entries, 'cooling');
		expect(broad.map((h) => h.entry.source)).toEqual(['a.inknote', 'b.inknote']);
	});

	it('groups hits by source, in order of each source\'s best hit', () => {
		// a.inknote matches twice ("law" on page 3 and "A = kB" on page 1), b once.
		const hits = searchEntries(entries, 'k');
		const groups = groupBySource(hits);
		expect(groups.map((g) => g.source)[0]).toBe(hits[0]?.entry.source);
		const a = groups.find((g) => g.source === 'a.inknote');
		expect(a?.hits.length).toBe(hits.filter((h) => h.entry.source === 'a.inknote').length);
		expect(new Set(groups.map((g) => g.source)).size).toBe(groups.length);
	});

	it('normalizes queries the same way as lines', () => {
		expect(normalizeForSearch('  dT/DT ')).toBe('dt/dt');
	});
});
