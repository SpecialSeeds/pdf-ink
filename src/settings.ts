import { type App, type Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
	DEFAULT_EXPORT_SUFFIX,
	type PdfInkSettings,
	SIZED_TOOLS,
} from './core/settings-schema';
import { QUICK_COLORS, SIZED_ERASER_RANGE, WIDTH_RANGES } from './core/tools';

export {
	type ToolbarSide,
	DEFAULT_SETTINGS,
	type DefaultZoomMode,
	type ExportMode,
	type PdfInkSettings,
	type SizedTool,
	mergeSettings,
} from './core/settings-schema';

/**
 * What the view needs from the plugin. Declared here rather than importing the
 * plugin class so `main.ts` stays the only module that knows the whole graph.
 */
export interface PdfInkHost {
	settings: PdfInkSettings;
	saveSettings(): Promise<void>;
	/** The view type that shows a PDF without ink, for leaving the ink view. */
	readonly plainPdfViewType: string;
}

const TOOL_LABELS: Record<string, string> = {
	pen: 'Pen',
	highlighter: 'Highlighter',
	shape: 'Shapes',
	text: 'Text',
};

export class PdfInkSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: Plugin & PdfInkHost,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.addViewingSection();
		this.addToolSection();
		this.addEraserSection();
		this.addExportSection();
		this.addDiagnosticsSection();
	}

	private save(): void {
		void this.plugin.saveSettings();
	}

	private addViewingSection(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('Viewing').setHeading();

		new Setting(containerEl)
			.setName('Use as the default PDF viewer')
			.setDesc(
				"Open every PDF in the ink view instead of Obsidian's own viewer. Turn this off to go back to the built-in viewer, and open the ink view per file from the command or the file menu.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openByDefault)
					.onChange((value) => {
						this.plugin.settings.openByDefault = value;
						this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Default zoom')
			.setDesc(
				'How a PDF is scaled when you open it for annotation. Reopening a tab restores the zoom you left it at.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('fit-width', 'Fit width')
					.addOption('actual-size', 'Actual size')
					.setValue(this.plugin.settings.defaultZoomMode)
					.onChange((value) => {
						this.plugin.settings.defaultZoomMode =
							value === 'actual-size' ? 'actual-size' : 'fit-width';
						this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Buffer pages')
			.setDesc(
				'How many pages on each side of the visible ones to keep rendered. Higher is smoother to scroll and uses more memory.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 3, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.bufferPages)
					.onChange((value) => {
						this.plugin.settings.bufferPages = value;
						this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Tool palette side')
			.setDesc(
				'Which edge the floating tool palette sits against. Put it under the hand that is not holding the pen.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('left', 'Left')
					.addOption('right', 'Right')
					.setValue(this.plugin.settings.toolbarSide)
					.onChange((value) => {
						this.plugin.settings.toolbarSide =
							value === 'right' ? 'right' : 'left';
						this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Palm rejection')
			.setDesc(
				'Once a pen has been seen, treat touches as scrolling rather than drawing. Turn this off on a device with no stylus, where every touch should draw.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.palmRejection)
					.onChange((value) => {
						this.plugin.settings.palmRejection = value;
						this.save();
					}),
			);
	}

	private addDiagnosticsSection(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('Diagnostics').setHeading();

		new Setting(containerEl)
			.setName('Show input diagnostics')
			.setDesc(
				'Overlay a live log of touch and stylus events on the document, with a button to copy it. For reporting problems with a pen or tablet.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.inputDiagnostics)
					.onChange((value) => {
						this.plugin.settings.inputDiagnostics = value;
						this.save();
					}),
			);
	}

	private addToolSection(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('Tool defaults').setHeading();

		for (const tool of ['pen', 'highlighter', 'shape', 'text'] as const) {
			new Setting(containerEl)
				.setName(`${TOOL_LABELS[tool] ?? tool} colour`)
				.addDropdown((dropdown) => {
					for (const color of QUICK_COLORS) {
						dropdown.addOption(color.value, color.name);
					}
					const current = this.plugin.settings.toolColors[tool];
					// A colour picked from the toolbar may not be one of the presets.
					if (!QUICK_COLORS.some((c) => c.value === current)) {
						dropdown.addOption(current, 'Custom');
					}
					dropdown.setValue(current).onChange((value) => {
						this.plugin.settings.toolColors[tool] = value;
						this.save();
					});
				})
				.addColorPicker((picker) =>
					picker
						.setValue(this.plugin.settings.toolColors[tool])
						.onChange((value) => {
							this.plugin.settings.toolColors[tool] = value;
							this.save();
							// Keep the dropdown in step with the picker.
							this.display();
						}),
				);
		}

		for (const tool of SIZED_TOOLS) {
			const range = WIDTH_RANGES[tool];
			new Setting(containerEl)
				.setName(`${TOOL_LABELS[tool] ?? tool} width`)
				.setDesc('In PDF points, so it scales with the page.')
				.addSlider((slider) =>
					slider
						.setLimits(range.min, range.max, range.step)
						.setDynamicTooltip()
						.setValue(this.plugin.settings.toolWidths[tool])
						.onChange((value) => {
							this.plugin.settings.toolWidths[tool] = value;
							this.save();
						}),
				);
		}

		new Setting(containerEl)
			.setName('Text size')
			.setDesc('In PDF points.')
			.addSlider((slider) =>
				slider
					.setLimits(WIDTH_RANGES.text.min, WIDTH_RANGES.text.max, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.textFontSize)
					.onChange((value) => {
						this.plugin.settings.textFontSize = value;
						this.save();
					}),
			);
	}

	private addEraserSection(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('Eraser').setHeading();

		new Setting(containerEl)
			.setName('Default mode')
			.setDesc(
				'Whole stroke removes an entire mark; sized rubs away only what the circle touches.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('stroke', 'Whole stroke')
					.addOption('sized', 'Sized')
					.setValue(this.plugin.settings.eraserMode)
					.onChange((value) => {
						this.plugin.settings.eraserMode =
							value === 'sized' ? 'sized' : 'stroke';
						this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Whole-stroke reach')
			.setDesc('How close to a mark you must be to delete it, in PDF points.')
			.addSlider((slider) =>
				slider
					.setLimits(
						WIDTH_RANGES.eraser.min,
						WIDTH_RANGES.eraser.max,
						WIDTH_RANGES.eraser.step,
					)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.eraserWidth)
					.onChange((value) => {
						this.plugin.settings.eraserWidth = value;
						this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Sized radius')
			.setDesc('In screen pixels, so it feels the same at any zoom.')
			.addSlider((slider) =>
				slider
					.setLimits(
						SIZED_ERASER_RANGE.min,
						SIZED_ERASER_RANGE.max,
						SIZED_ERASER_RANGE.step,
					)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.eraserRadiusPx)
					.onChange((value) => {
						this.plugin.settings.eraserRadiusPx = value;
						this.save();
					}),
			);
	}

	private addExportSection(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('Export').setHeading();

		new Setting(containerEl)
			.setName('Annotations')
			.setDesc(
				'Flatten draws annotations into the page: identical in every viewer, and not editable afterwards. Keep strokes editable writes them as standard PDF ink annotations instead, so other PDF apps can still select and change them. Shapes and text are always flattened.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('flatten', 'Flatten into the page')
					.addOption('native', 'Keep strokes editable')
					.setValue(this.plugin.settings.exportMode)
					.onChange((value) => {
						this.plugin.settings.exportMode =
							value === 'native' ? 'native' : 'flatten';
						this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Filename suffix')
			.setDesc(
				'Added before the extension, so the original is never overwritten.',
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_EXPORT_SUFFIX)
					.setValue(this.plugin.settings.exportSuffix)
					.onChange((value) => {
						// An empty suffix would export over the source PDF.
						this.plugin.settings.exportSuffix =
							value.trim().length > 0 ? value : DEFAULT_EXPORT_SUFFIX;
						this.save();
					}),
			);
	}
}
