import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeChatGPTText } from '../src/chatgpt-format.js';
import { projectChatGPT } from '../src/chatgpt-source.js';
import { readableChatGPTNode, ReadableChatGPTAssistant, installReadableChatGPT } from '../src/chatgpt-presentation.js';

const sessionId = `chatgpt-${'a'.repeat(24)}-${'b'.repeat(24)}`;
const rich = `Before\n\n<box gap={3}>
  <row align=start gap={3}>
    <box size="36px"><text weight="medium">1</text></box>
    <box flex="1" gap={1}>
      **First step**

      Keep the complete paragraph.<Cite ref="turn1view0"/>
    </box>
  </row>
</box>
{@body const [choice,setChoice]=DIL.useState("unknown")}
<box padding={3}>
  <form onSubmit={()=>GenUI.issueNewTurn("a > b: "+choice)}>
    <text weight="medium">Choose an option</text>
    <radio-group onChange={setChoice}>
      <radio value="a">Option A</radio>
      <radio value="b">Option B</radio>
    </radio-group>
    <button disabled={choice==="unknown"}>Submit</button>
  </form>
</box>\n\nAfter`;

test('ChatGPT layout becomes readable Markdown without indentation-created code blocks or executable UI', () => {
  const result = normalizeChatGPTText(rich);
  assert.equal(result.changed, true); assert.equal(result.layout, true);
  assert.doesNotMatch(result.text, /<\/?(?:box|row|text|radio|form|button|Cite)\b|DIL\.|GenUI\.|onSubmit|setChoice|\{@body/);
  assert.match(result.text, /^1\. \*\*First step\*\*/m);
  assert.match(result.text, /Keep the complete paragraph/); assert.match(result.text, /- Option A/); assert.match(result.text, /- Option B/);
  assert.match(result.text, /原按钮：Submit/); assert.match(result.text, /原交互表单已转为静态内容/);
  assert.ok(!result.text.split('\n').some(line => /^ {4}\S/.test(line)));
  assert.equal(normalizeChatGPTText(result.text).text, result.text);
});

test('code fences, inline literals, ordinary Markdown and user-authored markup remain intact', () => {
  const examples = [
    '```jsx\n<box gap={3}>\n  <Cite ref="turn0search0"/>\n</box>\n```',
    'Use `<box>` and `<Cite ref="x"/>` as literal examples.',
    '~~~html\n<row>example</row>\n~~~',
    '# A heading\n\n- List\n\n| x | y |\n|---|---|\n| 1 | 2 |',
    '```jsx\n<box>unfinished code fence',
    '<script>alert("never executed")</script>',
  ];
  for (const example of examples) assert.equal(normalizeChatGPTText(example).text, example);
  const code = '```js\n    const value = "<box>";\n```';
  assert.ok(normalizeChatGPTText(`<box>\n  Paragraph\n\n${code}\n</box>`).text.includes(code));
  const record = { active: true, item: { message: { author: { role: 'user' }, content: { content_type: 'text', parts: [rich] } } } };
  assert.equal(projectChatGPT(record).content[0].text, rich);
});

test('citations resolve only from explicit exported IDs, never by search-result order', () => {
  const metadata = { content_references: [{ type: 'webpage', matched_text: 'citeturn0search0', url: 'https://example.com/source' },
    { ref_id: 'turn0search1', url: 'javascript:alert(1)' }], search_result_groups: [{ entries: [{ url: 'https://wrong.example/' }] }] };
  const result = normalizeChatGPTText('Fact.<Cite ref="turn0search0"/> Other.<Cite ref="turn0search1"/> Again.<Cite ref="turn0search1"/>', metadata);
  assert.match(result.text, /\[来源\]\(<https:\/\/example\.com\/source>\)/);
  assert.equal(result.unresolvedCitations, 1);
  assert.doesNotMatch(result.text, /javascript:|wrong\.example|turn0search/);
  assert.equal((result.text.match(/〔来源 1〕/g) || []).length, 2);
});

test('private-use citation and entity tokens and explicit Entity labels retain readable content', () => {
  const result = normalizeChatGPTText('entity["organization","Example Org","label"] and <Entity category="place" value="Example Place" location="Street 1"/>. citeturn0search0turn0search1');
  assert.match(result.text, /Example Org and Example Place（Street 1）/);
  assert.equal(result.unresolvedCitations, 2); assert.doesNotMatch(result.text, /<Entity||/);
});

test('rich tables and links preserve their cells and labels; media and controls remain static', () => {
  const input = `<box><title>Heading</title><icon name="check"/>
  <table>
    <table-row><table-cell>Name</table-cell><table-cell>Value</table-cell></table-row>
    <table-row><table-cell>First</table-cell><table-cell>123</table-cell></table-row>
  </table>
  <Link href="https://example.com/page">Read more</Link>
  <AsyncImage src="https://example.com/image.png" alt="Original image"/>
  <Chart title="Original chart" data={[]}/><slider value={state}/>
</box>`;
  const result = normalizeChatGPTText(input);
  assert.match(result.text, /### Heading/);
  assert.match(result.text, /\| Name \| Value \|\s*\n\| --- \| --- \|\n\| First \| 123 \|/);
  assert.match(result.text, /\[Read more\]\(<https:\/\/example\.com\/page>\)/);
  assert.match(result.text, /\[Original image\]\(<https:\/\/example\.com\/image.png>\)/);
  assert.doesNotMatch(result.text, /<table|<Link|<AsyncImage|<Chart|<slider|!\[Original image\]/);
  assert.match(result.text, /原图表：Original chart/);
});

test('exported widget payloads become static descriptions without creating tasks or loading remote images', () => {
  const input = 'genui{"suggest_automation":{"title":"Reminder","prompt":"Review notes","schedule":"ignored"}}\nimage_group{"query":["Example images"]}\nmessage_reaction👍';
  const result = normalizeChatGPTText(input);
  assert.match(result.text, /原自动化建议：Reminder/); assert.match(result.text, /Review notes/); assert.match(result.text, /未创建自动化任务/);
  assert.match(result.text, /原图片组：Example images/); assert.match(result.text, /👍/); assert.doesNotMatch(result.text, /|suggest_automation|schedule/);
  assert.equal(normalizeChatGPTText(result.text).text, result.text);
});

test('fresh import normalization preserves every original node and citation metadata', () => {
  const record = { active: true, item: { id: 'raw-node', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [rich] },
    metadata: { model_slug: 'original-model', content_references: [{ ref_id: 'turn1view0', url: 'https://example.com/source' }] } } } };
  const original = structuredClone(record), projected = projectChatGPT(record);
  assert.deepEqual(record, original); assert.equal(projected.model, 'original-model');
  assert.doesNotMatch(projected.content[0].text, /<box|<Cite/); assert.match(projected.content[0].text, /https:\/\/example\.com\/source/);
});

test('existing imported messages are fixed in the native view without touching logs, images, reasoning or continuations', () => {
  const image = { kind: 'image', attachment: { attachmentId: 'image' } }, reasoning = { kind: 'reasoning', text: 'Exported summary' };
  const node = { kind: 'assistant-step', data: { status: 'settled', blocks: [{ kind: 'text', text: rich }, image, reasoning], finalNode: { messageId: 'codex-message-original', seq: 39 } } };
  const original = structuredClone(node), readable = readableChatGPTNode(node, sessionId);
  assert.deepEqual(node, original); assert.notEqual(readable, node);
  assert.equal(readable.data.blocks[1], image); assert.equal(readable.data.blocks[2], reasoning);
  assert.equal(readable.data.finalNode.messageId, node.data.finalNode.messageId);
  assert.equal(readableChatGPTNode(node, 'native-session'), node);
  assert.equal(readableChatGPTNode({ ...node, data: { ...node.data, finalNode: { messageId: 'native-harness-continuation' } } }, sessionId).data.blocks[0].text, rich);
  let received;
  const nativeAssistant = props => { received = props; return React.createElement('p', null, props.node.data.blocks[0].text); };
  const html = renderToStaticMarkup(React.createElement(ReadableChatGPTAssistant, { nativeAssistant, node, sessionId, loadImage: 'native-image-loader' }));
  assert.doesNotMatch(html, /&lt;box|GenUI/); assert.equal(received.loadImage, 'native-image-loader'); assert.equal(received.sessionId, sessionId);
});

test('native assistant slot keeps locale, injection hooks and child slots during decoration', () => {
  let callback, registration;
  const nativeAssistant = () => null;
  const native = { options: { name: 'conversation.chat.node', key: 'assistant-step', priority: 0, locale: 'native-chat', children: { 'conversation.chat.message.images': { kind: 'single', scope: 'session' } },
    inject: id => ({ resolveFilePath: id, hooks: { presentation: 'native' } }) }, component: nativeAssistant };
  installReadableChatGPT({ slots: { entries: () => [native], inject: (_slot, fn) => { callback = fn; }, register: (options, component) => { registration = { options, component }; } } });
  callback(); const injected = registration.options.inject('current-session');
  assert.equal(registration.component, ReadableChatGPTAssistant); assert.equal(registration.options.locale, native.options.locale);
  assert.equal(registration.options.children, native.options.children); assert.equal(injected.hooks.presentation, 'native');
  assert.equal(injected.resolveFilePath, 'current-session'); assert.equal(injected.nativeAssistant, nativeAssistant);
});
