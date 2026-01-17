# Inline Math Overlay

A minimal VS Code extension that shows lightweight math overlays for Java code.

Works in:
- Java
- JavaScript
- TypeScript
- C++

Currently implemented:
- Detects simple divisions like `a/b` or `3/4`
- Can show a subtle inline decoration after the expression (e.g. `5/10` → `⁵⁄₁₀`) (off by default)
- Shows a stacked two-line fraction on hover
- Adds a CodeLens and Peek Definition view for a stacked fraction
- Adds a KaTeX-based Math Preview webview for reliable rendering

Also supported:
- Detects simple arithmetic expressions using `+`, `-`, `*`, `/` and grouping with `(...)` or `{...}` (in Java code, not in strings/comments)
- Detects qualified `Math.pow(base, exp)` calls (including `java.lang.Math.pow`) and renders them as exponentiation in Math Preview
- Detects simple `for (...)` loops that look like summations and renders them as a sigma sum (e.g. `\sum_{i=0}^{n-1}`)
- Detects simple `for (...)` loops that write to an indexed output and renders them as an indexed relation (e.g. `answer_i = f(i), i=0..n-1`)

Notes:
- To avoid Java XOR confusion, `^` is intentionally *not* treated as exponentiation input.
- Math Preview includes a **Copy LaTeX** button.

## Run locally

1. `npm install`
2. `npm run compile`
3. Press `F5` to launch an Extension Development Host
4. Open a `.java` file and type `3/4`

## Settings

- `inlinemath.enabled`
- `inlinemath.preview.scale`
- `inlinemath.division.inlineDecoration`
- `inlinemath.division.hoverStackedFraction`
- `inlinemath.division.inlinePrefix`
- `inlinemath.expression.codeLens`
- `inlinemath.expression.inlineDecoration`
- `inlinemath.expression.hoverLatex`
- `inlinemath.expression.inlinePrefix`
- `inlinemath.pow.codeLens`
- `inlinemath.pow.inlineDecoration`
- `inlinemath.pow.hoverLatex`
- `inlinemath.pow.inlinePrefix`
- `inlinemath.sum.codeLens`
- `inlinemath.sum.inlineDecoration`
- `inlinemath.sum.hoverLatex`
- `inlinemath.sum.inlinePrefix`
- `inlinemath.map.codeLens`
- `inlinemath.map.inlineDecoration`
- `inlinemath.map.hoverLatex`
- `inlinemath.map.inlinePrefix`

## Notes on LaTeX in Peek

Peek Definition uses a normal text editor surface, so it can’t render Markdown/LaTeX as typeset math.
For reliable math layout (fractions, roots, etc.), use **Math Preview** (KaTeX in a webview).
