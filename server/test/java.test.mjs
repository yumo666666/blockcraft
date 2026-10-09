import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCompatibleJava } from '../src/services/javaService.ts';
import { detectFailure } from '../src/launcher/index.ts';

function runtime(major, bin = `java-${major}`) {
  return { major, path: bin, home: `/jdk-${major}`, version: `Java ${major}`, source: 'system' };
}

test('Java selection never falls back below a Minecraft minimum', () => {
  assert.equal(selectCompatibleJava(null, [runtime(8)], 17), null);
  assert.equal(selectCompatibleJava(null, [runtime(8), runtime(21), runtime(17)], 17).major, 17);
});

test('an incompatible saved Java path is replaced by a compatible runtime', () => {
  assert.equal(selectCompatibleJava(runtime(8, 'old-java'), [runtime(17, 'java-17')], 17).path, 'java-17');
});

test('a configured compatible Java runtime remains selectable', () => {
  assert.equal(selectCompatibleJava(runtime(21, 'custom-java'), [runtime(17)], 17).path, 'custom-java');
});

test('localized Java arg-file startup errors receive a useful diagnosis', () => {
  assert.match(
    detectFailure('错误：找不到或无法加载主类 @user_jvm_args.txt'),
    /Java 版本过低或启动参数文件无法识别/,
  );
});
