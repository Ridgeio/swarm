import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reviewGitGates, type GitFacts, type Task } from '../src/tasks.js';

/**
 * The gate exercised here replaced `merge-base --is-ancestor <head> <target>`,
 * which is UNSATISFIABLE in a squash-merging repo: a squash creates a new commit,
 * so a branch head never becomes an ancestor of the default branch. Measured on
 * PromptEden PR #1258 — reviewed head 746da24d was NOT an ancestor of origin/main
 * while its squash merge 985ee13d was, with exactly one parent. Four agents spent
 * six grants obeying a gate no grant could satisfy.
 *
 * Every case runs against a REAL repository with a REAL squash merge. The old
 * gate's defect was a wrong model of git's behaviour, and a mocked runner would
 * reproduce that model rather than test it.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-gate-'));
  git(dir, ['init', '--initial-branch=main', '-q']);
  git(dir, ['config', 'user.email', 't@t.invalid']);
  git(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

function pinOrigin(dir: string, target: string): void {
  git(dir, ['update-ref', 'refs/remotes/origin/main', target]);
  git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
}

/**
 * A COMPLETE GitFacts, not a cast. An earlier draft passed `{ head } as never`,
 * which silenced the type checker and crashed at runtime on facts.unpushed.length
 * — a required field that draft did not know existed. `as never` on a fixture
 * removes the one instrument that would have caught an incomplete fixture.
 */
function facts(head: string, branch: string): GitFacts {
  return { head, branch, dirtyTracked: 0, untracked: 0, unpushed: [] };
}

function review(dir: string, branch: string, head: string) {
  const task = { id: 'T', repo_path: dir, branch } as Task;
  return reviewGitGates(task, facts(head, branch), 'code-merged', 'merged', false, false);
}

describe('merged gate: squash merges recordable, no-ops refused', () => {
  test('GREEN — squash-merged branch records merged though its head is NOT an ancestor', () => {
    const dir = makeRepo();
    git(dir, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'work\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'feature work']);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();

    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '--squash', '-q', 'feature']);
    git(dir, ['commit', '-qm', 'squash: feature work']);
    const target = git(dir, ['rev-parse', 'HEAD']).trim();
    pinOrigin(dir, target);

    // Assert the precondition that made the OLD gate unsatisfiable, so this test
    // fails loudly if the fixture ever stops being a genuine squash.
    let isAncestor = true;
    try {
      git(dir, ['merge-base', '--is-ancestor', head, target]);
    } catch {
      isAncestor = false;
    }
    assert.equal(isAncestor, false, 'fixture must be a squash: head must NOT be an ancestor');
    const parents = git(dir, ['rev-list', '--parents', '-n1', target]).trim().split(/\s+/).length - 1;
    assert.equal(parents, 1, 'fixture must be a squash: merge commit has one parent');

    const r = review(dir, 'feature', head);
    assert.deepEqual(r.failures, [], 'squash-merged branch must pass the gate');
    assert.equal(r.mergedVerification?.method, 'content');
    assert.equal(r.mergedVerification?.comparedPaths, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('RED — a genuinely unmerged branch is still refused', () => {
    const dir = makeRepo();
    git(dir, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'work\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'feature work']);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();

    git(dir, ['checkout', '-q', 'main']);
    pinOrigin(dir, git(dir, ['rev-parse', 'HEAD']).trim());

    const r = review(dir, 'feature', head);
    assert.ok(
      r.failures.some(f => f.gate === 'git-default-branch-reachability'),
      'unmerged branch must be refused'
    );
    assert.equal(r.mergedVerification, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('RED — a branch whose commits change no paths is refused, not read as landed', () => {
    // PromptEden's manual records the false positive this guards: an empty content
    // diff is indistinguishable from a fully-merged one, and both --is-ancestor and
    // branch --contains report LANDED for a zero-commit branch. Replacing an
    // unfireable gate with an always-firing one is the same defect inverted.
    //
    // A DOCUMENTED LIMIT, established by measurement rather than assumed: a branch
    // with NO commits at all cannot be distinguished from a FAST-FORWARD merged one.
    // Both give head == target, is-ancestor yes, `rev-list target..head` 0, and zero
    // changed paths — after an ff-merge the branch's commits ARE the default
    // branch's history, so "did this branch do work" is not recoverable from
    // post-merge state. Refusing that shape would break every ff-merged close, so
    // the ancestry fast path accepts it. The guard therefore protects the CONTENT
    // path, which is where the squash case lives and where the risk actually is.
    //
    // The constructible risk is a branch with a commit that changes nothing: NOT an
    // ancestor, so it reaches the content path, and it touches zero paths.
    const dir = makeRepo();
    git(dir, ['checkout', '-qb', 'noop']);
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'empty: no changes']);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', 'main']);
    const target = git(dir, ['rev-parse', 'HEAD']).trim();
    pinOrigin(dir, target);

    // Assert the preconditions, so this test fails loudly if the fixture stops
    // exercising the content path.
    let isAncestor = true;
    try {
      git(dir, ['merge-base', '--is-ancestor', head, target]);
    } catch {
      isAncestor = false;
    }
    assert.equal(isAncestor, false, 'fixture must reach the content path, not the ancestry fast path');

    const r = review(dir, 'noop', head);
    assert.match(r.failures.map(f => f.message).join(' '), /changes no paths/);
    assert.equal(r.mergedVerification, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
