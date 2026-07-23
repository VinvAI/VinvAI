import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { runVSCodeCommand } from '@vscode/test-electron';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-packaged-e2e-'));
const vsix = path.join(temporary, 'vinv-vs.vsix');
const extracted = path.join(temporary, 'extracted');
const vinvHome = path.join(temporary, 'home');
const workspace = path.join(temporary, 'workspace');
const marker = path.join(temporary, 'index-was-called');
const profile = path.join(temporary, 'editor-profile');
const extensions = path.join(temporary, 'editor-extensions');

try {
  fs.mkdirSync(extracted);
  fs.mkdirSync(path.join(vinvHome, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.vinv', 'index'), { recursive: true });

  run(path.join(root, 'node_modules', '.bin', 'vsce'), [
    'package',
    '--no-rewrite-relative-links',
    '--out',
    vsix,
  ]);
  await runVSCodeCommand([
    '--install-extension',
    vsix,
    '--force',
    '--user-data-dir',
    profile,
    '--extensions-dir',
    extensions,
  ]);
  const installed = fs
    .readdirSync(extensions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('vinvai.vinvai-'));
  assert.equal(installed.length, 1, 'VSIX was not installed into the clean profile');
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(extensions, installed[0].name, 'package.json'), 'utf8'),
  );
  assert.equal(`${installedManifest.publisher}.${installedManifest.name}`, 'VinvAI.VinvAI');

  run('unzip', ['-q', vsix, '-d', extracted]);

  const extension = path.join(extracted, 'extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'VinvAI.VinvAI');
  assert.ok(fs.existsSync(path.join(extension, 'out', 'extension.js')));
  assert.ok(fs.existsSync(path.join(extension, 'out', 'mcp', 'indexServer.js')));
  assert.ok(fs.existsSync(path.join(extension, 'out', 'mcp', 'runtimeServer.js')));
  assert.equal(fs.existsSync(path.join(extension, 'src')), false);

  // A fake index binary in ~/.vinv/bin proves the server resolves and runs it
  // (no gating: tools always work in the open-source build).
  const fakeIndex = path.join(vinvHome, 'bin', 'index');
  fs.writeFileSync(
    fakeIndex,
    `#!/bin/sh\nprintf called > "${marker}"\nprintf '{"status":"ok","results":[]}\\n'\n`,
    { mode: 0o700 },
  );

  const responses = await invokeMcp(
    path.join(extension, 'out', 'mcp', 'indexServer.js'),
    workspace,
    vinvHome,
  );
  assert.equal(responses[0].result.serverInfo.name, 'vinv-index');
  assert.equal(responses[1].result.tools[0].name, 'vinv_query');
  assert.ok(responses[2].result, 'vinv_query should answer without any license gate');
  assert.equal(fs.existsSync(marker), true, 'index binary was not invoked');

  process.stdout.write('packaged VSIX MCP smoke passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function invokeMcp(serverPath, workspaceRoot, home) {
  const child = spawn(process.execPath, [serverPath, workspaceRoot], {
    env: { ...process.env, VINV_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    responses.push(JSON.parse(line));
  });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'vinv_query', arguments: { query: 'entry point' } },
    },
  ];
  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  const deadline = Date.now() + 5000;
  while (responses.length < requests.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill();
  if (responses.length !== requests.length) {
    throw new Error(`MCP returned ${responses.length}/${requests.length} responses`);
  }
  return responses;
}
