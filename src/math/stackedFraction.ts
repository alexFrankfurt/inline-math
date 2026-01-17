function padCenter(text: string, width: number): string {
	if (text.length >= width) {
		return text;
	}
	const totalPad = width - text.length;
	// Bias odd padding to the left so single-digit numerators look centered over
	// two-digit denominators in typical editor fonts.
	const left = Math.ceil(totalPad / 2);
	const right = totalPad - left;
	return `${' '.repeat(left)}${text}${' '.repeat(right)}`;
}

export function buildStackedFraction(numerator: string, denominator: string): string {
	const width = Math.max(numerator.length, denominator.length, 1);
	const top = padCenter(numerator, width);
	const line = '─'.repeat(width);
	const bottom = padCenter(denominator, width);
	return `${top}\n${line}\n${bottom}`;
}
