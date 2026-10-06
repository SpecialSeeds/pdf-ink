/**
 * Searching transcripts. Pure.
 *
 * Matching is forgiving on purpose: a transcript is a machine's reading of
 * handwriting, and a query is typed in a hurry. LaTeX is reduced to what it
 * reads as ("\frac{dT}{dt}" is "dT/dt"), case and punctuation are loosened,
 * and a word may be one typo away.
 */

/** Commands dropped entirely: layout, not content. */
const SILENT = new Set(['left', 'right', 'big', 'bigg', 'Big', 'Bigg', 'displaystyle', 'textstyle', 'mathrm', 'mathbf', 'mathit', 'text', 'operatorname']);

/** LaTeX reduced to plain text: fractions as a/b, commands as their names, no markup. */
export function stripLatex(text: string): string {
	let s = text.replace(/\$\$?/g, ' ');
	// Innermost fractions first, so nested ones unwind cleanly.
	const frac = /\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
	for (let guard = 0; guard < 8 && frac.test(s); guard++) {
		frac.lastIndex = 0;
		s = s.replace(frac, '$1/$2');
	}
	s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt $1');
	s = s.replace(/\\cdot|\\times/g, '*');
	s = s.replace(/\\([A-Za-z]+)/g, (_m, name: string) => (SILENT.has(name) ? ' ' : ` ${name} `));
	s = s.replace(/[{}]/g, '');
	s = s.replace(/\\[,;:! ]/g, ' ');
	return s.replace(/\s+/g, ' ').trim();
}

/** Text as it is compared: LaTeX stripped, lower case, single spaces. */
export function normalizeForSearch(text: string): string {
	return stripLatex(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Letters and digits only: "dT / dt" and "dt/dt" agree here. */
function compact(text: string): string {
	return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

function words(text: string): string[] {
	return text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/**
 * Edit distance counting a swap of two neighbouring letters as one edit, the
 * commonest typo there is; more than `limit` reports `limit + 1`.
 */
function editDistance(a: string, b: string, limit: number): number {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let value = Math.min((rows[i - 1]?.[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (rows[i - 1]?.[j - 1] ?? 0) + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				value = Math.min(value, (rows[i - 2]?.[j - 2] ?? 0) + 1);
			}
			row.push(value);
			best = Math.min(best, value);
		}
		if (best > limit) return limit + 1;
		rows.push(row);
	}
	return rows[a.length]?.[b.length] ?? limit + 1;
}

/** How many typos a word of this length may carry. */
function allowance(word: string): number {
	return word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
}

/**
 * How well `line` answers `query`, or 0 when it does not. Higher is better:
 * the whole query appearing as typed beats it appearing with its spacing or
 * punctuation lost, which beats every word appearing, which beats words
 * matched only allowing for typos. Every query word has to match somehow.
 */
export function scoreLine(query: string, line: string): number {
	const q = normalizeForSearch(query);
	if (q.length === 0) return 0;
	const l = normalizeForSearch(line);
	if (l.includes(q)) return 1000 + Math.min(100, Math.round((q.length / Math.max(1, l.length)) * 100));
	const cq = compact(q);
	if (cq.length >= 2 && compact(l).includes(cq)) return 600;

	const lineWords = words(l);
	let score = 0;
	for (const word of words(q)) {
		if (l.includes(word)) {
			score += 20;
			continue;
		}
		const typos = allowance(word);
		if (typos > 0 && lineWords.some((w) => editDistance(word, w, typos) <= typos)) {
			score += 10;
			continue;
		}
		// A prefix, as a word half typed.
		if (word.length >= 3 && lineWords.some((w) => w.startsWith(word))) {
			score += 8;
			continue;
		}
		return 0;
	}
	return score;
}

export interface SearchEntry {
	/** The source's vault path. */
	readonly source: string;
	readonly page: number;
	readonly block: string | null;
	readonly text: string;
}

export interface SearchHit<T extends SearchEntry = SearchEntry> {
	readonly entry: T;
	readonly score: number;
}

/**
 * Every entry matching `query`, best first; ties keep their source, page and
 * line order, so a note reads top to bottom.
 */
export function searchEntries<T extends SearchEntry>(entries: readonly T[], query: string, limit = 200): SearchHit<T>[] {
	const hits: (SearchHit<T> & { order: number })[] = [];
	entries.forEach((entry, order) => {
		const score = scoreLine(query, entry.text);
		if (score > 0) hits.push({ entry, score, order });
	});
	hits.sort((a, b) => b.score - a.score || a.order - b.order);
	return hits.slice(0, limit).map(({ entry, score }) => ({ entry, score }));
}

/** Hits grouped by source, sources in order of their best hit. */
export function groupBySource<T extends SearchEntry>(hits: readonly SearchHit<T>[]): { source: string; hits: SearchHit<T>[] }[] {
	const groups = new Map<string, SearchHit<T>[]>();
	for (const hit of hits) {
		const list = groups.get(hit.entry.source) ?? [];
		list.push(hit);
		groups.set(hit.entry.source, list);
	}
	return [...groups].map(([source, list]) => ({ source, hits: list }));
}
