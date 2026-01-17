import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findDivisions, type DivisionMatch } from './math/division';
import { buildStackedFraction } from './math/stackedFraction';
import { divisionToLatex } from './math/latex';
import { scanJava } from './math/scan';
import { findPowCalls, type PowMatch } from './math/pow';
import { findExpressions, type ExpressionMatch } from './math/findExpressions';
import { findForLoopSummations, type SumMatch } from './math/forLoopSum';
import { findForLoopMappings, type MapMatch } from './math/forLoopMap';
import katex from 'katex';

let divisionDecorationType: vscode.TextEditorDecorationType | undefined;
let expressionDecorationType: vscode.TextEditorDecorationType | undefined;
let extensionRootUri: vscode.Uri | undefined;

const SUPPORTED_LANGUAGE_IDS = new Set(['java', 'javascript', 'typescript', 'cpp']);

function isSupportedLanguageId(languageId: string): boolean {
	return SUPPORTED_LANGUAGE_IDS.has(languageId);
}

type AnyMatch =
	| { kind: 'division'; range: vscode.Range; numerator: string; denominator: string }
	| { kind: 'pow'; range: vscode.Range; latex: string; inlineText: string }
	| { kind: 'expr'; range: vscode.Range; latex: string; inlineText: string }
	| { kind: 'sum'; range: vscode.Range; latex: string; inlineText: string }
	| { kind: 'map'; range: vscode.Range; latex: string; inlineText: string };

function pickLargestNonOverlapping(matches: AnyMatch[]): AnyMatch[] {
	// Prefer outer ranges: sort by start asc, length desc.
	const withOffsets = matches
		.map((m) => ({
			m,
			start: m.range.start,
			end: m.range.end,
			// VS Code Positions are comparable via isBefore/isEqual helpers.
		}))
		.sort((a, b) => {
			if (a.start.line !== b.start.line) return a.start.line - b.start.line;
			if (a.start.character !== b.start.character) return a.start.character - b.start.character;
			// Longer first if same start
			if (a.end.line !== b.end.line) return b.end.line - a.end.line;
			return b.end.character - a.end.character;
		});

	const kept: AnyMatch[] = [];
	for (const item of withOffsets) {
		const candidate = item.m;
		let overlaps = false;
		for (const k of kept) {
			if (k.range.intersection(candidate.range)) {
				// If candidate is fully contained, drop it.
				if (k.range.contains(candidate.range)) {
					overlaps = true;
					break;
				}
				// If there's any overlap at all, also drop to avoid clutter.
				overlaps = true;
				break;
			}
		}
		if (!overlaps) {
			kept.push(candidate);
		}
	}
	return kept;
}

type CachedMatches = {
	docUri: string;
	version: number;
	maskedText: string;
	divisions: DivisionMatch[];
	powCalls: PowMatch[];
	expressions: ExpressionMatch[];
	sums: SumMatch[];
	maps: MapMatch[];
};

const matchCache = new Map<string, CachedMatches>();

function getConfig() {
	const config = vscode.workspace.getConfiguration('inlinemath');
	const previewScaleRaw = config.get<number>('preview.scale', 1.5);
	const previewScale = Number.isFinite(previewScaleRaw) ? Math.min(4, Math.max(0.5, previewScaleRaw)) : 1.5;
	return {
		enabled: config.get<boolean>('enabled', true),
		divisionCodeLens: config.get<boolean>('division.codeLens', true),
		divisionPeekDefinition: config.get<boolean>('division.peekDefinition', true),
		previewEnabled: config.get<boolean>('preview.enabled', true),
		previewScale,
		divisionInlineDecoration: config.get<boolean>('division.inlineDecoration', true),
		divisionHoverStacked: config.get<boolean>('division.hoverStackedFraction', true),
		divisionInlinePrefix: config.get<string>('division.inlinePrefix', '  ⟂  '),
		expressionCodeLens: config.get<boolean>('expression.codeLens', true),
		expressionInlineDecoration: config.get<boolean>('expression.inlineDecoration', false),
		expressionHoverLatex: config.get<boolean>('expression.hoverLatex', true),
		expressionInlinePrefix: config.get<string>('expression.inlinePrefix', '  ≈  '),
		powCodeLens: config.get<boolean>('pow.codeLens', true),
		powInlineDecoration: config.get<boolean>('pow.inlineDecoration', false),
		powHoverLatex: config.get<boolean>('pow.hoverLatex', true),
		powInlinePrefix: config.get<string>('pow.inlinePrefix', '  ≈  '),
		sumCodeLens: config.get<boolean>('sum.codeLens', true),
		sumInlineDecoration: config.get<boolean>('sum.inlineDecoration', false),
		sumHoverLatex: config.get<boolean>('sum.hoverLatex', true),
		sumInlinePrefix: config.get<string>('sum.inlinePrefix', '  ≈  '),
		mapCodeLens: config.get<boolean>('map.codeLens', true),
		mapInlineDecoration: config.get<boolean>('map.inlineDecoration', false),
		mapHoverLatex: config.get<boolean>('map.hoverLatex', true),
		mapInlinePrefix: config.get<string>('map.inlinePrefix', '  ≈  '),
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

function ensureExpressionDecorationType() {
	if (expressionDecorationType) {
		return;
	}

	expressionDecorationType = vscode.window.createTextEditorDecorationType({
		after: {
			color: new vscode.ThemeColor('editorCodeLens.foreground'),
			fontStyle: 'italic',
			margin: '0 0 0 1.5em',
		},
	});
}

function clearDecorations(editor: vscode.TextEditor) {
	if (divisionDecorationType) {
		editor.setDecorations(divisionDecorationType, []);
	}
	if (expressionDecorationType) {
		editor.setDecorations(expressionDecorationType, []);
	}
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
	if (!config.enabled || !isSupportedLanguageId(editor.document.languageId)) {
		clearDecorations(editor);
		return;
	}

	ensureDecorationType();
	if (!divisionDecorationType) {
		return;
	}
	ensureExpressionDecorationType();

	const key = editor.document.uri.toString();
	const cached = matchCache.get(key);
	let divisions: DivisionMatch[];
	let powCalls: PowMatch[];
	let expressions: ExpressionMatch[];
	let sums: SumMatch[];
	let maps: MapMatch[];
	let maskedText: string;

	if (cached && cached.version === editor.document.version) {
		divisions = cached.divisions;
		powCalls = cached.powCalls;
		expressions = cached.expressions;
		sums = cached.sums ?? findForLoopSummations(editor.document, cached.maskedText);
		maps = cached.maps ?? findForLoopMappings(editor.document, cached.maskedText);
		maskedText = cached.maskedText;
	} else {
		maskedText = scanJava(editor.document.getText()).maskedText;
		divisions = findDivisions(editor.document);
		powCalls = findPowCalls(editor.document, maskedText);
		expressions = findExpressions(editor.document, maskedText);
		try {
			sums = findForLoopSummations(editor.document, maskedText);
		} catch {
			sums = [];
		}
		try {
			maps = findForLoopMappings(editor.document, maskedText);
		} catch {
			maps = [];
		}

		// Keep all raw matches; we'll apply "largest only" per-surface to avoid clutter.

		matchCache.set(key, {
			docUri: key,
			version: editor.document.version,
			maskedText,
			divisions,
			powCalls,
			expressions,
			sums,
			maps,
		});
	}

	// Inline decorations: pick largest non-overlapping matches among enabled kinds.
	const inlineCandidates: AnyMatch[] = [];
	if (config.divisionInlineDecoration) {
		inlineCandidates.push(
			...divisions.map((d) => ({
				kind: 'division' as const,
				range: d.range,
				numerator: d.numerator,
				denominator: d.denominator,
			}))
		);
	}
	if (config.powInlineDecoration) {
		inlineCandidates.push(
			...powCalls.map((p) => ({
				kind: 'pow' as const,
				range: p.range,
				latex: p.latex,
				inlineText: p.inlineText,
			}))
		);
	}
	if (config.expressionInlineDecoration) {
		inlineCandidates.push(
			...expressions.map((e) => ({
				kind: 'expr' as const,
				range: e.range,
				latex: e.latex,
				inlineText: e.inlineText,
			}))
		);
	}
	if (config.sumInlineDecoration) {
		inlineCandidates.push(
			...sums.map((s) => ({
				kind: 'sum' as const,
				range: s.range,
				latex: s.latex,
				inlineText: s.inlineText,
			}))
		);
	}
	if (config.mapInlineDecoration) {
		inlineCandidates.push(
			...maps.map((m) => ({
				kind: 'map' as const,
				range: m.range,
				latex: m.latex,
				inlineText: m.inlineText,
			}))
		);
	}
	const inlineKept = pickLargestNonOverlapping(inlineCandidates);

	// Division decorations
	if (!config.divisionInlineDecoration) {
		editor.setDecorations(divisionDecorationType, []);
	} else {
		const keptDivisions = inlineKept.filter((m): m is Extract<AnyMatch, { kind: 'division' }> => m.kind === 'division');
		const decorations: vscode.DecorationOptions[] = keptDivisions.map((m) => ({
			range: m.range,
			renderOptions: {
				after: {
					contentText: formatInlineFraction(m.numerator, m.denominator, config.divisionInlinePrefix),
				},
			},
		}));
		editor.setDecorations(divisionDecorationType, decorations);
	}

	// Expression/pow decorations
	if (expressionDecorationType) {
		const exprDecorations: vscode.DecorationOptions[] = [];
		for (const m of inlineKept) {
			if (m.kind === 'expr') {
				exprDecorations.push({
					range: m.range,
					renderOptions: { after: { contentText: `${config.expressionInlinePrefix}${m.inlineText}` } },
				});
			} else if (m.kind === 'pow') {
				exprDecorations.push({
					range: m.range,
					renderOptions: { after: { contentText: `${config.powInlinePrefix}${m.inlineText}` } },
				});
			} else if (m.kind === 'sum') {
				exprDecorations.push({
					range: m.range,
					renderOptions: { after: { contentText: `${config.sumInlinePrefix}${m.inlineText}` } },
				});
			} else if (m.kind === 'map') {
				exprDecorations.push({
					range: m.range,
					renderOptions: { after: { contentText: `${config.mapInlinePrefix}${m.inlineText}` } },
				});
			}
		}
		editor.setDecorations(expressionDecorationType, exprDecorations);
	}
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

function makeNonce(): string {
	return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function openMathPreviewLatex(title: string, latex: string) {
	const config = getConfig();
	if (!config.enabled || !config.previewEnabled) {
		void vscode.window.showInformationMessage('InlineMath preview is disabled (see inlinemath.preview.enabled).');
		return;
	}
	// Note: webviews are their own sandbox; avoid assuming cwd/workspace layout.

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
		title,
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			localResourceRoots: katexDistFsDir
				? [vscode.Uri.file(katexDistFsDir), vscode.Uri.file(path.join(katexDistFsDir, 'fonts'))]
				: [],
		}
	);

	panel.webview.onDidReceiveMessage(
		(msg: unknown) => {
			if (!msg || typeof msg !== 'object') {
				return;
			}
			const type = (msg as { type?: unknown }).type;
			if (type === 'copyLatex') {
				void vscode.env.clipboard.writeText(latex);
				void vscode.window.setStatusBarMessage('InlineMath: LaTeX copied to clipboard', 1500);
			}
		},
		undefined
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

	const nonce = makeNonce();
	const script = `
			(function () {
				const vscode = acquireVsCodeApi();
				const btn = document.getElementById('copyLatex');
				if (btn) {
					btn.addEventListener('click', () => {
						vscode.postMessage({ type: 'copyLatex' });
					});
				}
			})();
		`;

	panel.webview.html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource} data:; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
			${katexCss}
			body { padding: 16px; }
			/* Make math more readable by default; controlled by inlinemath.preview.scale */
			.katex { font-size: ${config.previewScale}em; }
			.katex-display { margin: 0; }
			.hint { opacity: 0.75; font-family: var(--vscode-font-family); font-size: 12px; margin-top: 16px; }
      code { font-family: var(--vscode-editor-font-family); }
			button { font-family: var(--vscode-font-family); }
    </style>
  </head>
  <body>
    ${htmlMath}
		<div class="hint">
			<div style="display:flex; align-items:center; gap: 12px;">
				<button id="copyLatex" type="button">Copy LaTeX</button>
				<div>LaTeX: <code>${escapeHtml(latex)}</code></div>
			</div>
		</div>
		<script nonce="${nonce}">${script}</script>
  </body>
</html>`;
}

function openDivisionMathPreview(numerator: string, denominator: string) {
	const latex = divisionToLatex(numerator, denominator);
	openMathPreviewLatex(`InlineMath: ${numerator}/${denominator}`, latex);
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
		vscode.languages.registerDefinitionProvider(
			[{ language: 'javascript' }, { language: 'typescript' }, { language: 'cpp' }],
			{
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
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('inlinemath.peekFraction', (range?: vscode.Range) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !isSupportedLanguageId(editor.document.languageId)) {
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
			if (!editor || !isSupportedLanguageId(editor.document.languageId)) {
				return;
			}

			if (typeof numerator === 'string' && typeof denominator === 'string') {
				openDivisionMathPreview(numerator, denominator);
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
			openDivisionMathPreview(match.numerator, match.denominator);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('inlinemath.openMathPreviewLatex', (latex?: string, title?: string) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !isSupportedLanguageId(editor.document.languageId)) {
				return;
			}
			if (typeof latex !== 'string' || !latex.trim()) {
				return;
			}
			openMathPreviewLatex(title && title.trim() ? title : 'InlineMath: Math Preview', latex);
		})
	);

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			[{ language: 'java' }, { language: 'javascript' }, { language: 'typescript' }, { language: 'cpp' }],
			new (class implements vscode.CodeLensProvider {
			public readonly onDidChangeCodeLenses = codeLensChanged.event;

			provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
				const config = getConfig();
				if (!config.enabled) {
					return [];
				}

				const key = document.uri.toString();
				const cached = matchCache.get(key);
				const maskedText = cached && cached.version === document.version ? cached.maskedText : scanJava(document.getText()).maskedText;
				const divisions = cached && cached.version === document.version ? cached.divisions : findDivisions(document);
				const powCalls = cached && cached.version === document.version ? cached.powCalls : findPowCalls(document, maskedText);
				let expressions = cached && cached.version === document.version ? cached.expressions : findExpressions(document, maskedText);
				let sums: SumMatch[] = [];
				try {
					sums =
						cached && cached.version === document.version
							? (cached.sums ?? findForLoopSummations(document, cached.maskedText))
							: findForLoopSummations(document, maskedText);
				} catch {
					sums = [];
				}
				let maps: MapMatch[] = [];
				try {
					maps =
						cached && cached.version === document.version
							? (cached.maps ?? findForLoopMappings(document, cached.maskedText))
							: findForLoopMappings(document, maskedText);
				} catch {
					maps = [];
				}

				const lensCandidates: AnyMatch[] = [];
				if (config.divisionCodeLens) {
					lensCandidates.push(
						...divisions.map((d) => ({
							kind: 'division' as const,
							range: d.range,
							numerator: d.numerator,
							denominator: d.denominator,
						}))
					);
				}
				if (config.powCodeLens) {
					lensCandidates.push(
						...powCalls.map((p) => ({
							kind: 'pow' as const,
							range: p.range,
							latex: p.latex,
							inlineText: p.inlineText,
						}))
					);
				}
				if (config.expressionCodeLens) {
					lensCandidates.push(
						...expressions.map((e) => ({
							kind: 'expr' as const,
							range: e.range,
							latex: e.latex,
							inlineText: e.inlineText,
						}))
					);
				}
				if (config.sumCodeLens) {
					lensCandidates.push(
						...sums.map((s) => ({
							kind: 'sum' as const,
							range: s.range,
							latex: s.latex,
							inlineText: s.inlineText,
						}))
					);
				}
				if (config.mapCodeLens) {
					lensCandidates.push(
						...maps.map((m) => ({
							kind: 'map' as const,
							range: m.range,
							latex: m.latex,
							inlineText: m.inlineText,
						}))
					);
				}
				const lensKept = pickLargestNonOverlapping(lensCandidates);

				const lenses: vscode.CodeLens[] = [];
				for (const m of lensKept) {
					if (m.kind === 'division') {
						lenses.push(new vscode.CodeLens(m.range, {
							title: `Math Preview: ${m.numerator}/${m.denominator}`,
							command: 'inlinemath.openMathPreview',
							arguments: [m.numerator, m.denominator, m.range],
						}));
					} else {
						const title = m.inlineText.length > 60 ? `${m.inlineText.slice(0, 57)}...` : m.inlineText;
						lenses.push(new vscode.CodeLens(m.range, {
							title: `Math Preview: ${title}`,
							command: 'inlinemath.openMathPreviewLatex',
							arguments: [m.latex, `InlineMath: ${title}`],
						}));
					}
				}
				return lenses;
			}
		})())
	);

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			[{ language: 'java' }, { language: 'javascript' }, { language: 'typescript' }, { language: 'cpp' }],
			{
			provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
				const config = getConfig();
				if (!config.enabled) {
					return undefined;
				}

				const key = document.uri.toString();
				const cached = matchCache.get(key);
				const maskedText = cached && cached.version === document.version ? cached.maskedText : scanJava(document.getText()).maskedText;
				const divisions = cached && cached.version === document.version ? cached.divisions : findDivisions(document);
				const powCalls = cached && cached.version === document.version ? cached.powCalls : findPowCalls(document, maskedText);
				const expressions = cached && cached.version === document.version ? cached.expressions : findExpressions(document, maskedText);
				let sums: SumMatch[] = [];
				try {
					sums =
						cached && cached.version === document.version
							? (cached.sums ?? findForLoopSummations(document, cached.maskedText))
							: findForLoopSummations(document, maskedText);
				} catch {
					sums = [];
				}
				let maps: MapMatch[] = [];
				try {
					maps =
						cached && cached.version === document.version
							? (cached.maps ?? findForLoopMappings(document, cached.maskedText))
							: findForLoopMappings(document, maskedText);
				} catch {
					maps = [];
				}

				// Hover: choose the largest enabled match that contains the position.
				const hoverCandidates: AnyMatch[] = [];
				if (config.powHoverLatex) {
					hoverCandidates.push(
						...powCalls.map((p) => ({
							kind: 'pow' as const,
							range: p.range,
							latex: p.latex,
							inlineText: p.inlineText,
						}))
					);
				}
				if (config.expressionHoverLatex) {
					hoverCandidates.push(
						...expressions.map((e) => ({
							kind: 'expr' as const,
							range: e.range,
							latex: e.latex,
							inlineText: e.inlineText,
						}))
					);
				}
				if (config.sumHoverLatex) {
					hoverCandidates.push(
						...sums.map((s) => ({
							kind: 'sum' as const,
							range: s.range,
							latex: s.latex,
							inlineText: s.inlineText,
						}))
					);
				}
				if (config.mapHoverLatex) {
					hoverCandidates.push(
						...maps.map((m) => ({
							kind: 'map' as const,
							range: m.range,
							latex: m.latex,
							inlineText: m.inlineText,
						}))
					);
				}
				if (config.divisionHoverStacked) {
					hoverCandidates.push(
						...divisions.map((d) => ({
							kind: 'division' as const,
							range: d.range,
							numerator: d.numerator,
							denominator: d.denominator,
						}))
					);
				}

				const atPos = hoverCandidates.filter((m) => m.range.contains(position));
				const kept = pickLargestNonOverlapping(atPos);
				const best = kept.find((m) => m.range.contains(position));
				if (!best) {
					return undefined;
				}
				if (best.kind === 'division') {
					const stacked = buildStackedFraction(best.numerator, best.denominator);
					const md = new vscode.MarkdownString();
					md.appendCodeblock(stacked, 'text');
					md.isTrusted = false;
					return new vscode.Hover(md, best.range);
				}
				const md = new vscode.MarkdownString();
				md.appendCodeblock(best.inlineText, 'text');
				md.appendCodeblock(`LaTeX: ${best.latex}`, 'text');
				md.isTrusted = false;
				return new vscode.Hover(md, best.range);
			},
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
			updateForEditor(editor);
			codeLensChanged.fire();
		})
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
	expressionDecorationType?.dispose();
	expressionDecorationType = undefined;
	matchCache.clear();
}
