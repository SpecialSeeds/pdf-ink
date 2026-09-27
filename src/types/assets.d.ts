/**
 * Binary assets inlined by esbuild's `base64` loader, so they ship inside
 * main.js rather than as separate files a plugin release cannot carry.
 */
declare module '*.ttf' {
	const base64: string;
	export default base64;
}
