import * as vscode from 'vscode';
import { parseExpression, exprToLatex, exprToInlineText } from './expression';

export type SumMatch = {
	range: vscode.Range;
	indexVar: string;
	lowerText: string;
	upperText: string;
	accumulatorText: string;
	termText: string;
	latex: string;
	inlineText: string;
};

function isIdentChar(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function skipWs(text: string, i: number): number {
	while (i < text.length && /\s/.test(text[i]!)) i++;
	return i;
}

function findMatching(text: string, openIndex: number, openCh: string, closeCh: string): number | undefined {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === openCh) depth++;
		else if (ch === closeCh) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return;
}

function findMatchingBrace(text: string, openIndex: number): number | undefined {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return;
}

function parseForHeader(header: string): { indexVar: string; lower: string; upper: string } | undefined {
	// Very small heuristic parser for headers like:
	// for (var i = 0; i < n; i++)
	// for (let i=0; i<=n; ++i)
	// for (int i = 0; i < n; i += 1)
	const parts = header.split(';');
	if (parts.length < 3) return;
	const init = parts[0] ?? '';
	const cond = parts[1] ?? '';
	const update = parts[2] ?? '';

	const initRe = /\b(?:var|let|const|int|long|size_t|auto)?\s*([A-Za-z_]\w*)\s*=\s*([^;]+)$/;
	const initM = initRe.exec(init.trim());
	if (!initM) return;
	const indexVar = initM[1]!;
	const indexVarRe = escapeRegExp(indexVar);
	const lower = initM[2]!.trim();

	const condTrim = cond.trim();
	const condRe = new RegExp(`^${indexVarRe}\\s*(<=|<)\\s*([^;]+)$`);
	const condM = condRe.exec(condTrim);
	if (!condM) return;
	const op = condM[1]!;
	const rhs = condM[2]!.trim();

	// Validate update references the same index variable.
	const upd = update.trim();
	const updateRe = new RegExp(
		`(?:\\+\\+\\s*${indexVarRe}|${indexVarRe}\\s*\\+\\+|${indexVarRe}\\s*\\+=\\s*1|${indexVarRe}\\s*=\\s*${indexVarRe}\\s*\\+\\s*1)`
	);
	if (!updateRe.test(upd)) {
		return;
	}

	const upper = op === '<' ? `${rhs} - 1` : rhs;
	return { indexVar, lower, upper };
}

function extractSummation(body: string): { accumulator: string; termText: string } | undefined {
	// Accumulation patterns: sum += expr;  sum = sum + expr;  sum = expr + sum;
	const plusEq = /\b([A-Za-z_]\w*)\s*\+=\s*([^;]+);/m.exec(body);
	if (plusEq) return { accumulator: plusEq[1]!, termText: plusEq[2]!.trim() };

	const sumEqLeft = /\b([A-Za-z_]\w*)\s*=\s*\1\s*\+\s*([^;]+);/m.exec(body);
	if (sumEqLeft) return { accumulator: sumEqLeft[1]!, termText: sumEqLeft[2]!.trim() };

	const sumEqRight = /\b([A-Za-z_]\w*)\s*=\s*([^;]+)\s*\+\s*\1\s*;/m.exec(body);
	if (sumEqRight) return { accumulator: sumEqRight[1]!, termText: sumEqRight[2]!.trim() };

	return;
}

export function findForLoopSummations(document: vscode.TextDocument, maskedText: string): SumMatch[] {
	const results: SumMatch[] = [];
	const original = document.getText();

	let i = 0;
	while (i < maskedText.length) {
		const idx = maskedText.indexOf('for', i);
		if (idx === -1) break;

		// Ensure word boundary.
		const prev = idx > 0 ? maskedText[idx - 1]! : '';
		const next = maskedText[idx + 3] ?? '';
		if ((prev && isIdentChar(prev)) || (next && isIdentChar(next))) {
			i = idx + 3;
			continue;
		}

		let j = skipWs(maskedText, idx + 3);
		if (maskedText[j] !== '(') {
			i = idx + 3;
			continue;
		}

		const closeParen = findMatching(maskedText, j, '(', ')');
		if (closeParen === undefined) {
			i = idx + 3;
			continue;
		}

		const headerText = maskedText.slice(j + 1, closeParen);
		const header = parseForHeader(headerText);
		if (!header) {
			i = closeParen + 1;
			continue;
		}

		// Find body: either { ... } or a single statement.
		let bodyStart = skipWs(maskedText, closeParen + 1);
		let bodyEnd: number | undefined;
		let bodyText = '';
		if (maskedText[bodyStart] === '{') {
			bodyEnd = findMatchingBrace(maskedText, bodyStart);
			if (bodyEnd === undefined) {
				i = closeParen + 1;
				continue;
			}
			bodyText = maskedText.slice(bodyStart + 1, bodyEnd);
		} else {
			// Single statement ends at ';'
			const semi = maskedText.indexOf(';', bodyStart);
			if (semi === -1) {
				i = closeParen + 1;
				continue;
			}
			bodyEnd = semi + 1;
			bodyText = maskedText.slice(bodyStart, semi);
		}

		const extracted = extractSummation(bodyText);
		if (!extracted) {
			i = (bodyEnd ?? closeParen + 1) + 1;
			continue;
		}
		const { accumulator: accumulatorText, termText } = extracted;

		// If term contains '^', skip (avoid XOR-as-exponent).
		if (termText.includes('^') || header.lower.includes('^') || header.upper.includes('^')) {
			i = (bodyEnd ?? closeParen + 1) + 1;
			continue;
		}

		const lowerExpr = parseExpression(header.lower) ?? { kind: 'raw', text: header.lower };
		const upperExpr = parseExpression(header.upper) ?? { kind: 'raw', text: header.upper };
		const termExpr = parseExpression(termText) ?? { kind: 'raw', text: termText };
		const accExpr = parseExpression(accumulatorText) ?? { kind: 'raw', text: accumulatorText };

		const sumLatex = `\\sum_{${header.indexVar}=${exprToLatex(lowerExpr)}}^{${exprToLatex(upperExpr)}} ${exprToLatex(termExpr)}`;
		const sumInline = `Σ_${header.indexVar}=${exprToInlineText(lowerExpr)}..${exprToInlineText(upperExpr)} ${exprToInlineText(termExpr)}`;
		const latex = `${exprToLatex(accExpr)} = ${sumLatex}`;
		const inlineText = `${exprToInlineText(accExpr)} = ${sumInline}`;

		results.push({
			range: new vscode.Range(document.positionAt(idx), document.positionAt((bodyEnd ?? closeParen + 1))),
			indexVar: header.indexVar,
			lowerText: header.lower,
			upperText: header.upper,
			accumulatorText,
			termText,
			latex,
			inlineText,
		});

		i = (bodyEnd ?? closeParen + 1) + 1;
	}

	return results;
}
