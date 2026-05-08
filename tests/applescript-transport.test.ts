import { test, mock } from 'node:test';
import assert from 'node:assert';
import childProcess from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppleScriptTransport, hasSurface, registerSurface, removeSurface } from '../src/applescript-transport.js';

function surfaceFile(surfacesDir: string, swarmId: string, agentName: string): string {
  return join(surfacesDir, swarmId, `${agentName}.json`);
}

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

test('registerSurface persists pushEnabled for Warp when requested', () => {
  const previousTermProgram = process.env.TERM_PROGRAM;
  const previousSurfacesDir = process.env.SWARM_SURFACES_DIR;
  const surfacesDir = mkdtempSync(join(tmpdir(), 'swarm-surfaces-'));
  const swarmId = `warp-push-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const agentName = 'WarpAgent';

  process.env.TERM_PROGRAM = 'WarpTerminal';
  process.env.SWARM_SURFACES_DIR = surfacesDir;
  try {
    const surface = registerSurface(swarmId, agentName, true);

    assert.ok(surface, 'expected Warp surface to register');
    assert.strictEqual(surface.pushEnabled, true);

    const saved = JSON.parse(readFileSync(surfaceFile(surfacesDir, swarmId, agentName), 'utf-8'));
    assert.strictEqual(saved.app, 'Warp');
    assert.strictEqual(saved.pushEnabled, true);
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

test('Warp surface without pushEnabled returns stub error without attempting push', async () => {
  const previousSurfacesDir = process.env.SWARM_SURFACES_DIR;
  const surfacesDir = mkdtempSync(join(tmpdir(), 'swarm-surfaces-'));
  const swarmId = 'warp-default-test';
  const agentName = 'WarpAgent';
  mkdirSync(join(surfacesDir, swarmId), { recursive: true });
  writeFileSync(surfaceFile(surfacesDir, swarmId, agentName), JSON.stringify({ app: 'Warp' }, null, 2));
  process.env.SWARM_SURFACES_DIR = surfacesDir;

  const execMock = mock.method(childProcess, 'execFileSync', () => {
    throw new Error('should not be called');
  });

  try {
    const transport = new AppleScriptTransport();
    const result = await transport.deliverMessage({
      swarm_id: swarmId,
      name: agentName,
      agent_type: 'headless',
      surface_id: `headless:${swarmId}:${agentName}`,
      workspace_id: null,
      endpoint_url: null,
    }, '[SWARM from Lead]: hello');

    assert.strictEqual(result.delivered, false);
    assert.match(result.error ?? '', /Warp push delivery not yet implemented/);
    assert.strictEqual(execMock.mock.callCount(), 0);
  } finally {
    execMock.mock.restore();
    if (previousSurfacesDir === undefined) {
      delete process.env.SWARM_SURFACES_DIR;
    } else {
      process.env.SWARM_SURFACES_DIR = previousSurfacesDir;
    }
    rmSync(surfacesDir, { recursive: true, force: true });
  }
});

test('Warp push delivery reports accessibility fallback when osascript fails', async () => {
  const previousSurfacesDir = process.env.SWARM_SURFACES_DIR;
  const surfacesDir = mkdtempSync(join(tmpdir(), 'swarm-surfaces-'));
  const swarmId = 'warp-accessibility-test';
  const agentName = 'WarpAgent';
  mkdirSync(join(surfacesDir, swarmId), { recursive: true });
  writeFileSync(surfaceFile(surfacesDir, swarmId, agentName), JSON.stringify({ app: 'Warp', pushEnabled: true }, null, 2));
  process.env.SWARM_SURFACES_DIR = surfacesDir;

  const execMock = mock.method(childProcess, 'execFileSync', () => {
    throw new Error('not authorized to send Apple events to System Events');
  });

  try {
    const transport = new AppleScriptTransport();
    const result = await transport.deliverMessage({
      swarm_id: swarmId,
      name: agentName,
      agent_type: 'headless',
      surface_id: `headless:${swarmId}:${agentName}`,
      workspace_id: null,
      endpoint_url: null,
    }, '[SWARM from Lead]: hello');

    assert.strictEqual(result.delivered, false);
    assert.match(result.error ?? '', /Accessibility access required for Warp push delivery/);
    assert.match(result.error ?? '', /Falling back to inbox queue/);
    assert.strictEqual(execMock.mock.callCount(), 1);
  } finally {
    execMock.mock.restore();
    if (previousSurfacesDir === undefined) {
      delete process.env.SWARM_SURFACES_DIR;
    } else {
      process.env.SWARM_SURFACES_DIR = previousSurfacesDir;
    }
    rmSync(surfacesDir, { recursive: true, force: true });
  }
});
