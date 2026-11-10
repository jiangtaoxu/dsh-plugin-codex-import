import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findQuestionReply, questionReplyRule, QuestionReplyView } from '../src/question-replies.js';

const rows = [
  { questionItemId: '["request_user_input_async","call_example_questions",0]', question: '演示主题使用浅色还是深色？', answer: '使用浅色主题' },
  { questionItemId: '["request_user_input_async","call_example_questions",1]', question: '演示列表显示多少条？', answer: '显示五条 允许重复示例' },
  { questionItemId: '["request_user_input_async","call_example_questions",2]', question: '导出文件名是否已有约定？', answer: '暂未确定 在文档中列示例名称' },
];
const wrap = data => '<send_user_message_question_reply>\n' + JSON.stringify(data) + '\n</send_user_message_question_reply>';
const sample = wrap(rows);
const render = raw => renderToStaticMarkup(React.createElement(QuestionReplyView, { node: questionReplyRule.match(raw, 0), raw }));

test('the exact three-question reply displays readable questions and answers without internal IDs', () => {
  const parsed = findQuestionReply(sample); assert.equal(parsed.start, 0); assert.equal(parsed.end, sample.length);
  assert.deepEqual(parsed.rows, rows.map(row => ({ question: row.question, answers: [row.answer] })));
  const html = render(sample);
  for (const row of rows) { assert.ok(html.includes(row.question)); assert.ok(html.includes(row.answer)); }
  assert.match(html, /问题与回答 · 3 项/); assert.doesNotMatch(html, /call_example|questionItemId|send_user_message_question_reply/);
  assert.match(html, /查看原始消息/);
});

test('matching preserves prefix/suffix text and forward offsets across multiple replies', () => {
  const prefix = '前面的说明😀\n'; const middle = '\n保留中间原文\n'; const suffix = '\n后面的说明';
  const value = prefix + sample + middle + sample + suffix;
  const first = questionReplyRule.match(value, 0); const second = questionReplyRule.match(value, first.end);
  assert.equal(value.slice(0, first.start), prefix); assert.equal(value.slice(first.end, second.start), middle);
  assert.equal(value.slice(second.end), suffix); assert.equal(value.slice(first.start, first.end), sample);
  assert.equal(questionReplyRule.match(value, second.end), undefined);
});

test('JSON strings can contain tags, escaped quotes, backslashes, brackets and line breaks', () => {
  const answer = '第一行 </send_user_message_question_reply> [中括号] {大括号}\n"引号" \\ 路径 😀';
  const raw = wrap([{ question: '怎样显示？', answer }]);
  assert.deepEqual(findQuestionReply(raw).rows[0].answers, [answer]); assert.equal(findQuestionReply(raw).end, raw.length);
});

test('multi-select and empty replies preserve values without inventing choices', () => {
  const raw = wrap([{ question: '多选', answer: ['方案 A', '方案 B'] }, { question: '数值', answer: 0 },
    { question: '布尔值', answer: false }, { question: '尚未填', answer: null }, { question: '空选项', answer: [] }]);
  const parsed = findQuestionReply(raw); assert.deepEqual(parsed.rows.map(row => row.answers), [['方案 A', '方案 B'], ['0'], ['false'], [], []]);
  const html = render(raw); assert.match(html, /方案 A/); assert.match(html, /方案 B/); assert.match(html, /未填写/);
});

test('invalid and unsupported payloads stay native text and never hide partially valid rows', () => {
  for (const data of [null, {}, [], [{ question: '缺失回答' }], [{ question: '', answer: 'A' }],
    [{ question: 'Q', answer: { text: 'unsupported' } }], [{ question: 'Q', answer: ['A', null] }], [rows[0], { wrong: 'field' }]]) {
    assert.equal(questionReplyRule.match(wrap(data), 0), undefined);
  }
  assert.equal(findQuestionReply('<send_user_message_question_reply>[broken]</send_user_message_question_reply>'), undefined);
  assert.equal(findQuestionReply(sample.replace('</send_user_message_question_reply>', '')), undefined);
  const invalid = '<send_user_message_question_reply>[invalid]</send_user_message_question_reply>\n';
  assert.equal(findQuestionReply(invalid + sample).start, invalid.length);
});

test('code examples and inline-code literals remain unchanged while real replies still match', () => {
  assert.equal(findQuestionReply('```swift\n' + sample + '\n```'), undefined);
  assert.equal(findQuestionReply('~~~json\n' + sample + '\n~~~'), undefined);
  assert.equal(findQuestionReply('`' + sample.replaceAll('\n', '') + '`'), undefined);
  const prefixed = '```swift\n' + sample + '\n```\n'; assert.equal(findQuestionReply(prefixed + sample).start, prefixed.length);
  const innerFence = '<send_user_message_question_reply>\n```json\n' + JSON.stringify(rows) + '\n```\n</send_user_message_question_reply>';
  assert.equal(findQuestionReply(innerFence).rows.length, 3);
});

test('oversized or excessive arrays fail safely without consuming other messages', () => {
  assert.equal(findQuestionReply(wrap(Array.from({ length: 201 }, () => rows[0]))), undefined);
  assert.equal(findQuestionReply(wrap([{ question: '超长', answer: 'x'.repeat(1024 * 1024) }])), undefined);
});

test('untrusted HTML is displayed as text and raw source is available only after expanding', async t => {
  const { JSDOM } = await import('jsdom'); const { createRoot } = await import('react-dom/client');
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const prior = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  t.after(async () => { await React.act(async () => root.unmount()); dom.window.close();
    globalThis.window = prior.window; globalThis.document = prior.document; globalThis.IS_REACT_ACT_ENVIRONMENT = prior.act; });
  const raw = wrap([{ question: '<img src=x onerror=alert(1)>', answer: '<script>untrusted</script>' }]);
  await React.act(async () => root.render(React.createElement(QuestionReplyView, { node: questionReplyRule.match(raw, 0), raw })));
  assert.equal(document.querySelector('img,script'), null); assert.equal(document.querySelector('[aria-label="原始问答消息"]'), null);
  assert.ok(document.body.textContent.includes('<script>untrusted</script>'));
  await React.act(async () => document.querySelector('button').click());
  assert.equal(document.querySelector('[aria-label="原始问答消息"]').textContent, raw);
  await React.act(async () => document.querySelector('button').click());
  assert.equal(document.querySelector('[aria-label="原始问答消息"]'), null);
});
