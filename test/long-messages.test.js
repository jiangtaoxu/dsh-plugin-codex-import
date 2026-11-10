import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { longMessagePreview, LongUserText, installLongMessages } from '../src/long-messages.js';

test('long text and many-line messages fold at bounded previews without splitting Unicode', () => {
  assert.equal(longMessagePreview('x'.repeat(1200)), undefined);
  assert.equal(longMessagePreview('短消息'), undefined);
  assert.equal(longMessagePreview('x'.repeat(1201)).preview.length, 900);
  assert.equal(longMessagePreview(Array.from({ length: 19 }, () => '一行').join('\n')).preview.split('\n').length, 12);
  assert.equal(longMessagePreview('x'.repeat(899) + '😀' + 'y'.repeat(400)).preview, 'x'.repeat(899));
});

test('short user text delegates to the native renderer with its owner and raw text intact', () => {
  let owner;
  const Native = props => { owner = props; return React.createElement('span', null, props.node.data.display); };
  const node = { id: 'text', start: 0, end: 3, data: { text: '原文' } };
  assert.match(renderToStaticMarkup(React.createElement(LongUserText, { node, raw: '原文', interactive: true, nativeText: Native })), /原文/);
  assert.equal(owner.interactive, true); assert.equal(owner.raw, '原文'); assert.equal(node.data.display, undefined);
});

test('long text expands, zooms and collapses without injecting HTML or changing source text', async t => {
  const { JSDOM } = await import('jsdom'); const { createRoot } = await import('react-dom/client');
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const prior = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  t.after(async () => { await React.act(async () => root.unmount()); dom.window.close(); globalThis.window = prior.window; globalThis.document = prior.document; globalThis.IS_REACT_ACT_ENVIRONMENT = prior.act; });
  const text = '开头 '.repeat(500) + '<script>保留的末尾原文</script>';
  const node = { id: 'text', data: { text } }; const before = JSON.stringify(node);
  await React.act(async () => root.render(React.createElement(LongUserText, { node, raw: text })));
  assert.equal(document.querySelector('.codex-long-message-body').textContent.length, 901);
  assert.ok(!document.body.textContent.includes('末尾原文'));
  await React.act(async () => document.querySelector('button').click());
  assert.equal(document.querySelector('.expanded').textContent, text); assert.equal(document.querySelector('script'), null);
  await React.act(async () => document.querySelector('[aria-label="放大消息字号"]').click());
  assert.equal(document.querySelector('.expanded').style.fontSize, '16px');
  await React.act(async () => document.querySelector('[aria-label="缩小消息字号"]').click());
  assert.equal(document.querySelector('.expanded').style.fontSize, '14px');
  await React.act(async () => document.querySelector('button').click());
  assert.equal(document.querySelector('.expanded'), null); assert.equal(JSON.stringify(node), before);
});

test('plain-text override selects the native text renderer and leaves other business nodes alone', () => {
  const Native = () => null; const Reply = () => null; let entry;
  const ctx = { slots: { inject: (name, callback) => callback(), register: (options, component) => { entry = { options, component }; },
    entries: () => [entry, { options: { key: 'question-reply' }, component: Reply }, { options: { key: 'text', priority: 100 }, component: Native }] } };
  installLongMessages(ctx); assert.equal(entry.options.key, 'text'); assert.equal(entry.options.inject().nativeText, Native);
});
