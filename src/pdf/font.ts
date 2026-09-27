import notoSansBase64 from '../assets/NotoSans-Subset.ttf';

/**
 * The font the exporter embeds.
 *
 * Noto Sans (SIL Open Font License, see NotoSans-LICENSE.txt), subset to Latin,
 * Latin Extended, Greek and the maths/symbol codepoints annotations actually use.
 * Subsetting takes it from 569 KB to ~44 KB, which matters because the bytes ride
 * inside main.js — an Obsidian plugin release carries no extra asset files.
 */
export function embeddedFontBytes(): Uint8Array {
	const binary = atob(notoSansBase64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
