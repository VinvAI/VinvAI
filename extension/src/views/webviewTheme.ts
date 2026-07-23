/**
 * Shared design system for Vinv webviews, ported from the vinv.ai site so the
 * extension's panels read as the same product: white/black/red, JetBrains Mono
 * body, serif-italic display headings, uppercase micro-labels, sharp corners,
 * and the grid + grain backdrop.
 *
 * Palette variables are defined on <body> and keyed off the theme classes VS
 * Code stamps there (vscode-light / vscode-dark / vscode-high-contrast), so
 * every panel follows the editor's light/dark setting automatically. The web
 * fonts (JetBrains Mono / Instrument Serif) are first in the stacks; when not
 * installed on the user's machine they fall back to the editor's mono font and
 * a system serif, which keeps the look without bundling font files.
 */

export const VINV_FONT_MONO =
	"'JetBrains Mono', var(--vscode-editor-font-family, ui-monospace), ui-monospace, Consolas, monospace";

export const VINV_FONT_SERIF =
	"'Instrument Serif', 'Iowan Old Style', Georgia, 'Times New Roman', serif";

export const VINV_BASE_CSS = `
	/* ===== Vinv palette (light default, mirrors vinv.ai styles.css) ===== */
	body {
		--bg: #ffffff;
		--bg-2: #f4f4f4;
		--ink: #0a0a0a;
		--ink-soft: #1a1a1a;
		--muted: #6b6b6b;
		--muted-2: #9a9a9a;
		--accent: #d71921;
		--accent-soft: #ff5a5f;
		--line: rgba(10, 10, 10, 0.14);
		--line-strong: rgba(10, 10, 10, 0.32);
		--grid: rgba(10, 10, 10, 0.05);
		--grain: rgba(10, 10, 10, 0.05);
		--grain-blend: multiply;
	}
	body.vscode-dark,
	body.vscode-high-contrast:not(.vscode-high-contrast-light) {
		--bg: #000000;
		--bg-2: #0b0b0b;
		--ink: #ffffff;
		--ink-soft: #ededed;
		--muted: #8f8f8f;
		--muted-2: #5c5c5c;
		--accent: #d71921;
		--accent-soft: #ff5a5f;
		--line: rgba(255, 255, 255, 0.14);
		--line-strong: rgba(255, 255, 255, 0.32);
		--grid: rgba(255, 255, 255, 0.05);
		--grain: rgba(255, 255, 255, 0.05);
		--grain-blend: screen;
	}

	body {
		background: var(--bg);
		color: var(--ink);
		font-family: ${VINV_FONT_MONO};
		-webkit-font-smoothing: antialiased;
		font-feature-settings: 'ss01', 'ss02', 'cv11';
		margin: 0;
	}

	/* grid texture + film grain across the panel, like the site */
	body::before {
		content: '';
		position: fixed;
		inset: 0;
		pointer-events: none;
		background-image:
			linear-gradient(var(--grid) 1px, transparent 1px),
			linear-gradient(90deg, var(--grid) 1px, transparent 1px);
		background-size: 24px 24px;
		mix-blend-mode: var(--grain-blend);
		z-index: 0;
	}
	body::after {
		content: '';
		position: fixed;
		inset: 0;
		pointer-events: none;
		background-image: radial-gradient(var(--grain) 1px, transparent 1px);
		background-size: 3px 3px;
		opacity: 0.35;
		mix-blend-mode: var(--grain-blend);
		z-index: 0;
	}
	body > * { position: relative; z-index: 1; }

	/* ===== shared primitives ===== */

	/* uppercase micro-label, the site's signature typographic unit */
	.v-label {
		font-size: 10px;
		letter-spacing: 0.24em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.v-label::before { content: '// '; color: var(--accent); }

	/* serif-italic display heading */
	.v-display {
		font-family: ${VINV_FONT_SERIF};
		font-style: italic;
		font-weight: 400;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	/* site button: mono, uppercase, tracking grows on hover */
	.v-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 7px 14px;
		border: 1px solid var(--line-strong);
		background: transparent;
		color: var(--ink);
		font-family: ${VINV_FONT_MONO};
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		cursor: pointer;
		border-radius: 0;
		transition: background 0.2s, letter-spacing 0.25s, color 0.2s, border-color 0.2s;
	}
	.v-btn:hover { border-color: var(--ink); letter-spacing: 0.26em; }
	.v-btn.primary { background: var(--ink); border-color: var(--ink); color: var(--bg); }
	.v-btn.primary:hover { background: var(--accent); border-color: var(--accent); color: #ffffff; }
	.v-btn:disabled { opacity: 0.5; cursor: default; letter-spacing: 0.22em; }

	/* tiny bordered badge */
	.v-badge {
		font-size: 9px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		padding: 2px 7px;
		border: 1px solid currentColor;
		color: var(--muted);
		border-radius: 0;
	}

	/* pulsing live dot */
	.v-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 4px rgba(215, 25, 33, 0.18);
		animation: v-pulse 2.4s ease-in-out infinite;
	}
	@keyframes v-pulse {
		0%, 100% { box-shadow: 0 0 0 4px rgba(215, 25, 33, 0.18); }
		50% { box-shadow: 0 0 0 7px rgba(215, 25, 33, 0.05); }
	}

	::selection { background: var(--accent); color: #ffffff; }
`;
