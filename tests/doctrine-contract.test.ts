import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

describe('quiet asynchronous coordination doctrine', () => {
  const swarmSkills = [
    'skill/SKILL.md',
    'skill/codex/swarm/SKILL.md',
    'skill/gemini/swarm/SKILL.md',
  ];

  test('every shipped swarm skill teaches one-packet goals, safe pickup, rescue, and metadata-only acknowledgements', () => {
    for (const relativePath of swarmSkills) {
      const contents = read(relativePath);
      assert.match(contents, /One goal[\s\S]*one (?:condition-complete )?final evidence packet or one true blocker/i, relativePath);
      assert.match(contents, /swarm inbox --wait 60/, relativePath);
      assert.match(contents, /swarm handoff offer[\s\S]*handoff accept/, relativePath);
      assert.match(contents, /--require-reply <ttl>[\s\S]*--reply-to <message-id>/, relativePath);
      assert.match(contents, /swarm rescue --task <slug>/, relativePath);
      assert.match(contents, /same-name (?:rejoin|replacement)[\s\S]*inherit/i, relativePath);
      assert.match(contents, /swarm ack <exact-id\.\.\.>/, relativePath);
      assert.doesNotMatch(contents, /acknowledge briefly|receipt-only reply[^;.\n]*required/i, relativePath);
    }
  });

  test('join skills do not reintroduce receipt chatter', () => {
    for (const relativePath of [
      'skill/join-swarm.md',
      'skill/codex/join-swarm/SKILL.md',
      'skill/gemini/join-swarm/SKILL.md',
    ]) {
      const contents = read(relativePath);
      assert.match(contents, /receipt-only acknowledgement|receipt-only reply/i, relativePath);
      assert.match(contents, /one (?:condition-complete )?final evidence packet or one true blocker/i, relativePath);
      assert.doesNotMatch(contents, /acknowledge briefly/i, relativePath);
    }
  });

  test('operator doctrine and prompt hook agree that a delivery need not receive a reply', () => {
    const org = read('docs/org-template.md');
    const orchestration = read('docs/orchestration.md');
    const indexSource = read('src/index.ts');
    assert.match(org, /One goal, one owner, one final packet/);
    assert.match(org, /No acks as messages/);
    assert.match(orchestration, /No acknowledgement messages/);
    assert.doesNotMatch(orchestration, /Ack the agent who tasked you/);
    assert.match(indexSource, /NEW MESSAGES \(review and act as needed; do not send receipt-only acknowledgements\)/);
    assert.doesNotMatch(indexSource, /NEW MESSAGES \(respond to these\)/);
  });

  test('the active adversarial-review override is explicit and exact-head bound', () => {
    const routing = read('docs/model-routing.md');
    assert.match(routing, /Active review-capacity override — 2026-07-30/);
    assert.match(routing, /xAI\/Grok plus AGY\/Gemini High/);
    assert.match(routing, /Do not launch\s+Claude for these reviews/);
    assert.match(routing, /do not reuse a verdict from an earlier SHA/i);
  });
});
