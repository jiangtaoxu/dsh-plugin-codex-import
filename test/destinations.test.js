import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDestinations, verifyDestination } from '../src/destinations.js';
import { ImportPlans } from '../src/import-plans.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-cwd-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, '原项目'); const fallback = join(root, '导入目录');
  await mkdir(project); await writeFile(join(project, 'source.txt'), '原项目文件');
  return { root, project, fallback };
}

test('default uses original existing projects and safely falls back for missing, file and relative paths', async t => {
  const f = await fixture(t); const missing = join(f.root, '不存在'); const notDirectory = join(f.root, '普通文件');
  await writeFile(notDirectory, 'data');
  const threads = [{ id: 'one', cwd: f.project }, { id: 'two', cwd: f.project }, { id: 'missing', cwd: missing },
    { id: 'file', cwd: notDirectory }, { id: 'relative', cwd: 'relative/path' }, { id: 'empty' }];
  const plan = await planDestinations(threads, { importWorkspacePath: f.fallback });
  assert.equal(plan.summary.mode, 'original'); assert.equal(plan.summary.originalSessions, 2);
  assert.equal(plan.summary.originalProjects, 1); assert.equal(plan.summary.fallbackSessions, 4);
  assert.equal(plan.entries.one.path, f.project); assert.equal(plan.entries.missing.path, f.fallback);
  await assert.rejects(() => readdir(missing), /ENOENT/); await assert.rejects(() => readdir(f.fallback), /ENOENT/);
  await verifyDestination(plan.entries.one);
  const unified = await planDestinations(threads, { groupByProject: false, importWorkspacePath: f.fallback });
  assert.ok(Object.values(unified.entries).every(row => row.path === f.fallback));
});

test('confirmed preview freezes exact work directories and rejects removed or replaced projects before writing', async t => {
  const f = await fixture(t); const threads = [{ id: 'one', cwd: f.project }];
  const options = { importWorkspacePath: f.fallback };
  const plan = await planDestinations(threads, options); const plans = new ImportPlans();
  const proposal = plans.create('owner', options, { failed: [], previewThreadIds: ['one'], previewDestinations: plan.entries,
    destinationSummary: plan.summary, groupByProject: true, sourceHome: '/source', importWorkspacePath: f.fallback });
  const frozen = plans.confirm(proposal.token, 'owner');
  assert.equal(frozen.groupByProject, true); assert.equal(frozen.reviewedDestinations.one.path, f.project);
  await assert.rejects(planDestinations([{ id: 'one', cwd: f.fallback }], frozen), /目录已变化/);
  await rename(f.project, join(f.root, 'old-project')); await mkdir(f.project);
  await assert.rejects(planDestinations(threads, frozen), /工作目录已变化/);
  await rm(f.project, { recursive: true });
  await assert.rejects(planDestinations(threads, frozen), /工作目录已变化/);
});

test('a recovered original directory does not silently expand a reviewed fallback assignment', async t => {
  const f = await fixture(t); const original = join(f.root, 'later-created'); const threads = [{ id: 'one', cwd: original }];
  const plan = await planDestinations(threads, { importWorkspacePath: f.fallback });
  await mkdir(original);
  const confirmed = await planDestinations(threads, { importWorkspacePath: f.fallback, reviewedDestinations: plan.entries });
  assert.equal(confirmed.entries.one.kind, 'fallback'); assert.equal(confirmed.entries.one.path, f.fallback);
});

test('symlink project target changes invalidate the reviewed working directory', async t => {
  const f = await fixture(t); const alias = join(f.root, 'alias'); await symlink(f.project, alias);
  const threads = [{ id: 'one', cwd: alias }]; const plan = await planDestinations(threads, { importWorkspacePath: f.fallback });
  assert.equal(plan.entries.one.path, alias);
  const replacement = join(f.root, 'replacement'); await mkdir(replacement); await rm(alias); await symlink(replacement, alias);
  await assert.rejects(planDestinations(threads, { importWorkspacePath: f.fallback, reviewedDestinations: plan.entries }), /工作目录已变化/);
});
