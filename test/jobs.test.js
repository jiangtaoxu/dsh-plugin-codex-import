import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LocalJobs from '@deepseek-ai/dsh-jobs-local';
import { startImportJob } from '../src/jobs.js';

function report() {
  return { dryRun: false, total: 3, processed: 3, withBody: 3, metadataOnly: 0, imported: 2,
    skipped: 1, recovered: 0, failed: [], items: 9, rolloutRecords: 0, workspaces: 1, ungrouped: 0, warnings: [] };
}

async function registry(t) {
  const ctx = new Context();
  await ctx.plugin(LocalJobs, {});
  ctx.jobs.attachController('codex-import-test');
  t.after(() => ctx.fiber.dispose());
  return ctx;
}

test('native jobs start immediately, stream progress, and complete without an agent owner', async t => {
  const ctx = await registry(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const operation = async (_services, options, signal, progress) => {
    assert.equal(options.dryRun, false);
    progress({ phase: 'reading', total: 3, processed: 1, imported: 1 });
    await gate; signal.throwIfAborted();
    return report();
  };
  let settled = false;
  const task = startImportJob(ctx, {}, {}, new AbortController().signal, () => { settled = true; }, operation);
  assert.match(task.id, /^codex-import-/);
  assert.equal(ctx.jobs.get(task.id).status, 'running');
  assert.equal(ctx.jobs.get(task.id).owner, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ctx.jobs.readAt(task.id, 0).chunks.map(chunk => chunk.text).join(''), /"processed":1/);
  assert.ok(ctx.jobs.readAt(task.id, 0).chunks.every(chunk => chunk.channel === 'log'));
  release(); await task.done;
  await ctx.jobs.wait(task.id, 1000);
  assert.equal(ctx.jobs.get(task.id).status, 'completed'); assert.equal(settled, true);
  assert.match(ctx.jobs.readAt(task.id, 0).chunks.map(chunk => chunk.text).join(''), /"phase":"completed"/);
});

test('native job cancellation waits for producer cleanup and keeps partial statistics', async t => {
  const ctx = await registry(t);
  let cleaned = false;
  const operation = async (_services, _options, signal, progress) => {
    progress({ phase: 'writing', total: 3, processed: 1, imported: 1 });
    try {
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } finally { cleaned = true; }
  };
  const task = startImportJob(ctx, {}, {}, new AbortController().signal, () => {}, operation);
  await new Promise(resolve => setImmediate(resolve));
  ctx.jobs.kill(task.id, undefined, '用户取消');
  await task.done; await ctx.jobs.wait(task.id, 1000);
  assert.equal(cleaned, true); assert.equal(ctx.jobs.get(task.id).status, 'killed');
  const output = ctx.jobs.readAt(task.id, 0).chunks.map(chunk => chunk.text).join('');
  assert.match(output, /"phase":"cancelled"/); assert.match(output, /"imported":1/);
});

test('preview jobs preserve read-only mode and cancellation never issues confirmation', async t => {
  const ctx = await registry(t);
  const task = startImportJob(ctx, {}, { taskMode: 'preview' }, new AbortController().signal, () => {}, async (_s, options, signal, progress) => {
    assert.equal(options.dryRun, true);
    progress({ phase: 'reading', total: 3, processed: 0 });
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await new Promise(resolve => setImmediate(resolve));
  ctx.jobs.kill(task.id, undefined, 'cancel'); await task.done;
  const text = ctx.jobs.readAt(task.id, 0).chunks.map(c => c.text).join('');
  assert.match(text, /未复制任何会话或附件/); assert.doesNotMatch(text, /importProposal/);
});
