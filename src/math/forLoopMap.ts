import * as vscode from 'vscode';
import { parseExpression, exprToLatex, exprToInlineText, type Expr } from './expression';

export type MapMatch = {
	range: vscode.Range;
	indexVar: string;
	lowerText: string;
	upperText: string;
	arrayText: string;
	indexText: string;
	valueText: string;
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

function wordContainsIdent(text: string, ident: string): boolean {
	const re = new RegExp(`\\b${escapeRegExp(ident)}\\b`);
	return re.test(text);
}

function extractMapping(body: string, indexVar: string): { arrayText: string; indexText: string; valueText: string } | undefined {
	// Match e.g. answer[i] = expr;  this.answer[i] = expr;
	const m = /\b([A-Za-z_][\w\.]*)\s*\[\s*([^\]]+)\s*\]\s*=\s*([^;]+);/m.exec(body);
	if (!m) return;
	const arrayText = m[1]!.trim();
	const indexText = m[2]!.trim();
	const valueText = m[3]!.trim();
	if (!wordContainsIdent(indexText, indexVar)) return;
	return { arrayText, indexText, valueText };
}

function toExpr(text: string): Expr {
	return parseExpression(text) ?? ({ kind: 'raw', text } as Expr);
}

export function findForLoopMappings(document: vscode.TextDocument, maskedText: string): MapMatch[] {
	const results: MapMatch[] = [];

	let i = 0;
	while (i < maskedText.length) {
		const idx = maskedText.indexOf('for', i);
		if (idx === -1) break;

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
			const semi = maskedText.indexOf(';', bodyStart);
			if (semi === -1) {
				i = closeParen + 1;
				continue;
			}
			bodyEnd = semi + 1;
			bodyText = maskedText.slice(bodyStart, semi);
		}

		const extracted = extractMapping(bodyText, header.indexVar);
		if (!extracted) {
			i = (bodyEnd ?? closeParen + 1) + 1;
			continue;
		}

		const { arrayText, indexText, valueText } = extracted;
		if (
			arrayText.includes('^') ||
			indexText.includes('^') ||
			valueText.includes('^') ||
			header.lower.includes('^') ||
			header.upper.includes('^')
		) {
			i = (bodyEnd ?? closeParen + 1) + 1;
			continue;
		}

		const lowerExpr = toExpr(header.lower);
		const upperExpr = toExpr(header.upper);
		const arrayExpr = toExpr(arrayText);
		const indexExpr = toExpr(indexText);
		const valueExpr = toExpr(valueText);
		const lhsExpr: Expr = { kind: 'index', object: arrayExpr, index: indexExpr };
		const idxVarExpr = toExpr(header.indexVar);

		const latex = `${exprToLatex(lhsExpr)} = ${exprToLatex(valueExpr)},\\quad ${exprToLatex(idxVarExpr)} = ${exprToLatex(lowerExpr)},\\ldots,${exprToLatex(upperExpr)}`;
		const inlineText = `${exprToInlineText(lhsExpr)} = ${exprToInlineText(valueExpr)}  (${header.indexVar}=${exprToInlineText(lowerExpr)}..${exprToInlineText(upperExpr)})`;

		results.push({
			range: new vscode.Range(document.positionAt(idx), document.positionAt(bodyEnd ?? closeParen + 1)),
			indexVar: header.indexVar,
			lowerText: header.lower,
			upperText: header.upper,
			arrayText,
			indexText,
			valueText,
			latex,
			inlineText,
		});

		i = (bodyEnd ?? closeParen + 1) + 1;
	}

	return results;
}
