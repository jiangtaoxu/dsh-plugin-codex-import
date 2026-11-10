import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportPlans } from '../src/import-plans.js';

test('import plans bind one-use confirmation to owner, expiry, successful IDs and absolute destinations', () => {
  const plans = new ImportPlans();
  const options = { taskMode: 'preview', dryRun: true, threadIds: ['old'], importAttachments: false };
  const report = { previewThreadIds: ['a', 'b', 'a', 'bad'], failed: [{ threadId: 'bad' }], total: 3,
    sourceHome: '/source', importWorkspacePath: '/target', workspaceTitle: 'Codex 导入', withBody: 2, metadataOnly: 0 };
  const proposal = plans.create('owner', options, report);
  options.threadIds.push('new'); report.previewThreadIds.push('later');
  assert.equal(proposal.count, 2); assert.equal(proposal.importAttachments, false);
  assert.throws(() => plans.confirm(proposal.token, 'other'), /失效/);
  assert.deepEqual(plans.confirm(proposal.token, 'owner'), {
    threadIds: ['a', 'b'], importAttachments: false, codexHome: '/source', importWorkspacePath: '/target',
  });
  assert.throws(() => plans.confirm(proposal.token, 'owner'), /失效/);
  const expired = plans.create('owner', {}, report);
  plans.plans.get(expired.token).expiresAt = Date.now() - 1;
  assert.throws(() => plans.confirm(expired.token, 'owner'), /失效/);
  assert.equal(plans.create('owner', {}, { ...report, previewThreadIds: ['bad'] }), undefined);
});
