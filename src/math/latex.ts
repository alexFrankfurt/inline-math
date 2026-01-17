export function divisionToLatex(numerator: string, denominator: string): string {
	// Keep it conservative for now; future: escape identifiers and support more nodes.
	return `\\frac{${numerator}}{${denominator}}`;
}
