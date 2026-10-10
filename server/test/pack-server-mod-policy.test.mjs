import assert from 'node:assert/strict';
import test from 'node:test';
import {
  curseForgeClientOnlyReason,
  fabricClientOnlyReason,
  forgeClientOnlyReason,
} from '../src/services/serverModPolicy.ts';

test('CurseForge Client-only tags exclude client mods from a dedicated server', () => {
  assert.match(curseForgeClientOnlyReason({ gameVersions: ['1.20.1', 'Forge', 'Client'] }), /仅客户端/);
  assert.equal(curseForgeClientOnlyReason({ gameVersions: ['1.20.1', 'Forge', 'Client', 'Server'] }), null);
});

test('Sodium Extras is excluded despite its missing CurseForge Server tag', () => {
  assert.match(curseForgeClientOnlyReason({ projectId: 558905, gameVersions: ['Forge', '1.20.1'] }), /未声明服务器兼容性/);
});

test('Fabric and Forge metadata can identify client-only mods', () => {
  assert.match(fabricClientOnlyReason('{"id":"continuity","environment":"client"}'), /environment=client/);
  assert.equal(fabricClientOnlyReason('{"id":"servermod","environment":"*"}'), null);
  assert.match(forgeClientOnlyReason('[[mods]]\nmodId="particle_effects"\nside="CLIENT"\n\n[[dependencies.particle_effects]]\nside="BOTH"'), /side=CLIENT/);
  assert.equal(forgeClientOnlyReason('[[mods]]\nmodId="commonmod"\nside="BOTH"'), null);
});
