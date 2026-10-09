import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { isTrackedChildAlive } from '../src/services/supervisor.ts';

test('a panel-tracked process remains identifiable without querying its OS command line', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });

  assert.equal(isTrackedChildAlive({ pid: child.pid, child }, child.pid), true);
  child.kill();
  await once(child, 'exit');
  assert.equal(isTrackedChildAlive({ pid: child.pid, child }, child.pid), false);
});
