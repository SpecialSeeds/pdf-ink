import type { PDFDocument, PDFPage } from 'pdf-lib';
import { polylineBounds } from '../core/hit-test';
import type { Stroke } from '../core/items';

/** Padding around a stroke's points so the nib is not clipped by the Rect. */
function padding(stroke: Stroke): number {
	return stroke.width / 2 + 1;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/**
 * The appearance stream content: the stroke's centreline, stroked at its width.
 *
 * An /Ink annotation is legal without an /AP, and Acrobat will synthesise one
 * from InkList. Many other viewers will not, and would show nothing at all — so
 * one is written here, which costs little and makes the file render everywhere
 * while staying editable.
 */
function appearanceContent(stroke: Stroke): string {
	const parts: string[] = ['q', '/GS0 gs', `${round(stroke.width)} w`, '1 J', '1 j'];
	stroke.points.forEach(([x, y], index) => {
		parts.push(`${round(x)} ${round(y)} ${index === 0 ? 'm' : 'l'}`);
	});
	parts.push('S', 'Q');
	return parts.join('\n');
}

/**
 * Write a stroke as a native `/Annot /Subtype /Ink`.
 *
 * The geometry goes in `InkList` in PDF user space, which is what keeps the
 * stroke selectable and editable in Acrobat and Preview rather than being fused
 * into the page content.
 */
export function addInkAnnotation(
	doc: PDFDocument,
	page: PDFPage,
	stroke: Stroke,
): boolean {
	const bounds = polylineBounds(stroke.points);
	if (!bounds || stroke.points.length < 2) return false;

	const pad = padding(stroke);
	const rect = [
		round(bounds.minX - pad),
		round(bounds.minY - pad),
		round(bounds.maxX + pad),
		round(bounds.maxY + pad),
	];
	const { r, g, b } = colorComponents(stroke.color);

	// One entry per continuous path. A fragment from the eraser is its own stroke,
	// so there is always exactly one here.
	const inkList = [stroke.points.flatMap(([x, y]) => [round(x), round(y)])];

	const appearance = doc.context.stream(appearanceContent(stroke), {
		Type: 'XObject',
		Subtype: 'Form',
		FormType: 1,
		BBox: rect,
		Resources: {
			ExtGState: {
				GS0: {
					Type: 'ExtGState',
					ca: stroke.opacity,
					CA: stroke.opacity,
					// A highlighter multiplies with the page, as it does on screen.
					BM: stroke.tool === 'highlighter' ? 'Multiply' : 'Normal',
				},
			},
		},
		// A transparency group, so the blend mode composites against the page.
		Group: { Type: 'Group', S: 'Transparency', CS: 'DeviceRGB' },
	});

	const annotation = doc.context.obj({
		Type: 'Annot',
		Subtype: 'Ink',
		Rect: rect,
		InkList: inkList,
		C: [r, g, b],
		CA: stroke.opacity,
		BS: { W: round(stroke.width), S: 'S' },
		// Bit 3: print the annotation rather than treating it as screen-only.
		F: 4,
		AP: { N: doc.context.register(appearance) },
	});

	page.node.addAnnot(doc.context.register(annotation));
	return true;
}

function colorComponents(color: string): { r: number; g: number; b: number } {
	const hex = color.trim().replace('#', '');
	const full =
		hex.length === 3
			? hex
				  .split('')
				  .map((c) => c + c)
				  .join('')
			: hex;
	const value = Number.parseInt(full, 16);
	if (full.length !== 6 || Number.isNaN(value)) return { r: 0, g: 0, b: 0 };
	return {
		r: ((value >> 16) & 0xff) / 255,
		g: ((value >> 8) & 0xff) / 255,
		b: (value & 0xff) / 255,
	};
}
