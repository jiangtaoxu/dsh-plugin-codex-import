import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeChatGPTText } from '../src/chatgpt-format.js';
import { projectChatGPT } from '../src/chatgpt-source.js';
import { readableChatGPTNode, ReadableChatGPTAssistant, installReadableChatGPT } from '../src/chatgpt-presentation.js';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';

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

test('real Harness SlotCore elects adapter, preserves normalized injection and avoids duplicate child declarations', () => {
  const core = new SlotCore(), factories = [];
  core.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } }, () => null);
  const nativeAssistant = props => {
    assert.equal(props.t('title'), 'native-chat:title');
    assert.equal(props.usePresentation(), 'native-policy');
    assert.equal(props.resolveFilePath, sessionId);
    return React.createElement('section', null, props.node.data.blocks[0].text,
      props.renderSlot('conversation.chat.reasoning.body', { text: 'reasoning' }),
      props.renderSlot('conversation.chat.message.images', { images: ['original-image'] }));
  };
  core.register({ name: 'conversation.chat.node', key: 'assistant-step', locale: 'native-chat',
    children: { 'conversation.chat.message.images': { kind: 'single', scope: 'session' }, 'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' } },
    inject: id => ({ resolveFilePath: id, hooks: { presentation: { getSnapshot: () => 'native-policy', subscribe() {} } } }) }, nativeAssistant);
  const native = core.entries('conversation.chat.node')[0];
  assert.equal(native.options.inject, undefined); assert.equal(native.options.locale, undefined);
  let dispose;
  installReadableChatGPT({ slots: { entries: key => core.entries(key), inject: (_slot, fn) => { dispose = fn(); }, register: (...args) => core.register(...args) } });
  const selected = core.entriesOfSlot('conversation.chat.node')[0], injected = selected.inject(sessionId);
  assert.equal(selected.component, ReadableChatGPTAssistant); assert.equal(selected.locale, native.locale);
  assert.equal(selected.children, undefined); assert.equal(core.spec('conversation.chat.message.images').scope, 'session');
  assert.equal(injected.nativeAssistant, nativeAssistant);
  const { hooks, ...props } = injected;
  const html = renderToStaticMarkup(React.createElement(selected.component, { ...props, sessionId,
    node: { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: rich }], finalNode: { messageId: 'codex-message-original' } } },
    usePresentation: hooks.presentation.getSnapshot, t: key => `${selected.locale}:${key}`,
    renderFactorySlot: (name, owner) => { factories.push({ name, owner }); return null; } }));
  assert.doesNotMatch(html, /&lt;box|&lt;Cite/);
  assert.deepEqual(factories, [{ name: 'conversation.chat.reasoning.content', owner: { text: 'reasoning' } }, { name: 'conversation.images.content', owner: { images: ['original-image'] } }]);
  assert.equal(core.entriesOfSlot('conversation.chat.node')[0], selected);
  dispose(); assert.equal(core.entriesOfSlot('conversation.chat.node')[0], native);
});

test('single and array citations keep separate IDs, repeats and explicit links', () => {
  const input = 'One.<Cite ref="turn3search1"/> Two.<Cite refs={\n ["turn4search12", "turn4search19"]\n}/>'
    + ' Repeat.<Cite refs={["turn4search19"]}/><MemoryCite ref={"memory0"}/>';
  const result = normalizeChatGPTText(input, { content_references: [{ ref_id: 'turn4search12', url: 'https://example.com/twelve' }] });
  assert.equal(result.unresolvedCitations, 3);
  assert.match(result.text, /Two\.\[来源\]\(<https:\/\/example.com\/twelve>\)〔来源 2〕/);
  assert.match(result.text, /Repeat\.〔来源 2〕〔来源 3〕/); assert.doesNotMatch(result.text, /<Cite|<MemoryCite|turn4search/);
  assert.equal(normalizeChatGPTText(result.text).text, result.text);
  const unsafe = normalizeChatGPTText('<Cite data={(() => { throw "ref=\\"fake\\"" })()} refs={["actual"]}/>');
  assert.equal(unsafe.unresolvedCitations, 1); assert.doesNotMatch(unsafe.text, /fake|actual|data=|<Cite/);
});

test('standalone styled text, badges, links, charts and suggestions need no containing box', () => {
  const result = normalizeChatGPTText('<text color="secondary" size="xs">Complete text.</text>\n<badge color="success">Status</badge>\n'
    + '<Link url="https://example.com/" title="Source"/>\n'
    + '<Chart content={{"meta":{"title":"History"},"series":[{"dataKey":"count","label":"Count"}],"data":[{"month":"Jan","count":42}]}}/>\n'
    + '<SuggestAutomation label="Check later"/>');
  assert.doesNotMatch(result.text, /<\/?(?:text|badge|Link|Chart|SuggestAutomation)\b|content=|dataKey/);
  assert.match(result.text, /Complete text\./); assert.match(result.text, /Status/); assert.match(result.text, /\[Source\]\(<https:\/\/example.com\/>\)/);
  assert.match(result.text, /原图表：History/); assert.match(result.text, /\| month \| Count \|/); assert.match(result.text, /\| Jan \| 42 \|/);
  assert.match(result.text, /Check later；未创建自动化任务/);
  assert.equal(normalizeChatGPTText(result.text).text, result.text);
});

test('HTML line breaks become readable separators while code literals remain exact', () => {
  const input = 'First<br/>Second\n\n| Heading | Value |\n|---|---|\n| a<br>b | 1 |\n\n`<br/>`\n```html\n<br>\n```';
  const result = normalizeChatGPTText(input);
  assert.match(result.text, /^First\nSecond/); assert.match(result.text, /\| a · b \| 1 \|/);
  assert.match(result.text, /`<br\/>`/); assert.ok(result.text.endsWith('```html\n<br>\n```'));
});

test('standalone captions and unavailable entity expressions have readable static fallbacks', () => {
  const result = normalizeChatGPTText('<caption>Original caption</caption>\n<Entity ref="turn0business0" value={turn0business0.name}/>');
  assert.match(result.text, /Original caption/); assert.match(result.text, /导出缺少可解析的名称/);
  assert.doesNotMatch(result.text, /<caption|<Entity|turn0business0/);
  assert.equal(normalizeChatGPTText(result.text).text, result.text);
});
