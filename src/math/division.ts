import * as vscode from 'vscode';

export type DivisionMatch = {
	range: vscode.Range;
	numerator: string;
	denominator: string;
};

function computeLineExclusions(line: string): { commentStart: number | null; quotedRanges: Array<[number, number]> } {
	let inDouble = false;
	let inSingle = false;
	let escape = false;
	let quoteStart: number | null = null;
	const quotedRanges: Array<[number, number]> = [];

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];

		if (escape) {
			escape = false;
			continue;
		}

		if ((inDouble || inSingle) && ch === '\\') {
			escape = true;
			continue;
		}

		if (!inSingle && ch === '"') {
			if (!inDouble) {
				inDouble = true;
				quoteStart = i;
			} else {
				inDouble = false;
				if (quoteStart !== null) {
					quotedRanges.push([quoteStart, i + 1]);
				}
				quoteStart = null;
			}
			continue;
		}

		if (!inDouble && ch === "'") {
			if (!inSingle) {
				inSingle = true;
				quoteStart = i;
			} else {
				inSingle = false;
				if (quoteStart !== null) {
					quotedRanges.push([quoteStart, i + 1]);
				}
				quoteStart = null;
			}
			continue;
		}

		if (!inSingle && !inDouble && ch === '/' && line[i + 1] === '/') {
			return { commentStart: i, quotedRanges };
		}
	}

	// If a quote wasn't closed, just treat it as quoted to end-of-line.
	if (quoteStart !== null) {
		quotedRanges.push([quoteStart, line.length]);
	}

	return { commentStart: null, quotedRanges };
}

function isInRanges(index: number, ranges: Array<[number, number]>): boolean {
	for (const [start, end] of ranges) {
		if (index >= start && index < end) {
			return true;
		}
	}
	return false;
}

export function findDivisions(document: vscode.TextDocument): DivisionMatch[] {
	const results: DivisionMatch[] = [];

	// Intentionally simple starter: tokens like 3/4 or a/b or foo123/bar_2.
	const token = '(?:[A-Za-z_]\\w*|\\d+(?:\\.\\d+)?)';
	const divisionRe = new RegExp(`\\b(${token})\\s*/\\s*(${token})\\b`, 'g');

	for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
		const line = document.lineAt(lineNumber);
		const text = line.text;
		const { commentStart, quotedRanges } = computeLineExclusions(text);

		divisionRe.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = divisionRe.exec(text)) !== null) {
			const start = match.index;
			if (commentStart !== null && start >= commentStart) {
				break;
			}
			if (isInRanges(start, quotedRanges)) {
				continue;
			}

			const raw = match[0];
			const end = start + raw.length;
			const numerator = match[1];
			const denominator = match[2];

			results.push({
				range: new vscode.Range(
					new vscode.Position(lineNumber, start),
					new vscode.Position(lineNumber, end)
				),
				numerator,
				denominator,
			});
		}
	}

	return results;
}
