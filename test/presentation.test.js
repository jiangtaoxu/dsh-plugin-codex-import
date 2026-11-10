import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { importedRecord, recordDefinition, ImportedRecordCard, filterCatalog, catalogProjects } from '../src/presentation.js';

const message = { seq: 7, type: 'assistant/message', time: 1, data: { message: {
  id: 'codex-message-imported', content: [{ type: 'text', text: '[Codex 终端记录 · completed]\n$ cat package.json\n目录: /old/project\n大量终端内容\n退出码: 0' }],
} } };

test('imported tool records use an exclusive Chat node while native and ordinary replies keep their renderers', () => {
  const match = recordDefinition.match['assistant/message'](message);
  assert.equal(match.exclusive, true);
  assert.equal(importedRecord({ ...message, data: { message: { ...message.data.message, id: 'native-assistant-id' } } }), undefined);
  assert.equal(importedRecord({ ...message, data: { message: { ...message.data.message, content: [{ type: 'text', text: '普通 Codex 回复' }] } } }), undefined);
  const node = recordDefinition.buildViewNode({ key: 'stable', id: '7', start: { event: message, location: { kind: 'unresolved' } },
    state: recordDefinition.start({}, { event: message }), matches: [] });
  assert.equal(node.kind, 'codex-import-record'); assert.equal(node.anchorSeq, 7); assert.equal(node.data.command, 'cat package.json');
});

test('terminal output is absent from the collapsed DOM and available in an expanded scrollable record', () => {
  const data = importedRecord(message);
  const render = expanded => renderToStaticMarkup(React.createElement(ImportedRecordCard, { node: { data }, useDisclosure: () => ({ expanded, toggle() {} }) }));
  const folded = render(false); assert.match(folded, /展开记录/); assert.match(folded, /cat package.json/); assert.doesNotMatch(folded, /大量终端内容|<pre/);
  const expanded = render(true); assert.match(expanded, /收起记录/); assert.match(expanded, /大量终端内容/); assert.match(expanded, /<pre/);
});

test('title search reaches all 1379 copies before pagination and keeps same-name project paths separate', () => {
  const items = Array.from({ length: 1379 }, (_, index) => ({ id: String(index), title: index === 1378 ? '很早的中文对话' : `会话 ${index}`,
    projectKey: index % 2 ? '/a/project' : '/b/project', projectTitle: 'project', projectPath: index % 2 ? '/a/project' : '/b/project', archived: index === 1378 }));
  assert.equal(filterCatalog(items, { query: '很早的中文' })[0].id, '1378');
  assert.equal(filterCatalog(items, { query: '很早的中文', archive: 'active' }).length, 0);
  assert.equal(filterCatalog(items, { query: '很早的中文', archive: 'archived' }).length, 1);
  assert.equal(catalogProjects(items).length, 2);
  assert.equal(filterCatalog(items, { query: '很早的中文', project: '/a/project' }).length, 0);
  assert.equal(filterCatalog(items, { query: '很早的中文', project: '/b/project' }).length, 1);
});

test('project browser searches beyond the first page and opens the chosen original copy', async t => {
  const { JSDOM } = await import('jsdom');
  const { createRoot } = await import('react-dom/client');
  const { Simulate } = await import('react-dom/test-utils');
  const { ImportBrowser } = await import('../src/presentation.js');
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const prior = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await React.act(async () => root.unmount()); dom.window.close();
    globalThis.window = prior.window; globalThis.document = prior.document; globalThis.IS_REACT_ACT_ENVIRONMENT = prior.act;
  });
  const items = Array.from({ length: 1379 }, (_, i) => ({ id: String(i), title: i === 1378 ? '末页很早的对话' : `普通会话 ${i}`,
    projectKey: i % 2 ? '/a/same' : '/b/same', projectTitle: 'same', projectPath: i % 2 ? '/a/same' : '/b/same',
    originalCwd: '/original', threadId: `thread-${i}`, updatedAt: 10, archived: false }));
  let opened, refreshes = 0;
  await React.act(async () => root.render(React.createElement(ImportBrowser, {
    loadCatalog: async () => ({ loading: false, items, errors: [] }),
    refreshSessions: async () => { refreshes++; }, openSession: id => { opened = id; },
  })));
  assert.equal(refreshes, 1); assert.equal(document.querySelectorAll('.codex-catalog-row').length, 100);
  const input = document.querySelector('input[type="search"]');
  await React.act(async () => Simulate.change(input, { target: { value: '末页很早' } }));
  assert.equal(document.querySelectorAll('.codex-catalog-row').length, 1);
  await React.act(async () => document.querySelector('.codex-catalog-row').click());
  assert.equal(opened, '1378');
  const buttons = [...document.querySelectorAll('.codex-projects button')];
  await React.act(async () => buttons.find(button => button.title === '/a/same').click());
  assert.equal(document.querySelectorAll('.codex-catalog-row').length, 0);
  await React.act(async () => buttons.find(button => button.title === '/b/same').click());
  assert.equal(document.querySelectorAll('.codex-catalog-row').length, 1);
});

test('tool record expands and collapses with React while treating original output as plain text', async t => {
  const { JSDOM } = await import('jsdom'); const { createRoot } = await import('react-dom/client');
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const prior = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await React.act(async () => root.unmount()); dom.window.close();
    globalThis.window = prior.window; globalThis.document = prior.document; globalThis.IS_REACT_ACT_ENVIRONMENT = prior.act;
  });
  const data = { ...importedRecord(message), text: '<script>untrusted historical output</script>' };
  function useDisclosure() { const [expanded, set] = React.useState(false); return { expanded, toggle: () => set(value => !value) }; }
  await React.act(async () => root.render(React.createElement(ImportedRecordCard, { node: { data }, useDisclosure })));
  assert.equal(document.querySelector('pre'), null);
  await React.act(async () => document.querySelector('button').click());
  assert.equal(document.querySelector('pre').textContent, data.text); assert.equal(document.querySelector('script'), null);
  await React.act(async () => document.querySelector('button').click()); assert.equal(document.querySelector('pre'), null);
});

test('image records keep native previews visible while paths and generation prompts stay folded', () => {
  const path = '/Users/user/very-long/project/generated/owl.png';
  const text = '[Codex 生成图片 · completed]\nCreate a NEW long illustration prompt <script>untrusted</script>\n' + path;
  const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'owl.png', width: 2, height: 1, bytes: 80, mediaType: 'image/png' };
  const event = { ...message, data: { message: { ...message.data.message, content: [{ type: 'text', text }, { type: 'image', attachment: ref }] } } };
  const before = JSON.stringify(event); const data = importedRecord(event); assert.equal(data.displayName, 'owl.png');
  let gallery;
  const view = expanded => renderToStaticMarkup(React.createElement(ImportedRecordCard, { node: { data }, useDisclosure: () => ({ expanded, toggle() {} }),
    loadImage: () => {}, renderFactorySlot: (name, props) => { gallery = { name, props }; return React.createElement('img', { alt: props.images[0].attachment.name }); } }));
  const folded = view(false); assert.match(folded, /owl.png/); assert.match(folded, /展开详情/); assert.match(folded, /<img/);
  assert.doesNotMatch(folded, /Create a NEW|very-long|<pre/); assert.equal(gallery.name, 'conversation.images.content');
  assert.deepEqual(gallery.props.images, [{ attachment: ref }]);
  const expanded = view(true); assert.match(expanded, /Create a NEW/); assert.match(expanded, /very-long/); assert.match(expanded, /收起详情/);
  assert.doesNotMatch(expanded, /<script>/); assert.equal(JSON.stringify(event), before);
  assert.equal(importedRecord({ ...event, data: { message: { ...event.data.message, id: 'native-assistant' } } }), undefined);
});
