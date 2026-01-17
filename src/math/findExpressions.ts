import * as vscode from 'vscode';
import { parseExpressionAt, exprContainsOperator, exprToLatex, exprToInlineText, type Expr } from './expression';

export type ExpressionMatch = {
	range: vscode.Range;
	exprText: string;
	expr: Expr;
	latex: string;
	inlineText: string;
};

function isStartChar(ch: string): boolean {
	return /[A-Za-z0-9_\(\{\[\+\-]/.test(ch);
}

function isBoundaryChar(ch: string): boolean {
	return !/[A-Za-z0-9_\.]/.test(ch);
}

export function findExpressions(document: vscode.TextDocument, maskedText: string, maxMatches = 500): ExpressionMatch[] {
	const results: ExpressionMatch[] = [];
	const text = document.getText();

	let i = 0;
	while (i < maskedText.length && results.length < maxMatches) {
		const ch = maskedText[i] ?? '';
		if (!isStartChar(ch)) {
			i++;
			continue;
		}

		// Require a boundary before the start, to reduce duplicates.
		if (i > 0 && !isBoundaryChar(maskedText[i - 1] ?? '')) {
			i++;
			continue;
		}

		const parsed = parseExpressionAt(maskedText, i);
		if (!parsed) {
			i++;
			continue;
		}

		// Avoid matching outer syntactic constructs like calls/new as "the expression";
		// we want the inner arithmetic (e.g. Float32Array(this.shape[0] * ...)).
		if (parsed.expr.kind === 'call' || parsed.expr.kind === 'new') {
			i++;
			continue;
		}

		let end = parsed.end;
		// Trim trailing whitespace.
		while (end > i && /\s/.test(maskedText[end - 1]!)) end--;

		if (end <= i) {
			i++;
			continue;
		}

		// Avoid interpreting '^' as exponentiation anywhere.
		if (maskedText.slice(i, end).includes('^')) {
			i = end;
			continue;
		}

		// Require a boundary after the match.
		if (end < maskedText.length && !isBoundaryChar(maskedText[end] ?? '')) {
			i++;
			continue;
		}

		if (!exprContainsOperator(parsed.expr)) {
			i = Math.max(end, i + 1);
			continue;
		}

		const exprText = text.slice(i, end);
		const latex = exprToLatex(parsed.expr);
		const inlineText = exprToInlineText(parsed.expr);

		results.push({
			range: new vscode.Range(document.positionAt(i), document.positionAt(end)),
			exprText,
			expr: parsed.expr,
			latex,
			inlineText,
		});

		i = end;
	}

	return results;
}
