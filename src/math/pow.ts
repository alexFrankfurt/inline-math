import * as vscode from 'vscode';
import { parseExpression, exprContainsOperator, exprToLatex, type Expr, toSuperscriptDigits, exprToInlineText } from './expression';

export type PowMatch = {
	range: vscode.Range;
	calleeText: string;
	baseText: string;
	expText: string;
	baseExpr: Expr;
	expExpr: Expr;
	latex: string;
	inlineText: string;
};

function isIdentChar(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

function skipWs(text: string, i: number): number {
	while (i < text.length && /\s/.test(text[i]!)) i++;
	return i;
}

function findMatchingParen(maskedText: string, openParenIndex: number): number | undefined {
	let depth = 0;
	for (let i = openParenIndex; i < maskedText.length; i++) {
		const ch = maskedText[i]!;
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return;
}

function splitTwoArgs(maskedText: string, start: number, end: number): { a: string; b: string } | undefined {
	let depthParen = 0;
	let depthBrace = 0;
	let depthBracket = 0;
	for (let i = start; i < end; i++) {
		const ch = maskedText[i]!;
		if (ch === '(') depthParen++;
		else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
		else if (ch === '{') depthBrace++;
		else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
		else if (ch === '[') depthBracket++;
		else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
		else if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
			const a = maskedText.slice(start, i).trim();
			const b = maskedText.slice(i + 1, end).trim();
			if (!a || !b) return;
			return { a, b };
		}
	}
	return;
}

function formatPowInline(base: Expr, exp: Expr): string {
	// Prefer digit superscripts when exponent is a simple integer literal.
	const baseText = exprContainsOperator(base) ? `(${exprToInlineText(base)})` : exprToInlineText(base);
	if (exp.kind === 'number') {
		const sup = toSuperscriptDigits(exp.value);
		if (sup) {
			return `${baseText}${sup}`;
		}
	}
	return `${baseText}^(${exprToInlineText(exp)})`;
}

export function findPowCalls(document: vscode.TextDocument, maskedText: string): PowMatch[] {
	const results: PowMatch[] = [];
	const text = document.getText();

	// Qualified prefix: foo.bar.Math.pow(
	const powRe = /(?:\b[A-Za-z_]\w*\s*\.\s*)*Math\s*\.\s*pow\s*\(/g;
	powRe.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ((match = powRe.exec(maskedText)) !== null) {
		const start = match.index;
		// Basic guard: avoid matching mid-identifier via preceding char.
		const prev = start > 0 ? maskedText[start - 1]! : '';
		if (prev && (isIdentChar(prev) || prev === '.')) {
			continue;
		}

		const openParen = start + match[0].length - 1;
		const closeParen = findMatchingParen(maskedText, openParen);
		if (closeParen === undefined) {
			continue;
		}

		const args = splitTwoArgs(maskedText, openParen + 1, closeParen);
		if (!args) {
			continue;
		}

		// Avoid XOR confusion inside pow args too.
		if (args.a.includes('^') || args.b.includes('^')) {
			continue;
		}

		const baseExpr = parseExpression(args.a) ?? { kind: 'raw', text: args.a };
		const expExpr = parseExpression(args.b) ?? { kind: 'raw', text: args.b };

		const baseLatexRaw = exprToLatex(baseExpr);
		const baseLatex = exprContainsOperator(baseExpr) ? `\\left(${baseLatexRaw}\\right)` : baseLatexRaw;
		const latex = `{${baseLatex}}^{${exprToLatex(expExpr)}}`;
		const calleeText = text.slice(start, openParen).trim();
		const inlineText = formatPowInline(baseExpr, expExpr);

		results.push({
			range: new vscode.Range(document.positionAt(start), document.positionAt(closeParen + 1)),
			calleeText,
			baseText: args.a,
			expText: args.b,
			baseExpr,
			expExpr,
			latex,
			inlineText,
		});

		powRe.lastIndex = closeParen + 1;
	}

	return results;
}
