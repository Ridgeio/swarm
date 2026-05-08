import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSurface, registerSurface, removeSurface } from '../src/applescript-transport.js';

test('registerSurface accepts Warp terminal surfaces with tty metadata', () => {
  const previousTermProgram = process.env.TERM_PROGRAM;
  const previousSurfacesDir = process.env.SWARM_SURFACES_DIR;
  const surfacesDir = mkdtempSync(join(tmpdir(), 'swarm-surfaces-'));
  const swarmId = `warp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const agentName = 'WarpAgent';

  process.env.TERM_PROGRAM = 'WarpTerminal';
  process.env.SWARM_SURFACES_DIR = surfacesDir;
  try {
    const surface = registerSurface(swarmId, agentName);

    assert.ok(surface, 'expected Warp surface to register');
    assert.strictEqual(surface.app, 'Warp');
    assert.ok(Object.prototype.hasOwnProperty.call(surface, 'ttyDevice'));
    assert.strictEqual(hasSurface(swarmId, agentName), true);
  } finally {
    removeSurface(swarmId, agentName);
    if (previousTermProgram === undefined) {
      delete process.env.TERM_PROGRAM;
    } else {
      process.env.TERM_PROGRAM = previousTermProgram;
    }
    if (previousSurfacesDir === undefined) {
      delete process.env.SWARM_SURFACES_DIR;
    } else {
      process.env.SWARM_SURFACES_DIR = previousSurfacesDir;
    }
    rmSync(surfacesDir, { recursive: true, force: true });
  }
});
