/**
 * Fractional indexing: order keys that can always be generated *between* two
 * neighbours without renumbering anything. Pure.
 *
 * Inserted pages are ordered by a string key rather than by a position, because
 * two devices inserting at the same spot must both survive a merge. Positions
 * cannot do that — both would claim index 3, and one would have to be renumbered,
 * which is an edit to a record the other device also edited. A key that sorts
 * between its neighbours makes the same insertion commutative: both keys are
 * kept, and display order is just a sort.
 *
 * A key is an integer part followed by an optional base-62 fraction, in an
 * alphabet whose digit order matches ASCII order, so plain string comparison is
 * numeric comparison. The integer part's first character encodes how long it is
 * ('a' means two characters, 'b' three, and so on, with 'A'–'Z' mirroring that
 * below zero), which is what keeps appending cheap: it increments the integer
 * instead of adding a digit to a fraction every time.
 *
 * This is the scheme described in Implementing Fractional Indexing
 * (observablehq.com/@dgreensp/implementing-fractional-indexing).
 */

/** Ascending in both digit value and ASCII, which is what makes sorting work. */
const DIGITS =
	'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const SMALLEST_DIGIT = DIGITS.charAt(0);
const LARGEST_DIGIT = DIGITS.charAt(DIGITS.length - 1);

/**
 * The one integer part that may not be used: it is the bottom of the range, so a
 * key holding it has nothing left to prepend before.
 */
const SMALLEST_INTEGER = `A${SMALLEST_DIGIT.repeat(26)}`;

/** The key handed to the first record, when there is nothing to sit between. */
export const FIRST_KEY = `a${SMALLEST_DIGIT}`;

function digitValue(char: string): number {
	const value = DIGITS.indexOf(char);
	if (value < 0) throw new Error(`pdf-ink: invalid order key digit "${char}"`);
	return value;
}

/**
 * How many characters the integer part beginning with `head` occupies.
 *
 * 'a' through 'z' count upwards from two, and 'A' through 'Z' mirror them going
 * down, so that ASCII order over heads is magnitude order over integers.
 */
function integerLength(head: string): number {
	if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
	if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
	throw new Error(`pdf-ink: invalid order key head "${head}"`);
}

function integerPart(key: string): string {
	const length = integerLength(key.charAt(0));
	if (length > key.length) {
		throw new Error(`pdf-ink: truncated order key "${key}"`);
	}
	return key.slice(0, length);
}

/** The next integer up, or null when the range is exhausted. */
function incrementInteger(value: string): string | null {
	const head = value.charAt(0);
	const digits = value.slice(1).split('');
	let carry = true;
	for (let i = digits.length - 1; carry && i >= 0; i--) {
		const next = digitValue(digits[i] ?? SMALLEST_DIGIT) + 1;
		if (next === DIGITS.length) digits[i] = SMALLEST_DIGIT;
		else {
			digits[i] = DIGITS.charAt(next);
			carry = false;
		}
	}
	if (!carry) return head + digits.join('');

	// Every digit rolled over, so the integer changes magnitude.
	if (head === 'Z') return FIRST_KEY;
	if (head === 'z') return null;
	const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
	// Above 'a' the integer gets longer; below it, shorter.
	if (nextHead > 'a') digits.push(SMALLEST_DIGIT);
	else digits.pop();
	return nextHead + digits.join('');
}

/** The next integer down, or null when the range is exhausted. */
function decrementInteger(value: string): string | null {
	const head = value.charAt(0);
	const digits = value.slice(1).split('');
	let borrow = true;
	for (let i = digits.length - 1; borrow && i >= 0; i--) {
		const next = digitValue(digits[i] ?? SMALLEST_DIGIT) - 1;
		if (next < 0) digits[i] = LARGEST_DIGIT;
		else {
			digits[i] = DIGITS.charAt(next);
			borrow = false;
		}
	}
	if (!borrow) return head + digits.join('');

	if (head === 'a') return `Z${LARGEST_DIGIT}`;
	if (head === 'A') return null;
	const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
	if (nextHead < 'Z') digits.push(LARGEST_DIGIT);
	else digits.pop();
	return nextHead + digits.join('');
}

export function isValidKey(key: string): boolean {
	if (key.length === 0) return false;
	// The bottom of the range is reserved: nothing could ever prepend before it.
	if (key === SMALLEST_INTEGER) return false;
	let integer: string;
	try {
		integer = integerPart(key);
	} catch {
		return false;
	}
	const fraction = key.slice(integer.length);
	// A trailing smallest digit is a second spelling of a shorter fraction.
	if (fraction.endsWith(SMALLEST_DIGIT)) return false;
	for (const char of key.slice(1)) {
		if (!DIGITS.includes(char)) return false;
	}
	return true;
}

/**
 * A key that sorts strictly between `before` and `after`.
 *
 * `null` means unbounded: `keyBetween(null, first)` prepends, `keyBetween(last,
 * null)` appends, and `keyBetween(null, null)` starts an empty list.
 *
 * Throws when the bounds are not in order — a caller that passes them backwards
 * has a bug that would otherwise surface much later as a scrambled page order.
 */
export function keyBetween(
	before: string | null,
	after: string | null,
): string {
	if (before !== null && !isValidKey(before)) {
		throw new Error(`pdf-ink: invalid order key "${before}"`);
	}
	if (after !== null && !isValidKey(after)) {
		throw new Error(`pdf-ink: invalid order key "${after}"`);
	}
	if (before !== null && after !== null && before >= after) {
		throw new Error(
			`pdf-ink: order keys out of sequence: "${before}" >= "${after}"`,
		);
	}

	if (before === null) {
		if (after === null) return FIRST_KEY;
		const integer = integerPart(after);
		const fraction = after.slice(integer.length);
		// Already at the bottom integer: the only room left is inside its fraction.
		if (integer === SMALLEST_INTEGER) return integer + midpoint('', fraction);
		// The integer alone already sorts below `after`, and is as short as it gets.
		if (integer < after) return integer;
		const down = decrementInteger(integer);
		if (down === null) throw new Error('pdf-ink: order keys exhausted below');
		return down;
	}

	if (after === null) {
		const integer = integerPart(before);
		const up = incrementInteger(integer);
		// Out of integers: fall back to subdividing the fraction.
		if (up === null) return integer + midpoint(before.slice(integer.length), null);
		return up;
	}

	const beforeInteger = integerPart(before);
	const afterInteger = integerPart(after);
	if (beforeInteger === afterInteger) {
		return (
			beforeInteger +
			midpoint(before.slice(beforeInteger.length), after.slice(afterInteger.length))
		);
	}
	const up = incrementInteger(beforeInteger);
	if (up === null) throw new Error('pdf-ink: order keys exhausted above');
	// The next integer up is the shortest key available, if it still fits below.
	if (up < after) return up;
	return beforeInteger + midpoint(before.slice(beforeInteger.length), null);
}

/** `count` keys in ascending order, all strictly between the bounds. */
export function keysBetween(
	before: string | null,
	after: string | null,
	count: number,
): string[] {
	const keys: string[] = [];
	let lower = before;
	for (let i = 0; i < count; i++) {
		const key = keyBetween(lower, after);
		keys.push(key);
		lower = key;
	}
	return keys;
}

/**
 * The shortest fraction strictly between `a` and `b`, where `''` is 0 and `null`
 * is 1. Fractions only — the integer part is handled by the caller.
 *
 * Recursive on the shared prefix: once two fractions agree on their first digits
 * the problem is the same one on what follows, so the prefix is carried through
 * untouched and the search only works on the part that differs.
 */
function midpoint(a: string, b: string | null): string {
	if (b !== null) {
		// Walk the common prefix. A shorter `a` is padded with the smallest digit,
		// which is what its missing places mean numerically.
		let n = 0;
		while (
			n < b.length &&
			(n < a.length ? a.charAt(n) : SMALLEST_DIGIT) === b.charAt(n)
		) {
			n += 1;
		}
		if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
	}

	const digitA = a.length > 0 ? digitValue(a.charAt(0)) : 0;
	const digitB = b !== null ? digitValue(b.charAt(0)) : DIGITS.length;

	// Room for a digit in between: take it and stop, which keeps fractions short.
	if (digitB - digitA > 1) {
		return DIGITS.charAt(Math.round(0.5 * (digitA + digitB)));
	}
	// Adjacent digits, and `b` has more to give: truncating it lands below it and
	// above `a`, because `a` starts with the smaller digit.
	if (b !== null && b.length > 1) return b.slice(0, 1);
	// Nothing for it but to go one place deeper on `a`'s side. `b` is either absent
	// or exactly one digit above, so anything after `a`'s first digit stays below it.
	return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}
