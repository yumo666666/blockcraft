import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasLoaderEntry, loaderArgsPath, validateInstall } from '../src/launcher/index.ts';

function makeConfig(loader, mc, loaderVersion) {
  return {
    loader,
    mc,
    loaderVersion,
    javaMajor: 17,
    memoryMb: 3072,
    minMemoryMb: 1024,
    jvmExtra: '',
  };
}

function temporaryServer(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `blockcraft-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Forge install readiness checks the host-specific args file', (t) => {
  const serverDir = temporaryServer(t, 'forge');
  const cfg = makeConfig('forge', '1.20.1', '47.4.10');
  const unixArgs = path.join(serverDir, loaderArgsPath(cfg, 'linux'));
  fs.mkdirSync(path.dirname(unixArgs), { recursive: true });
  fs.writeFileSync(unixArgs, '');

  assert.equal(validateInstall(cfg, serverDir, 'linux').ok, true);
  assert.deepEqual(validateInstall(cfg, serverDir, 'win32').missing, [loaderArgsPath(cfg, 'win32')]);
  assert.equal(hasLoaderEntry(cfg, serverDir, 'linux'), true);
  assert.equal(hasLoaderEntry(cfg, serverDir, 'win32'), false);

  fs.writeFileSync(path.join(serverDir, loaderArgsPath(cfg, 'win32')), '');
  assert.equal(validateInstall(cfg, serverDir, 'win32').ok, true);
  assert.equal(hasLoaderEntry(cfg, serverDir, 'win32'), true);
});

test('NeoForge install readiness checks the host-specific args file', (t) => {
  const serverDir = temporaryServer(t, 'neoforge');
  const cfg = makeConfig('neoforge', '1.21.1', '21.1.1');
  const unixArgs = path.join(serverDir, loaderArgsPath(cfg, 'linux'));
  fs.mkdirSync(path.dirname(unixArgs), { recursive: true });
  fs.writeFileSync(unixArgs, '');

  assert.equal(validateInstall(cfg, serverDir, 'linux').ok, true);
  assert.deepEqual(validateInstall(cfg, serverDir, 'win32').missing, [loaderArgsPath(cfg, 'win32')]);
  assert.equal(hasLoaderEntry(cfg, serverDir, 'linux'), true);
  assert.equal(hasLoaderEntry(cfg, serverDir, 'win32'), false);

  fs.writeFileSync(path.join(serverDir, loaderArgsPath(cfg, 'win32')), '');
  assert.equal(validateInstall(cfg, serverDir, 'win32').ok, true);
  assert.equal(hasLoaderEntry(cfg, serverDir, 'win32'), true);
});

test('legacy Forge jar installations remain supported', (t) => {
  const serverDir = temporaryServer(t, 'forge-legacy');
  const cfg = makeConfig('forge', '1.16.5', '36.2.39');
  fs.writeFileSync(path.join(serverDir, 'forge-1.16.5-36.2.39.jar'), '');
  assert.equal(validateInstall(cfg, serverDir, 'win32').ok, true);
  assert.equal(hasLoaderEntry(cfg, serverDir, 'win32'), true);
});
