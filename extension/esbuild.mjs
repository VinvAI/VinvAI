// Bundle + minify the extension and its standalone entry points into single
// CommonJS files — the ship build keeps the vsix small and dependency-free.
// (Type-checking still runs via `tsc --noEmit` in `npm run check`; esbuild only
// transpiles/bundles.)
//
// Each entry keeps its output path because those paths are load-bearing:
//   out/extension.js        — package.json `main`
//   out/mcp/indexServer.js  — launched as `node .../out/mcp/indexServer.js`
//   out/mcp/runtimeServer.js— launched as `node .../out/mcp/runtimeServer.js`
//
// `vscode` is provided by the host at runtime and must stay external; node
// builtins are external automatically for platform:node.
import { build } from 'esbuild';
import { rmSync } from 'fs';

// Start from a clean out/: the dev `tsc` build emits per-file JS (and the test
// sources) into out/. Wiping it first guarantees the packaged extension
// contains only the bundles.
rmSync('out', { recursive: true, force: true });

/** @type {import('esbuild').BuildOptions} */
const shared = {
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	external: ['vscode'],
	minify: true,
	sourcemap: false,
	legalComments: 'none',
	logLevel: 'info',
	// Telemetry destination, resolved at BUILD time.
	//
	// The PostHog project key is public and write-only — shipping it inside the
	// client is how PostHog is meant to be used — so src/telemetry/common.ts
	// carries the production key as a plain constant and a default build just
	// works. These overrides exist so a local build can be pointed at a scratch
	// project instead: `VINV_POSTHOG_KEY=phc_dev npm run bundle`. Empty strings
	// fall through to the constants, which is why they are `||` there, not `??`.
	define: {
		'process.env.VINV_POSTHOG_KEY': JSON.stringify(process.env.VINV_POSTHOG_KEY ?? ''),
		'process.env.VINV_POSTHOG_HOST': JSON.stringify(process.env.VINV_POSTHOG_HOST ?? ''),
	},
};

const entries = {
	'out/extension.js': 'src/extension.ts',
	'out/mcp/indexServer.js': 'src/mcp/indexServer.ts',
	'out/mcp/runtimeServer.js': 'src/mcp/runtimeServer.ts',
	'out/mcp/exerciseServer.js': 'src/mcp/exerciseServer.ts',
};

await Promise.all(
	Object.entries(entries).map(([outfile, entry]) =>
		build({ ...shared, entryPoints: [entry], outfile }),
	),
);
