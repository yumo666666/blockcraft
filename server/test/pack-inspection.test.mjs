import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import yazl from 'yazl';
import { classifyPackZip, curseForgeClientSkipReason, downloadWithFallback, filterClientOnlyMods, hasFabricModBridge, inspectPack, installClassifiedPackZip, isModrinthServerModFile, jarDeclaresCurseForgeDependency, missingRequiredModDependencies, requiredCurseForgeDependencyProjects, validatePackRuntimeSelection } from '../src/services/packService.ts';

const cases = [
  { name: 'All the Mods 10', mc: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.251', files: 495, ram: 8196 },
  { name: 'BMC4', mc: '1.20.1', loader: 'forge', loaderVersion: '47.4.20', files: 425, ram: 10112 },
  { name: 'COBBLEVERSE', mc: '1.21.1', loader: 'fabric', loaderVersion: '0.18.4', files: 141, optional: 1, ram: 6144 },
  { name: 'Homestead', mc: '1.20.1', loader: 'fabric', loaderVersion: '0.18.4', files: 346, ram: null },
  { name: 'TechRevolution', mc: '1.19.2', loader: 'forge', loaderVersion: '43.5.2', files: 503, ram: 12288 },
  { name: 'ZombieCraft 3.4', mc: '1.20.1', loader: 'forge', loaderVersion: '47.4.18', files: 367, optional: 1, ram: 10000 },
  { name: 'FTB OceanBlock 2', mc: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.248', files: 311, ram: 6144 },
];

async function writeManifestZip(file, item) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({
    name: item.name,
    version: 'test',
    minecraft: {
      version: item.mc,
      modLoaders: [{ id: `${item.loader}-${item.loaderVersion}`, primary: true }],
      ...(item.ram ? { recommendedRam: item.ram } : {}),
    },
    files: Array.from({ length: item.files + (item.optional ?? 0) }, (_, i) => ({
      projectID: i + 1,
      fileID: i + 1001,
      ...(i >= item.files ? { required: false } : {}),
    })),
    overrides: 'overrides',
  })), 'manifest.json');
  const output = fs.createWriteStream(file);
  zip.outputStream.pipe(output);
  zip.end();
  await finished(output);
}

async function makeZipBuffer(entries) {
  const zip = new yazl.ZipFile();
  const chunks = [];
  zip.outputStream.on('data', (chunk) => chunks.push(chunk));
  const ended = once(zip.outputStream, 'end');
  for (const [name, contents] of Object.entries(entries)) zip.addBuffer(Buffer.from(contents), name);
  zip.end();
  await ended;
  return Buffer.concat(chunks);
}

test('the seven supplied CurseForge manifests retain Minecraft, loader, version, and RAM advice', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-pack-inspection-'));
  try {
    for (const [index, item] of cases.entries()) {
      const file = path.join(temp, `${index}.zip`);
      await writeManifestZip(file, item);
      const info = await inspectPack(file);
      assert.equal(info.format, 'curseforge', item.name);
      assert.equal(info.packName, item.name, item.name);
      assert.equal(info.mc, item.mc, item.name);
      assert.equal(info.loader, item.loader, item.name);
      assert.equal(info.loaderVersion, item.loaderVersion, item.name);
      assert.equal(info.filesToDownload, item.files, item.name);
      assert.equal(info.optionalFiles, item.optional ?? 0, item.name);
      assert.equal(info.recommendedRamMb, item.ram, item.name);
      assert.deepEqual(validatePackRuntimeSelection(info, {
        mc: item.mc, loader: item.loader, loaderVersion: item.loaderVersion,
      }), { mc: item.mc, loader: item.loader, loaderVersion: item.loaderVersion });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('pack import rejects a Minecraft or loader selection that contradicts the manifest', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-pack-runtime-'));
  try {
    const item = cases[0];
    const file = path.join(temp, 'atm10.zip');
    await writeManifestZip(file, item);
    const info = await inspectPack(file);
    assert.throws(
      () => validatePackRuntimeSelection(info, { mc: '1.20.1', loader: 'forge', loaderVersion: '47.4.20' }),
      /requires.*1\.21\.1.*neoforge.*21\.1\.251/i,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Modrinth quilt-loader packs keep their declared runtime and server-only file policy', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-modrinth-quilt-'));
  try {
    const file = path.join(temp, 'quilt-pack.mrpack');
    fs.writeFileSync(file, await makeZipBuffer({
      'modrinth.index.json': JSON.stringify({
        name: 'Quilt Test Pack',
        dependencies: { minecraft: '1.20.4', 'quilt-loader': '0.26.3' },
        files: [
          { path: 'mods/client.jar', downloads: [], env: { client: 'required', server: 'unsupported' } },
          { path: 'mods/server.jar', downloads: [], env: { client: 'unsupported', server: 'required' } },
        ],
      }),
    }));
    const info = await inspectPack(file);
    assert.equal(info.format, 'modrinth');
    assert.equal(info.mc, '1.20.4');
    assert.equal(info.loader, 'quilt');
    assert.equal(info.loaderVersion, '0.26.3');
    assert.equal(info.filesToDownload, 2);
    assert.equal(isModrinthServerModFile({ path: 'mods/client.jar', env: { server: 'unsupported' } }), false);
    assert.equal(isModrinthServerModFile({ path: 'mods/server.jar', env: { server: 'required' } }), true);
    assert.equal(isModrinthServerModFile({ path: 'mods/unspecified.jar' }), true);
    assert.equal(isModrinthServerModFile({ path: 'resourcepacks/test.zip' }), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('pack file downloads time out while idle and retry the request', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-pack-download-timeout-'));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    if (requests > 1) response.end('retried successfully');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const logs = [];
  try {
    const dest = path.join(temp, 'mod.jar');
    assert.equal(await downloadWithFallback([`http://127.0.0.1:${address.port}/stalled`], dest, (line) => logs.push(line), 100), true);
    assert.equal(requests, 2);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'retried successfully');
    assert.match(logs[0], /重试/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('client-only jars bundled in overrides are moved out of the server mods directory', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-embedded-mods-'));
  try {
    const mods = path.join(temp, 'mods');
    fs.mkdirSync(mods);
    fs.writeFileSync(path.join(mods, 'client.jar'), await makeZipBuffer({
      'fabric.mod.json': '{"id":"clientmod","environment":"client"}',
    }));
    fs.writeFileSync(path.join(mods, 'common.jar'), await makeZipBuffer({
      'fabric.mod.json': '{"id":"commonmod","environment":"*"}',
    }));
    const logs = [];
    assert.equal(await filterClientOnlyMods(temp, (line) => logs.push(line)), 1);
    assert.equal(fs.existsSync(path.join(mods, 'client.jar')), false);
    assert.equal(fs.existsSync(path.join(temp, 'client-mods', 'overrides', 'client.jar')), true);
    assert.equal(fs.existsSync(path.join(mods, 'common.jar')), true);
    assert.match(logs[0], /client\.jar.*environment=client/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('CurseForge ZIP files are distinguished as resource packs, datapacks, combined packs, or shaders', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-pack-zip-kind-'));
  try {
    const cases = [
      { name: 'resources.zip', kind: 'resourcepack', entries: { 'pack.mcmeta': '{}', 'assets/example/test.txt': 'x' } },
      { name: 'data.zip', kind: 'datapack', entries: { 'pack.mcmeta': '{}', 'data/example/functions/test.mcfunction': 'say ok' } },
      { name: 'combined.zip', kind: 'combined', entries: { 'pack.mcmeta': '{}', 'assets/example/test.txt': 'x', 'data/example/functions/test.mcfunction': 'say ok' } },
      { name: 'shaderpack.zip', kind: 'shaderpack', entries: { 'shaders/program/test.glsl': 'void main() {}' } },
      { name: 'unknown.zip', kind: null, entries: { 'readme.txt': 'not a Minecraft pack' } },
    ];
    for (const item of cases) {
      const file = path.join(temp, item.name);
      fs.writeFileSync(file, await makeZipBuffer(item.entries));
      assert.equal(await classifyPackZip(file), item.kind, item.name);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('shader ZIP dependencies are kept under client-files instead of blocking a server import', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-install-shaderpack-'));
  try {
    const source = path.join(temp, 'shaderpack.zip');
    const resources = path.join(temp, 'server', 'resourcepacks');
    const datapacks = path.join(temp, 'server', 'world', 'datapacks');
    const shaders = path.join(temp, 'server', 'client-files', 'shaderpacks');
    fs.writeFileSync(source, await makeZipBuffer({ 'shaders/program/test.glsl': 'void main() {}' }));
    assert.equal(await installClassifiedPackZip(source, 'shaderpack.zip', resources, datapacks, shaders), 'shaderpack');
    assert.equal(fs.existsSync(path.join(shaders, 'shaderpack.zip')), true);
    assert.equal(fs.existsSync(path.join(resources, 'shaderpack.zip')), false);
    assert.equal(fs.existsSync(source), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('datapack ZIP dependencies are installed under the world datapacks directory', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-install-datapack-'));
  try {
    const source = path.join(temp, 'better-end-cities.zip');
    const resources = path.join(temp, 'server', 'resourcepacks');
    const datapacks = path.join(temp, 'server', 'world', 'datapacks');
    fs.writeFileSync(source, await makeZipBuffer({
      'pack.mcmeta': '{}',
      'data/betterend/structures/end_city/ship.nbt': 'world-data',
    }));
    assert.equal(await installClassifiedPackZip(source, 'better-end-cities.zip', resources, datapacks), 'datapack');
    assert.equal(fs.existsSync(path.join(datapacks, 'better-end-cities.zip')), true);
    assert.equal(fs.existsSync(path.join(resources, 'better-end-cities.zip')), false);
    assert.equal(fs.existsSync(source), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('CurseForge dependency relations are checked against the jar mod IDs', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-dependency-relations-'));
  try {
    const jar = path.join(temp, 'example.jar');
    fs.writeFileSync(jar, await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'example', depends: { 'fabric-api': '*', 'fabric-language-kotlin': '*' } }),
    }));
    assert.equal(await jarDeclaresCurseForgeDependency(jar, 1234, { slug: 'fabric-api' }), true);
    assert.equal(await jarDeclaresCurseForgeDependency(jar, 1235, { slug: 'kotlin-for-forge', name: 'Kotlin for Forge' }), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('multi-loader jars are checked against only the active loader manifest', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-multiloader-dependency-'));
  try {
    const jar = path.join(temp, 'hybrid.jar');
    fs.writeFileSync(jar, await makeZipBuffer({
      'META-INF/mods.toml': '[[mods]]\nmodId="hybridmod"\nversion="1.0"',
      'fabric.mod.json': JSON.stringify({ id: 'hybridmod', depends: { 'fabric-api': '*' } }),
    }));
    assert.equal(await jarDeclaresCurseForgeDependency(jar, 306612, { slug: 'fabric-api' }, 'forge'), false);
    assert.equal(await jarDeclaresCurseForgeDependency(jar, 306612, { slug: 'fabric-api' }, 'fabric'), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('required server dependencies override incomplete CurseForge client-only tags', () => {
  const files = [
    {
      id: 1,
      projectId: 100,
      fileName: 'server-mod.jar',
      gameVersions: ['1.20.1', 'Forge', 'Server'],
      dependencies: [{ modId: 200, relationType: 3 }],
    },
    {
      id: 2,
      projectId: 200,
      fileName: 'required-library.jar',
      gameVersions: ['1.20.1', 'Forge', 'Client'],
    },
    {
      id: 3,
      projectId: 300,
      fileName: 'client-mod.jar',
      gameVersions: ['1.20.1', 'Forge', 'Client'],
      dependencies: [{ modId: 400, relationType: 3 }],
    },
  ];
  const required = requiredCurseForgeDependencyProjects(files);
  assert.deepEqual([...required], [200]);
  assert.equal(curseForgeClientSkipReason(files[1], required), null);
  assert.match(curseForgeClientSkipReason(files[2], required), /仅客户端/);
});

test('server dependency validation counts Jar-in-Jar libraries and reports missing required mods', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-required-jar-dependencies-'));
  try {
    const mods = path.join(temp, 'mods');
    fs.mkdirSync(mods);
    fs.writeFileSync(path.join(mods, 'server-mod.jar'), await makeZipBuffer({
      'META-INF/mods.toml': '[[mods]]\nmodId="servermod"\n\n[[dependencies.servermod]]\nmodId="embeddedlib"\nmandatory=true\nside="BOTH"\n\n[[dependencies.servermod]]\nmodId="missinglib"\nmandatory=true\nside="BOTH"',
      'META-INF/jarjar/metadata.json': JSON.stringify({ jars: [{ identifier: { group: 'example.embeddedlib', artifact: 'embeddedlib-forge' } }] }),
    }));
    assert.deepEqual(await missingRequiredModDependencies(mods, 'forge'), ['missinglib']);
    fs.writeFileSync(path.join(mods, 'missing.jar'), await makeZipBuffer({
      'META-INF/mods.toml': '[[mods]]\nmodId="missinglib"',
    }));
    assert.deepEqual(await missingRequiredModDependencies(mods, 'forge'), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Forge validation reads mod IDs from legacy embedded connector jars without Jar-in-Jar metadata', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-legacy-embedded-dependency-'));
  try {
    const mods = path.join(temp, 'mods');
    fs.mkdirSync(mods);
    const embedded = await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'connectormod', depends: { fabricloader: '>=0.15.0' } }),
    });
    fs.writeFileSync(path.join(mods, 'connector.jar'), await makeZipBuffer({
      'META-INF/mods.toml': '[[mods]]\nmodId="connector"\n\n[[dependencies.connector]]\nmodId="connectormod"\nmandatory=true\nside="BOTH"',
      'META-INF/jarjar/Connector-mod.jar': embedded,
    }));
    assert.deepEqual(await missingRequiredModDependencies(mods, 'forge'), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Fabric dependency fallback requires Connector in the server mods directory', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-fabric-bridge-'));
  try {
    assert.equal(hasFabricModBridge(temp), false);
    fs.writeFileSync(path.join(temp, 'Connector-1.0.0-beta.jar'), '');
    assert.equal(hasFabricModBridge(temp), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Fabric dependency validation recognizes nested Fabric API modules and ignores inactive Fabric metadata on Forge', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-fabric-required-dependencies-'));
  try {
    const mods = path.join(temp, 'mods');
    fs.mkdirSync(mods);
    fs.writeFileSync(path.join(mods, 'fabric-api.jar'), await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'fabric-api', jars: [{ file: 'META-INF/jars/fabric-api-base-0.4.42.jar' }] }),
    }));
    fs.writeFileSync(path.join(mods, 'fabric-mod.jar'), await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'fabricmod', depends: { 'fabric-api-base': '*', missinglib: '*' } }),
    }));
    assert.deepEqual(await missingRequiredModDependencies(mods, 'fabric'), ['missinglib']);

    const nestedMods = path.join(temp, 'nested-mods');
    fs.mkdirSync(nestedMods);
    const nestedJar = await makeZipBuffer({ 'fabric.mod.json': JSON.stringify({ id: 'fabric_module_base' }) });
    fs.writeFileSync(path.join(nestedMods, 'mod-bundle.jar'), await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'modbundle', depends: { fabric_module_base: '*' }, jars: [{ file: 'META-INF/jars/module-base-1.0.jar' }] }),
      'META-INF/jars/module-base-1.0.jar': nestedJar,
    }));
    assert.deepEqual(await missingRequiredModDependencies(nestedMods, 'fabric'), []);

    const tolerantMods = path.join(temp, 'tolerant-mods');
    fs.mkdirSync(tolerantMods);
    fs.writeFileSync(path.join(tolerantMods, 'provider.jar'), await makeZipBuffer({
      'fabric.mod.json': '{"id":"valid_provider","description":"Published with\na raw newline","environment":"*"}',
    }));
    fs.writeFileSync(path.join(tolerantMods, 'consumer.jar'), await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'consumer', depends: { valid_provider: '*' } }),
    }));
    assert.deepEqual(await missingRequiredModDependencies(tolerantMods, 'fabric'), []);

    fs.writeFileSync(path.join(mods, 'hybrid.jar'), await makeZipBuffer({
      'META-INF/mods.toml': '[[mods]]\nmodId="hybridmod"',
      'fabric.mod.json': JSON.stringify({ id: 'hybridmod', depends: { inactivefabricdep: '*' } }),
    }));
    assert.deepEqual(await missingRequiredModDependencies(mods, 'forge'), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Fabric dependency validation follows multiple nested jars such as Polymer Common', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-nested-polymer-'));
  try {
    const mods = path.join(temp, 'mods');
    fs.mkdirSync(mods);
    const polymerCommon = await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'polymer-common', depends: { minecraft: '>=1.20' } }),
    });
    const polymerResource = await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({
        id: 'polymer-resource-pack',
        jars: [{ file: 'META-INF/jars/polymer-common.jar' }],
      }),
      'META-INF/jars/polymer-common.jar': polymerCommon,
    });
    const graves = await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({
        id: 'universal-graves',
        depends: { 'polymer-common': '*' },
        jars: [{ file: 'META-INF/jars/polymer-resource-pack.jar' }],
      }),
      'META-INF/jars/polymer-resource-pack.jar': polymerResource,
    });
    fs.writeFileSync(path.join(mods, 'graves.jar'), graves);
    assert.deepEqual(await missingRequiredModDependencies(mods, 'fabric'), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Quilt metadata provides Fabric aliases and nested API modules', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-quilt-aliases-'));
  try {
    const mods = path.join(temp, 'mods');
    fs.mkdirSync(mods);
    const resourceLoader = await makeZipBuffer({
      'quilt.mod.json': JSON.stringify({
        quilt_loader: {
          id: 'quilted_fabric_resource_loader_v0',
          provides: ['fabric-resource-loader-v0'],
        },
      }),
    });
    fs.writeFileSync(path.join(mods, 'qfapi.jar'), await makeZipBuffer({
      'quilt.mod.json': JSON.stringify({
        quilt_loader: {
          id: 'quilted_fabric_api',
          provides: ['fabric-api', 'fabric'],
          depends: ['quilt_loader', { id: 'quilted_fabric_optional_test', optional: true }],
          jars: ['META-INF/jars/resource-loader.jar'],
        },
      }),
      'META-INF/jars/resource-loader.jar': resourceLoader,
    }));
    fs.writeFileSync(path.join(mods, 'consumer.jar'), await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({
        id: 'legacy_fabric_consumer',
        depends: { fabric: '*', 'fabric-resource-loader-v0': '*' },
      }),
    }));
    assert.deepEqual(await missingRequiredModDependencies(mods, 'quilt'), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a server mod that requires a client-only mod is moved out with its dependency chain', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcraft-client-dependency-chain-'));
  try {
    const mods = path.join(temp, 'mods');
    fs.mkdirSync(mods);
    const clientMods = path.join(temp, 'client-mods', '455508');
    fs.mkdirSync(clientMods, { recursive: true });
    fs.writeFileSync(path.join(clientMods, 'iris.jar'), await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'iris', environment: 'client' }),
    }));
    fs.writeFileSync(path.join(mods, 'colorwheel.jar'), await makeZipBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'colorwheel', environment: '*', depends: { iris: '>=1.7.0' } }),
    }));
    const logs = [];
    assert.equal(await filterClientOnlyMods(temp, (line) => logs.push(line), 'fabric'), 1);
    assert.equal(fs.existsSync(path.join(mods, 'iris.jar')), false);
    assert.equal(fs.existsSync(path.join(mods, 'colorwheel.jar')), false);
    assert.equal(fs.existsSync(path.join(clientMods, 'iris.jar')), true);
    assert.equal(fs.existsSync(path.join(temp, 'client-mods', 'overrides', 'colorwheel.jar')), true);
    assert.match(logs.join('\n'), /colorwheel\.jar.*iris.*客户端/);
    assert.deepEqual(await missingRequiredModDependencies(mods, 'fabric'), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
