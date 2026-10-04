import { type App, type Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
	DEFAULT_EXPORT_SUFFIX,
	type PdfInkSettings,
	SIZED_TOOLS,
} from './core/settings-schema';
import { QUICK_COLORS, SIZED_ERASER_RANGE, WIDTH_RANGES } from './core/tools';
import { PAGE_SIZE_LABELS, isNewPdfPageSize } from './core/new-pdf';
import { PAGE_TEMPLATES, TEMPLATE_LABELS, isPageTemplate } from './core/templates';
import { formatHeaderDate, isHeaderDateFormat } from './core/header';
import { contrastRatio } from './core/color';
import {
	DEFAULT_PAGE_THEMES,
	MIN_BASE_INK_CONTRAST,
	PAGE_THEME_KEYS,
	type PageThemeKey,
	THEME_NAMES,
	type ThemeName,
	effectiveThemes,
	emptyThemeOverrides,
	hasLowContrast,
} from './core/theme';

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

const THEME_LABELS: Record<ThemeName, string> = {
	light: 'Light pages',
	dark: 'Dark pages',
};

/** The setting's description, showing both formats on today's date. */
function formatExample(): string {
	const now = Date.now();
	return `How the date under a notebook title is written: "${formatHeaderDate(now, 'onenote')}" or "${formatHeaderDate(now, 'iso')}".`;
}

const THEME_KEY_LABELS: Record<PageThemeKey, { name: string; desc: string }> = {
	paper: { name: 'Paper', desc: 'The page background.' },
	grid: { name: 'Grid', desc: 'Template lines and dots.' },
	baseInk: {
		name: 'Base ink',
		desc: 'What black and white ink are drawn in. Every other colour shows as you chose it.',
	},
	headerMuted: {
		name: 'Header date',
		desc: "The date under a notebook's title.",
	},
};

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
		this.addNewPdfSection();
		this.addPageThemeSection();
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

	private addNewPdfSection(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('Creating files').setHeading();

		new Setting(containerEl)
			.setName('Page size')
			.setDesc('The size of a PDF made with the ribbon button or a folder\'s new PDF item.')
			.addDropdown((dropdown) => {
				for (const size of ['letter', 'a4'] as const) {
					dropdown.addOption(size, PAGE_SIZE_LABELS[size]);
				}
				dropdown
					.setValue(this.plugin.settings.newPdfPageSize)
					.onChange((value) => {
						if (isNewPdfPageSize(value)) {
							this.plugin.settings.newPdfPageSize = value;
							this.save();
						}
					});
			});

		new Setting(containerEl)
			.setName('Ruling')
			.setDesc('How a new PDF is ruled. Pages you add to it later take the same ruling.')
			.addDropdown((dropdown) => {
				for (const template of PAGE_TEMPLATES) {
					dropdown.addOption(template, TEMPLATE_LABELS[template]);
				}
				dropdown
					.setValue(this.plugin.settings.newPdfTemplate)
					.onChange((value) => {
						if (isPageTemplate(value)) {
							this.plugin.settings.newPdfTemplate = value;
							this.save();
						}
					});
			});

		new Setting(containerEl)
			.setName('Add title header to new notebooks')
			.setDesc(
				"Notebooks and boards start with the file's name as a title, the date and time they were made, and a rule beneath. Double-click the title to rename the file.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.addTitleHeader).onChange((value) => {
					this.plugin.settings.addTitleHeader = value;
					this.save();
				}),
			);

		new Setting(containerEl)
			.setName('Header date format')
			.setDesc(formatExample())
			.addDropdown((dropdown) =>
				dropdown
					.addOption('onenote', 'Weekday, date and time in words')
					.addOption('iso', 'Numeric: 2026-10-03 14:02')
					.setValue(this.plugin.settings.headerDateFormat)
					.onChange((value) => {
						if (isHeaderDateFormat(value)) {
							this.plugin.settings.headerDateFormat = value;
							this.save();
						}
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

	/**
	 * Colours of notebook and inserted pages in each theme. Only what the user
	 * changes is stored, so each value can go back to its default on its own.
	 */
	private addPageThemeSection(): void {
		const { containerEl } = this;
		new Setting(containerEl)
			.setName('Page themes')
			.setDesc(
				'Notebook and inserted pages, in the light and dark page theme. Pages of a PDF always stay as the PDF has them. Changes show in open tabs at once and are used for export.',
			)
			.setHeading();

		for (const name of THEME_NAMES) {
			new Setting(containerEl).setName(THEME_LABELS[name]).setHeading();
			const warningEl = containerEl.createDiv({
				cls: 'setting-item-description mod-warning pdf-ink-contrast-warning',
			});
			const updateWarning = (): void => {
				const theme = effectiveThemes(this.plugin.settings.pageThemes)[name];
				const ratio = contrastRatio(theme.baseInk, theme.paper) ?? 0;
				warningEl.setText(
					hasLowContrast(theme)
						? `Base ink on this paper has a contrast of ${ratio.toFixed(1)}:1, below the ${String(MIN_BASE_INK_CONTRAST)}:1 that keeps writing easy to read.`
						: '',
				);
				warningEl.toggle(hasLowContrast(theme));
			};

			for (const key of PAGE_THEME_KEYS) {
				const label = THEME_KEY_LABELS[key];
				new Setting(containerEl)
					.setName(label.name)
					.setDesc(label.desc)
					.addColorPicker((picker) =>
						picker
							.setValue(effectiveThemes(this.plugin.settings.pageThemes)[name][key])
							.onChange((value) => {
								this.plugin.settings.pageThemes[name][key] = value;
								updateWarning();
								this.save();
							}),
					)
					.addExtraButton((button) =>
						button
							.setIcon('rotate-ccw')
							.setTooltip(`Reset to default (${DEFAULT_PAGE_THEMES[name][key]})`)
							.onClick(() => {
								delete this.plugin.settings.pageThemes[name][key];
								this.save();
								this.display();
							}),
					);
			}
			// Under its theme's colours, where the problem is.
			containerEl.appendChild(warningEl);
			updateWarning();
		}

		new Setting(containerEl)
			.setName('Reset all page theme colours')
			.addButton((button) =>
				button.setButtonText('Reset all').onClick(() => {
					this.plugin.settings.pageThemes = emptyThemeOverrides();
					this.save();
					this.display();
				}),
			);
	}

	private addExportSection(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('Export').setHeading();

		new Setting(containerEl)
			.setName('Ask for theme on export')
			.setDesc(
				'Choose light or dark pages each time you export. When off, exports use the theme you chose last.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.askExportTheme)
					.onChange((value) => {
						this.plugin.settings.askExportTheme = value;
						this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Export theme')
			.setDesc('Used when the question is turned off, and preselected when it is asked.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('light', 'Light')
					.addOption('dark', 'Dark')
					.setValue(this.plugin.settings.exportTheme)
					.onChange((value) => {
						this.plugin.settings.exportTheme = value === 'dark' ? 'dark' : 'light';
						this.save();
					}),
			);

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
