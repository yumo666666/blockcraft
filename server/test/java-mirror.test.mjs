import assert from 'node:assert/strict';
import test from 'node:test';
import { javaMirrorSource, pickJavaArchive } from '../src/services/javaService.ts';
import { minecraftManifestUrl, minecraftServerUrls } from '../src/services/installService.ts';

const adoptiumIndex = `
<html><body>
  <a href="OpenJDK17U-jdk_x64_windows_hotspot_17.0.9.zip">old</a>
  <a href="OpenJDK17U-jdk_x64_windows_hotspot_17.0.10_1.zip">new</a>
  <a href="OpenJDK17U-jdk_x64_windows_hotspot_17.0.10_1.msi">installer</a>
  <a href="OpenJDK17U-jdk_x64_windows_hotspot_17.0.10_1.zip.sha256.txt">checksum</a>
</body></html>`;

test('Adoptium mirror picks the newest JDK archive and ignores installers/checksums', () => {
  assert.equal(pickJavaArchive(adoptiumIndex, 17, '.zip'), 'OpenJDK17U-jdk_x64_windows_hotspot_17.0.10_1.zip');
  assert.equal(pickJavaArchive(adoptiumIndex, 17, '.tar.gz'), null);
  assert.equal(pickJavaArchive(adoptiumIndex, 21, '.zip'), null);
});

test('Java mirror presets and custom roots are normalized', () => {
  assert.match(javaMirrorSource({ javaSource: 'tuna' }).base, /mirrors\.tuna\.tsinghua\.edu\.cn\/Adoptium$/);
  assert.match(javaMirrorSource({ javaSource: 'nju' }).base, /mirrors\.nju\.edu\.cn\/adoptium$/);
  assert.equal(javaMirrorSource({ javaSource: 'custom', javaMirror: 'https://mirror.example.com/Adoptium/' }).base, 'https://mirror.example.com/Adoptium');
  assert.equal(javaMirrorSource({ javaSource: 'custom', javaMirror: 'not a url' }), null);
  assert.equal(javaMirrorSource({ javaSource: 'official' }), null);
});

test('Minecraft source switches manifest and server URLs, keeping a fallback', () => {
  const officialServer = 'https://piston-data.mojang.com/v1/objects/abc/server.jar';
  assert.match(minecraftManifestUrl('bmclapi'), /^https:\/\/bmclapi2\.bangbang93\.com\//);
  assert.match(minecraftManifestUrl('official'), /^https:\/\/piston-meta\.mojang\.com\//);
  assert.deepEqual(minecraftServerUrls('bmclapi', '1.20.1', officialServer), [
    'https://bmclapi2.bangbang93.com/version/1.20.1/server',
    officialServer,
  ]);
  assert.deepEqual(minecraftServerUrls('official', '1.20.1', officialServer), [officialServer]);
});
