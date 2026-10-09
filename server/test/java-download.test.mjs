import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('a missing compatible Java is downloaded, checked, and reused', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the extraction fixture uses tar on Linux');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-java-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousDataDir = process.env.BC_DATA_DIR;
  process.env.BC_DATA_DIR = path.join(root, 'data');
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.BC_DATA_DIR;
    else process.env.BC_DATA_DIR = previousDataDir;
  });

  const { ensureJava, resolveJava } = await import('../src/services/javaService.ts');
  if (resolveJava(25)) {
    t.skip('host already has Java 25 or newer');
    return;
  }

  const fakeRoot = path.join(root, 'jdk-25.0.0');
  const binDir = path.join(fakeRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const javaPath = path.join(binDir, 'java');
  fs.writeFileSync(javaPath, '#!/bin/sh\necho \'openjdk version "25.0.0" 2025-09-16\' >&2\n');
  fs.chmodSync(javaPath, 0o755);
  const archivePath = path.join(root, 'temurin-test.tar.gz');
  execFileSync('tar', ['czf', archivePath, '-C', root, 'jdk-25.0.0']);
  const archive = fs.readFileSync(archivePath);

  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    assert.match(String(url), /\/25\/ga\/linux\//);
    return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const progress = [];
  const first = await ensureJava('26.1', 'paper', (message) => progress.push(message));
  assert.equal(first.runtime?.major, 25);
  assert.equal(first.runtime?.source, 'managed');
  assert.equal(requests, 1);
  assert(progress.some((message) => message.includes('100%')));

  const second = await ensureJava('26.1', 'paper');
  assert.equal(second.runtime?.major, 25);
  assert.equal(requests, 1);
});
