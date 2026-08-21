// Bundle the three Vinv MCP servers (reused from the extension source) plus the
// multiplexer into self-contained CJS files under dist/. `vinv-mcp` runs
// dist/server.js, which spawns dist/{index,runtime,exercise}Server.js.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const common = {
	bundle: true,
	platform: 'node',
	target: 'node18',
	format: 'cjs',
	external: ['vscode'], // never imported at runtime by these servers; kept out of the bundle defensively
	logLevel: 'info',
};

for (const s of ['indexServer', 'runtimeServer', 'exerciseServer']) {
	await build({ ...common, entryPoints: [`../../extension/src/mcp/${s}.ts`], outfile: `dist/${s}.js` });
}
await build({
	...common,
	entryPoints: ['src/server.ts'],
	outfile: 'dist/server.js',
	banner: { js: '#!/usr/bin/env node' },
});
chmodSync('dist/server.js', 0o755);
console.log('built vinv-mcp → dist/');
