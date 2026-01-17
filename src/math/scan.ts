export type ScanResult = {
	maskedText: string;
};

type ScanState = 'normal' | 'lineComment' | 'blockComment' | 'string' | 'char' | 'textBlock';

function isNewline(ch: string): boolean {
	return ch === '\n' || ch === '\r';
}

/**
 * Masks Java source so comments and string/char/text-block contents become spaces.
 * Newlines are preserved so offsets map cleanly back to document positions.
 */
export function maskJavaNonCode(text: string): string {
	let state: ScanState = 'normal';
	let escape = false;

	const out: string[] = new Array(text.length);

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1] ?? '';
		const next2 = text[i + 2] ?? '';

		switch (state) {
			case 'normal': {
				// Enter comments
				if (ch === '/' && next === '/') {
					state = 'lineComment';
					out[i] = ' ';
					out[i + 1] = ' ';
					i++;
					break;
				}
				if (ch === '/' && next === '*') {
					state = 'blockComment';
					out[i] = ' ';
					out[i + 1] = ' ';
					i++;
					break;
				}

				// Enter string / char / text block
				if (ch === '"') {
					if (next === '"' && next2 === '"') {
						state = 'textBlock';
						out[i] = ' ';
						out[i + 1] = ' ';
						out[i + 2] = ' ';
						i += 2;
						break;
					}
					state = 'string';
					escape = false;
					out[i] = ' ';
					break;
				}
				if (ch === "'") {
					state = 'char';
					escape = false;
					out[i] = ' ';
					break;
				}

				out[i] = ch;
				break;
			}

			case 'lineComment': {
				if (isNewline(ch)) {
					state = 'normal';
					out[i] = ch;
					break;
				}
				out[i] = ' ';
				break;
			}

			case 'blockComment': {
				if (ch === '*' && next === '/') {
					out[i] = ' ';
					out[i + 1] = ' ';
					i++;
					state = 'normal';
					break;
				}
				out[i] = isNewline(ch) ? ch : ' ';
				break;
			}

			case 'string': {
				if (isNewline(ch)) {
					// Java strings can't span lines (without escapes), but treat newline as reset.
					state = 'normal';
					escape = false;
					out[i] = ch;
					break;
				}
				if (escape) {
					escape = false;
					out[i] = ' ';
					break;
				}
				if (ch === '\\') {
					escape = true;
					out[i] = ' ';
					break;
				}
				if (ch === '"') {
					state = 'normal';
					out[i] = ' ';
					break;
				}
				out[i] = ' ';
				break;
			}

			case 'char': {
				if (isNewline(ch)) {
					state = 'normal';
					escape = false;
					out[i] = ch;
					break;
				}
				if (escape) {
					escape = false;
					out[i] = ' ';
					break;
				}
				if (ch === '\\') {
					escape = true;
					out[i] = ' ';
					break;
				}
				if (ch === "'") {
					state = 'normal';
					out[i] = ' ';
					break;
				}
				out[i] = ' ';
				break;
			}

			case 'textBlock': {
				if (ch === '"' && next === '"' && next2 === '"') {
					out[i] = ' ';
					out[i + 1] = ' ';
					out[i + 2] = ' ';
					i += 2;
					state = 'normal';
					break;
				}
				out[i] = isNewline(ch) ? ch : ' ';
				break;
			}
		}
	}

	return out.join('');
}

export function scanJava(text: string): ScanResult {
	return { maskedText: maskJavaNonCode(text) };
}
