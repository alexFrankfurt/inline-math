import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findDivisions, type DivisionMatch } from './math/division';
import { buildStackedFraction } from './math/stackedFraction';
import { divisionToLatex } from './math/latex';
import katex from 'katex';

let divisionDecorationType: vscode.TextEditorDecorationType | undefined;
let extensionRootUri: vscode.Uri | undefined;

type CachedMatches = {
	docUri: string;
	version: number;
	divisions: DivisionMatch[];
};

const matchCache = new Map<string, CachedMatches>();

function getConfig() {
	const config = vscode.workspace.getConfiguration('inlinemath');
	return {
		enabled: config.get<boolean>('enabled', true),
		divisionCodeLens: config.get<boolean>('division.codeLens', true),
		divisionPeekDefinition: config.get<boolean>('division.peekDefinition', true),
		previewEnabled: config.get<boolean>('preview.enabled', true),
		divisionInlineDecoration: config.get<boolean>('division.inlineDecoration', true),
		divisionHoverStacked: config.get<boolean>('division.hoverStackedFraction', true),
		divisionInlinePrefix: config.get<string>('division.inlinePrefix', '  ⟂  '),
	};
}

function ensureDecorationType() {
	if (divisionDecorationType) {
		return;
	}

	divisionDecorationType = vscode.window.createTextEditorDecorationType({
		after: {
			color: new vscode.ThemeColor('editorCodeLens.foreground'),
			fontStyle: 'italic',
			margin: '0 0 0 1.5em',
		},
	});
}

function clearDecorations(editor: vscode.TextEditor) {
	if (!divisionDecorationType) {
		return;
	}
	editor.setDecorations(divisionDecorationType, []);
}

function formatInlineFraction(numerator: string, denominator: string, prefix: string): string {
	const superscripts: Record<string, string> = {
		'0': '⁰',
		'1': '¹',
		'2': '²',
		'3': '³',
		'4': '⁴',
		'5': '⁵',
		'6': '⁶',
		'7': '⁷',
		'8': '⁸',
		'9': '⁹',
	};
	const subscripts: Record<string, string> = {
		'0': '₀',
		'1': '₁',
		'2': '₂',
		'3': '₃',
		'4': '₄',
		'5': '₅',
		'6': '₆',
		'7': '₇',
		'8': '₈',
		'9': '₉',
	};

	const toSuper = (value: string) => value.split('').map((ch) => superscripts[ch] ?? ch).join('');
	const toSub = (value: string) => value.split('').map((ch) => subscripts[ch] ?? ch).join('');

	// U+2044 FRACTION SLASH looks more “mathy” than '/'.
	// If both sides are integers, render as a two-level inline fraction: 5/10 => ⁵⁄₁₀.
	if (/^\d+$/.test(numerator) && /^\d+$/.test(denominator)) {
		return `${prefix}${toSuper(numerator)}⁄${toSub(denominator)}`;
	}

	return `${prefix}${numerator}⁄${denominator}`;
}

function updateForEditor(editor: vscode.TextEditor | undefined) {
	if (!editor) {
		return;
	}

	const config = getConfig();
	if (!config.enabled || editor.document.languageId !== 'java') {
		clearDecorations(editor);
		return;
	}

	ensureDecorationType();
	if (!divisionDecorationType) {
		return;
	}

	const key = editor.document.uri.toString();
	const cached = matchCache.get(key);
	let divisions: DivisionMatch[];

	if (cached && cached.version === editor.document.version) {
		divisions = cached.divisions;
	} else {
		divisions = findDivisions(editor.document);
		matchCache.set(key, { docUri: key, version: editor.document.version, divisions });
	}

	if (!config.divisionInlineDecoration) {
		clearDecorations(editor);
		return;
	}

	const decorations: vscode.DecorationOptions[] = divisions.map((m) => ({
		range: m.range,
		renderOptions: {
			after: {
				contentText: formatInlineFraction(m.numerator, m.denominator, config.divisionInlinePrefix),
			},
		},
	}));

	editor.setDecorations(divisionDecorationType, decorations);
}

const FRACTION_SCHEME = 'inlinemath-fraction';

function toFractionUri(match: DivisionMatch): vscode.Uri {
	const safeName = `${match.numerator}_over_${match.denominator}`.replace(/[^A-Za-z0-9_\-\.]/g, '_');
	const params = new URLSearchParams({
		n: match.numerator,
		d: match.denominator,
		expr: `${match.numerator}/${match.denominator}`,
	});
	return vscode.Uri.parse(`${FRACTION_SCHEME}:/${safeName}.txt?${params.toString()}`);
}

function parseFractionUri(uri: vscode.Uri): { numerator: string; denominator: string; expr: string } | undefined {
	if (uri.scheme !== FRACTION_SCHEME) {
		return;
	}
	const params = new URLSearchParams(uri.query);
	const numerator = params.get('n') ?? '';
	const denominator = params.get('d') ?? '';
	const expr = params.get('expr') ?? `${numerator}/${denominator}`;
	if (!numerator || !denominator) {
		return;
	}
	return { numerator, denominator, expr };
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function openMathPreview(numerator: string, denominator: string) {
	const config = getConfig();
	if (!config.enabled || !config.previewEnabled) {
		void vscode.window.showInformationMessage('InlineMath preview is disabled (see inlinemath.preview.enabled).');
		return;
	}
	// Note: webviews are their own sandbox; avoid assuming cwd/workspace layout.

	const latex = divisionToLatex(numerator, denominator);
	let htmlMath = '';
	try {
		htmlMath = katex.renderToString(latex, {
			throwOnError: false,
			displayMode: true,
		});
	} catch {
		htmlMath = `<pre>${latex}</pre>`;
	}

	// Inline KaTeX CSS to avoid any stylesheet loading edge cases.
	let katexDistFsDir = '';
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const katexCssFsPath: string = require.resolve('katex/dist/katex.min.css');
		katexDistFsDir = path.dirname(katexCssFsPath);
	} catch {
		// We'll fall back to empty CSS (MathML-only rendering).
		katexDistFsDir = '';
	}

	const panel = vscode.window.createWebviewPanel(
		'inlinemath.preview',
		`InlineMath: ${numerator}/${denominator}`,
		vscode.ViewColumn.Beside,
		{
			enableScripts: false,
			localResourceRoots: katexDistFsDir
				? [vscode.Uri.file(katexDistFsDir), vscode.Uri.file(path.join(katexDistFsDir, 'fonts'))]
				: [],
		}
	);

	const katexCssPath = katexDistFsDir ? vscode.Uri.file(path.join(katexDistFsDir, 'katex.min.css')) : undefined;
	let katexCss = '';
	try {
		if (katexCssPath) {
			katexCss = fs.readFileSync(katexCssPath.fsPath, 'utf8');
		}
		// Rewrite relative font urls (fonts/...) to webview-safe URIs.
		katexCss = katexCss.replace(/url\((['"]?)(fonts\/[^)'"]+)\1\)/g, (_m, quote: string, rel: string) => {
			if (!katexDistFsDir) {
				return `url(${quote}${rel}${quote})`;
			}
			const fontUri = vscode.Uri.file(path.join(katexDistFsDir, rel.replace(/\//g, path.sep)));
			const webviewFontUri = panel.webview.asWebviewUri(fontUri);
			return `url(${quote}${webviewFontUri.toString()}${quote})`;
		});
	} catch {
		katexCss = '';
	}

	panel.webview.html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource} data:;" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
			${katexCss}
			body { padding: 16px; }
			.katex-display { margin: 0; }
			.hint { opacity: 0.75; font-family: var(--vscode-font-family); font-size: 12px; margin-top: 16px; }
      code { font-family: var(--vscode-editor-font-family); }
    </style>
  </head>
  <body>
    ${htmlMath}
		<div class="hint">LaTeX: <code>${escapeHtml(latex)}</code></div>
  </body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
	extensionRootUri = context.extensionUri;
	ensureDecorationType();

	const codeLensChanged = new vscode.EventEmitter<void>();
	context.subscriptions.push(codeLensChanged);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(FRACTION_SCHEME, {
			provideTextDocumentContent(uri: vscode.Uri): string {
				const parsed = parseFractionUri(uri);
				if (!parsed) {
					return 'InlineMath: invalid fraction URI.';
				}

				const stacked = buildStackedFraction(parsed.numerator, parsed.denominator);
				const latex = divisionToLatex(parsed.numerator, parsed.denominator);
				return [
					stacked,
					'',
					`LaTeX: ${latex}`,
				].join('\n');
			},
		})
	);

	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider({ language: 'java' }, {
			provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
				const config = getConfig();
				if (!config.enabled || !config.divisionPeekDefinition) {
					return;
				}

				const key = document.uri.toString();
				const cached = matchCache.get(key);
				const divisions = cached && cached.version === document.version ? cached.divisions : findDivisions(document);
				const match = divisions.find((m) => m.range.contains(position));
				if (!match) {
					return;
				}

				const targetUri = toFractionUri(match);
				return [
					{
						originSelectionRange: match.range,
						targetUri,
						targetRange: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
						targetSelectionRange: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
					},
				] as vscode.LocationLink[];
			},
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('inlinemath.peekFraction', (range?: vscode.Range) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'java') {
				return;
			}
			if (range instanceof vscode.Range) {
				editor.selection = new vscode.Selection(range.start, range.start);
			}
			// Use the built-in Peek Definition UI, which will call our DefinitionProvider.
			void vscode.commands.executeCommand('editor.action.peekDefinition');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('inlinemath.openMathPreview', (numerator?: string, denominator?: string, range?: vscode.Range) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'java') {
				return;
			}

			if (typeof numerator === 'string' && typeof denominator === 'string') {
				openMathPreview(numerator, denominator);
				return;
			}

			// Fallback: infer from the current cursor/range.
			const config = getConfig();
			if (!config.enabled) {
				return;
			}

			if (range instanceof vscode.Range) {
				editor.selection = new vscode.Selection(range.start, range.start);
			}
			const divisions = findDivisions(editor.document);
			const match = divisions.find((m) => m.range.contains(editor.selection.active));
			if (!match) {
				return;
			}
			openMathPreview(match.numerator, match.denominator);
		})
	);

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ language: 'java' }, new (class implements vscode.CodeLensProvider {
			public readonly onDidChangeCodeLenses = codeLensChanged.event;

			provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
				const config = getConfig();
				if (!config.enabled || !config.divisionCodeLens) {
					return [];
				}

				const key = document.uri.toString();
				const cached = matchCache.get(key);
				const divisions = cached && cached.version === document.version ? cached.divisions : findDivisions(document);

				const lenses: vscode.CodeLens[] = [];
				for (const m of divisions) {
					// CodeLens title is single-line; keep it readable.
					lenses.push(new vscode.CodeLens(m.range, {
						title: `${m.numerator} / ${m.denominator}`,
						command: 'inlinemath.peekFraction',
						arguments: [m.range],
					}));

					lenses.push(new vscode.CodeLens(m.range, {
						title: 'Math Preview',
						command: 'inlinemath.openMathPreview',
						arguments: [m.numerator, m.denominator, m.range],
					}));
				}
				return lenses;
			}
		})())
	);

	context.subscriptions.push(
		vscode.languages.registerHoverProvider({ language: 'java' }, {
			provideHover(document: vscode.TextDocument, position: vscode.Position) {
				const config = getConfig();
				if (!config.enabled || !config.divisionHoverStacked) {
					return;
				}

				const key = document.uri.toString();
				const cached = matchCache.get(key);
				const divisions = cached && cached.version === document.version ? cached.divisions : findDivisions(document);

				const match = divisions.find((m) => m.range.contains(position));
				if (!match) {
					return;
				}

				const stacked = buildStackedFraction(match.numerator, match.denominator);
				const md = new vscode.MarkdownString();
				md.appendCodeblock(stacked, 'text');
				md.isTrusted = false;
				return new vscode.Hover(md, match.range);
			},
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => updateForEditor(editor))
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || e.document !== editor.document) {
				return;
			}
			updateForEditor(editor);
			codeLensChanged.fire();
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
			if (!e.affectsConfiguration('inlinemath')) {
				return;
			}
			updateForEditor(vscode.window.activeTextEditor);
			codeLensChanged.fire();
		})
	);

	updateForEditor(vscode.window.activeTextEditor);
}

export function deactivate() {
	divisionDecorationType?.dispose();
	divisionDecorationType = undefined;
	matchCache.clear();
}
