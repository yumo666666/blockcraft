import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import yazl from 'yazl';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-serverdir-import-'));
process.env.BC_DATA_DIR = path.join(temp, 'data');
process.env.BC_INSTANCE_DIR = path.join(temp, 'instances');

const { extractPack, inspectPack } = await import('../src/services/packService.ts');
const { instanceServerDir } = await import('../src/core/paths.ts');
const I = await import('../src/services/instanceService.ts');

after(() => fs.rmSync(temp, { recursive: true, force: true }));

async function makeZip(entries) {
  const zip = new yazl.ZipFile();
  const chunks = [];
  zip.outputStream.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => {
    zip.outputStream.once('end', resolve);
    zip.outputStream.once('error', reject);
  });
  for (const [name, contents] of Object.entries(entries)) zip.addBuffer(Buffer.from(contents), name);
  zip.end();
  await ended;
  return Buffer.concat(chunks);
}

test('server-directory import preserves launcher libraries and pack-specific root data', async () => {
  const instance = await I.createInstance({
    id: 'serverdirimporttest',
    name: 'Server directory import test',
    mc: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.3.33',
  });
  const file = path.join(temp, 'server-pack.zip');
  const bundledMod = await makeZip({
    'fabric.mod.json': JSON.stringify({ id: 'bundled_server_pack_mod', environment: 'client' }),
  });
  fs.writeFileSync(file, await makeZip({
    'server.properties': 'enforce-secure-profile=true\nserver-port=25565\n',
    'run.sh': 'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.33/unix_args.txt nogui\n',
    'libraries/net/minecraftforge/forge/1.20.1-47.3.33/unix_args.txt': '-p\njava.base\n',
    'mods/bundled.jar': bundledMod,
    'tlm_custom_pack/touhou_little_maid-1.0.0/assets/test.txt': 'maid model pack data',
    'hotai/com/example/data.bin': 'mod support data',
    'schematics/test.nbt': 'schematic data',
  }));

  const info = await inspectPack(file);
  assert.equal(info.format, 'serverdir');
  const logs = [];
  const result = await extractPack(file, instance.id, (line) => logs.push(line));
  const serverDir = instanceServerDir(instance.id);

  assert.ok(result.extracted >= 7);
  assert.deepEqual(result.manual, []);
  assert.equal(fs.readFileSync(path.join(serverDir, 'libraries/net/minecraftforge/forge/1.20.1-47.3.33/unix_args.txt'), 'utf8'), '-p\njava.base\n');
  assert.equal(fs.readFileSync(path.join(serverDir, 'run.sh'), 'utf8').includes('unix_args.txt'), true);
  assert.equal(fs.readFileSync(path.join(serverDir, 'tlm_custom_pack/touhou_little_maid-1.0.0/assets/test.txt'), 'utf8'), 'maid model pack data');
  assert.equal(fs.readFileSync(path.join(serverDir, 'hotai/com/example/data.bin'), 'utf8'), 'mod support data');
  assert.equal(fs.readFileSync(path.join(serverDir, 'schematics/test.nbt'), 'utf8'), 'schematic data');
  assert.equal(fs.existsSync(path.join(serverDir, 'mods/bundled.jar')), true);
  const properties = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
  assert.match(properties, /enforce-secure-profile=true/);
  assert.match(properties, new RegExp(`server-port=${instance.port}`));
  assert.match(logs.join('\n'), /完整解压服务端目录包/);
});
