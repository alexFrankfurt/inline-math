export type Expr =
	| { kind: 'number'; value: string }
	| { kind: 'ident'; name: string }
	| { kind: 'raw'; text: string }
	| { kind: 'group'; bracket: '(' | '{'; expr: Expr }
	| { kind: 'unary'; op: '+' | '-'; expr: Expr }
	| { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr };

const enum Prec {
	Add = 10,
	Mul = 20,
	Unary = 30,
	Primary = 40,
}

function isIdentStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
	return /[0-9]/.test(ch);
}

function skipWs(text: string, i: number): number {
	while (i < text.length && /\s/.test(text[i]!)) i++;
	return i;
}

function parseQualifiedIdent(text: string, i: number): { name: string; end: number } | undefined {
	if (!isIdentStart(text[i] ?? '')) return;
	let j = i;
	let name = '';

	// First segment
	while (j < text.length && isIdentPart(text[j]!)) {
		name += text[j]!;
		j++;
	}

	// Dotted segments; allow whitespace around '.'
	while (true) {
		const j0 = skipWs(text, j);
		if (text[j0] !== '.') break;
		const j1 = skipWs(text, j0 + 1);
		if (!isIdentStart(text[j1] ?? '')) break;
		name += '.';
		j = j1;
		while (j < text.length && isIdentPart(text[j]!)) {
			name += text[j]!;
			j++;
		}
	}

	return { name, end: j };
}

function parseNumber(text: string, i: number): { value: string; end: number } | undefined {
	let j = i;
	if (!isDigit(text[j] ?? '')) return;
	while (j < text.length && isDigit(text[j]!)) j++;
	if (text[j] === '.' && isDigit(text[j + 1] ?? '')) {
		j++;
		while (j < text.length && isDigit(text[j]!)) j++;
	}
	return { value: text.slice(i, j), end: j };
}

class Parser {
	public i: number;
	private readonly text: string;

	constructor(text: string, start: number) {
		this.text = text;
		this.i = start;
	}

	parseExpression(): Expr | undefined {
		return this.parseAdd();
	}

	private parseAdd(): Expr | undefined {
		let left = this.parseMul();
		if (!left) return;
		while (true) {
			this.i = skipWs(this.text, this.i);
			const op = this.text[this.i];
			if (op !== '+' && op !== '-') break;
			this.i++;
			const right = this.parseMul();
			if (!right) return;
			left = { kind: 'binary', op, left, right };
		}
		return left;
	}

	private parseMul(): Expr | undefined {
		let left = this.parseUnary();
		if (!left) return;
		while (true) {
			this.i = skipWs(this.text, this.i);
			const op = this.text[this.i];
			if (op !== '*' && op !== '/') break;
			this.i++;
			const right = this.parseUnary();
			if (!right) return;
			left = { kind: 'binary', op, left, right };
		}
		return left;
	}

	private parseUnary(): Expr | undefined {
		this.i = skipWs(this.text, this.i);
		const op = this.text[this.i];
		if (op === '+' || op === '-') {
			this.i++;
			const expr = this.parseUnary();
			if (!expr) return;
			return { kind: 'unary', op, expr };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): Expr | undefined {
		this.i = skipWs(this.text, this.i);
		const ch = this.text[this.i] ?? '';

		if (ch === '(' || ch === '{') {
			const close = ch === '(' ? ')' : '}';
			const start = this.i;
			this.i++;
			const expr = this.parseExpression();
			if (!expr) return;
			this.i = skipWs(this.text, this.i);
			if (this.text[this.i] !== close) return;
			this.i++;
			return { kind: 'group', bracket: ch as '(' | '{', expr };
		}

		const num = parseNumber(this.text, this.i);
		if (num) {
			this.i = num.end;
			return { kind: 'number', value: num.value };
		}

		const ident = parseQualifiedIdent(this.text, this.i);
		if (ident) {
			this.i = ident.end;
			return { kind: 'ident', name: ident.name };
		}

		return;
	}
}

export function parseExpression(text: string): Expr | undefined {
	if (text.includes('^')) {
		return;
	}
	const p = new Parser(text, 0);
	const expr = p.parseExpression();
	if (!expr) return;
	p.i = skipWs(text, p.i);
	if (p.i !== text.length) return;
	return expr;
}

export function parseExpressionAt(text: string, start: number): { expr: Expr; end: number } | undefined {
	// Quick reject: avoid treating '^' as exponent.
	if (text.indexOf('^', start) !== -1) {
		// Don't reject globally here; only reject if it's within the consumed region.
	}

	const p = new Parser(text, start);
	const expr = p.parseExpression();
	if (!expr) return;
	const end = p.i;
	return { expr, end };
}

function escapeLatex(text: string): string {
	return text
		.replace(/\\/g, '\\textbackslash{}')
		.replace(/([{}_^%$#&])/g, '\\$1');
}

function precOf(expr: Expr): number {
	switch (expr.kind) {
		case 'binary':
			return expr.op === '+' || expr.op === '-' ? Prec.Add : Prec.Mul;
		case 'unary':
			return Prec.Unary;
		default:
			return Prec.Primary;
	}
}

function latexWrap(expr: Expr, parentPrec: number): string {
	const latex = exprToLatex(expr);
	return precOf(expr) < parentPrec ? `\\left(${latex}\\right)` : latex;
}

export function exprToLatex(expr: Expr): string {
	switch (expr.kind) {
		case 'number':
			return escapeLatex(expr.value);
		case 'ident':
			return escapeLatex(expr.name);
		case 'raw':
			return `\\text{${escapeLatex(expr.text)}}`;
		case 'group':
			return expr.bracket === '{'
				? `\\left\\{${exprToLatex(expr.expr)}\\right\\}`
				: `\\left(${exprToLatex(expr.expr)}\\right)`;
		case 'unary':
			return `${escapeLatex(expr.op)}${latexWrap(expr.expr, Prec.Unary)}`;
		case 'binary': {
			if (expr.op === '/') {
				return `\\frac{${exprToLatex(expr.left)}}{${exprToLatex(expr.right)}}`;
			}
			const opLatex = expr.op === '*' ? '\\cdot' : escapeLatex(expr.op);
			const parentPrec = expr.op === '+' || expr.op === '-' ? Prec.Add : Prec.Mul;
			return `${latexWrap(expr.left, parentPrec)} ${opLatex} ${latexWrap(expr.right, parentPrec + 1)}`;
		}
	}
}

export function exprContainsOperator(expr: Expr): boolean {
	switch (expr.kind) {
		case 'binary':
			return true;
		case 'unary':
			return exprContainsOperator(expr.expr);
		case 'group':
			return exprContainsOperator(expr.expr);
		default:
			return false;
	}
}

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

export function toSuperscriptDigits(value: string): string | undefined {
	if (!/^\d+$/.test(value)) return;
	return value
		.split('')
		.map((ch) => superscripts[ch] ?? ch)
		.join('');
}

export function exprToInlineText(expr: Expr): string {
	switch (expr.kind) {
		case 'number':
			return expr.value;
		case 'ident':
			return expr.name;
		case 'raw':
			return expr.text;
		case 'group':
			return expr.bracket === '{' ? `{${exprToInlineText(expr.expr)}}` : `(${exprToInlineText(expr.expr)})`;
		case 'unary':
			return `${expr.op}${exprToInlineText(expr.expr)}`;
		case 'binary': {
			const op = expr.op === '*' ? '·' : expr.op === '/' ? '⁄' : expr.op;
			return `${exprToInlineText(expr.left)}${op}${exprToInlineText(expr.right)}`;
		}
	}
}
