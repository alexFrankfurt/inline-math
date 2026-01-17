# Inline Math Overlay

A minimal VS Code extension that shows lightweight math overlays for Java code.

Currently implemented:
- Detects simple divisions like `a/b` or `3/4`
- Shows a subtle inline decoration after the expression (e.g. `5/10` → `⁵⁄₁₀`)
- Shows a stacked two-line fraction on hover
- Adds a CodeLens and Peek Definition view for a stacked fraction
- Adds a KaTeX-based Math Preview webview for reliable rendering

## Run locally

1. `npm install`
2. `npm run compile`
3. Press `F5` to launch an Extension Development Host
4. Open a `.java` file and type `3/4`

## Settings

- `inlinemath.enabled`
- `inlinemath.division.inlineDecoration`
- `inlinemath.division.hoverStackedFraction`
- `inlinemath.division.inlinePrefix`

## Notes on LaTeX in Peek

Peek Definition uses a normal text editor surface, so it can’t render Markdown/LaTeX as typeset math.
For reliable math layout (fractions, roots, etc.), use **Math Preview** (KaTeX in a webview).
