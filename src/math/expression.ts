export type Expr =
	| { kind: 'number'; value: string }
	| { kind: 'ident'; name: string }
	| { kind: 'raw'; text: string }
	| { kind: 'group'; bracket: '(' | '{'; expr: Expr }
	| { kind: 'unary'; op: '+' | '-'; expr: Expr }
	| { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr }
	| { kind: 'member'; object: Expr; member: string }
	| { kind: 'index'; object: Expr; index: Expr }
	| { kind: 'call'; callee: Expr; args: Expr[] }
	| { kind: 'new'; ctor: Expr; args: Expr[] };

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

function splitArgsText(argsText: string): string[] {
	const args: string[] = [];
	let i = 0;
	let start = 0;
	let depthParen = 0;
	let depthBrace = 0;
	let depthBracket = 0;
	while (i <= argsText.length) {
		const ch = argsText[i] ?? ',';
		if (ch === '(') depthParen++;
		else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
		else if (ch === '{') depthBrace++;
		else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
		else if (ch === '[') depthBracket++;
		else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);

		if ((ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) || i === argsText.length) {
			const part = argsText.slice(start, i).trim();
			if (part.length > 0) {
				args.push(part);
			}
			start = i + 1;
		}
		i++;
	}
	return args;
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

		// new <ctor>(args)
		if (this.text.startsWith('new', this.i) && /\b/.test(this.text[this.i + 3] ?? ' ')) {
			const iAfterNew = skipWs(this.text, this.i + 3);
			// parse ctor as a primary-like atom (qualified ident)
			const ctorIdent = parseQualifiedIdent(this.text, iAfterNew);
			if (ctorIdent) {
				this.i = ctorIdent.end;
				let ctorExpr: Expr = { kind: 'ident', name: ctorIdent.name };
				this.i = skipWs(this.text, this.i);
				if (this.text[this.i] === '(') {
					const close = findMatching(this.text, this.i, '(', ')');
					if (close !== undefined) {
						const argsText = this.text.slice(this.i + 1, close);
						const argParts = splitArgsText(argsText);
						const args = argParts.map((p) => parseExpression(p) ?? ({ kind: 'raw', text: p } as Expr));
						this.i = close + 1;
						return { kind: 'new', ctor: ctorExpr, args };
					}
				}
				// No parens; treat as raw
				return { kind: 'raw', text: this.text.slice(this.i, ctorIdent.end) };
			}
		}

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
			let expr: Expr = { kind: 'ident', name: ident.name };
			return this.parsePostfix(expr);
		}

		return;
	}

	private parsePostfix(base: Expr): Expr {
		let expr = base;
		while (true) {
			this.i = skipWs(this.text, this.i);
			const ch = this.text[this.i] ?? '';

			// Member access: a . b
			if (ch === '.') {
				const iAfterDot = skipWs(this.text, this.i + 1);
				const member = parseQualifiedIdent(this.text, iAfterDot);
				if (!member) {
					break;
				}
				this.i = member.end;
				expr = { kind: 'member', object: expr, member: member.name };
				continue;
			}

			// Index access: a[expr]
			if (ch === '[') {
				const close = findMatching(this.text, this.i, '[', ']');
				if (close === undefined) {
					break;
				}
				const inside = this.text.slice(this.i + 1, close).trim();
				const indexExpr = parseExpression(inside) ?? ({ kind: 'raw', text: inside } as Expr);
				this.i = close + 1;
				expr = { kind: 'index', object: expr, index: indexExpr };
				continue;
			}

			// Call: f(args)
			if (ch === '(') {
				const close = findMatching(this.text, this.i, '(', ')');
				if (close === undefined) {
					break;
				}
				const argsText = this.text.slice(this.i + 1, close);
				const argParts = splitArgsText(argsText);
				const args = argParts.map((p) => parseExpression(p) ?? ({ kind: 'raw', text: p } as Expr));
				this.i = close + 1;
				expr = { kind: 'call', callee: expr, args };
				continue;
			}

			break;
		}
		return expr;
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
	const p = new Parser(text, start);
	const expr = p.parseExpression();
	if (!expr) return;
	const end = p.i;
	if (text.slice(start, end).includes('^')) return;
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
		case 'member':
			return `${exprToLatex(expr.object)}.${escapeLatex(expr.member)}`;
		case 'index':
			return `${exprToLatex(expr.object)}_{${exprToLatex(expr.index)}}`;
		case 'call': {
			const args = expr.args.map((a) => exprToLatex(a)).join(', ');
			return `${exprToLatex(expr.callee)}\\left(${args}\\right)`;
		}
		case 'new': {
			const args = expr.args.map((a) => exprToLatex(a)).join(', ');
			return `\\operatorname{new}\\,${exprToLatex(expr.ctor)}\\left(${args}\\right)`;
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
		case 'member':
			return exprContainsOperator(expr.object);
		case 'index':
			return exprContainsOperator(expr.object) || exprContainsOperator(expr.index);
		case 'call':
			return expr.args.some(exprContainsOperator) || exprContainsOperator(expr.callee);
		case 'new':
			return expr.args.some(exprContainsOperator) || exprContainsOperator(expr.ctor);
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
		case 'member':
			return `${exprToInlineText(expr.object)}.${expr.member}`;
		case 'index':
			return `${exprToInlineText(expr.object)}[${exprToInlineText(expr.index)}]`;
		case 'call':
			return `${exprToInlineText(expr.callee)}(${expr.args.map(exprToInlineText).join(',')})`;
		case 'new':
			return `new ${exprToInlineText(expr.ctor)}(${expr.args.map(exprToInlineText).join(',')})`;
	}
}
