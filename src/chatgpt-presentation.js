import * as React from 'react';
import { normalizeChatGPTText } from './chatgpt-format.js';

/** Existing imported histories get the same read projection without changing their logs. */
export function readableChatGPTNode(node, sessionId) {
  if (!/^chatgpt-(?:[a-f0-9]{24}-[a-f0-9]{24}|recovered-[a-f0-9]{24})$/.test(sessionId || '')
    || !node?.data?.finalNode?.messageId?.startsWith('codex-message-') || !Array.isArray(node.data.blocks)) return node;
  let changed = false;
  const blocks = node.data.blocks.map(block => {
    if (block.kind !== 'text') return block;
    const result = normalizeChatGPTText(block.text);
    if (!result.changed) return block;
    changed = true; return { ...block, text: result.text };
  });
  if (!changed) return node;
  return { ...node, data: { ...node.data, blocks, finalNode: { ...node.data.finalNode, blocks } } };
}

export function ReadableChatGPTAssistant({ nativeAssistant, node, sessionId, ...props }) {
  const readable = React.useMemo(() => readableChatGPTNode(node, sessionId), [node, sessionId]);
  return React.createElement(nativeAssistant, { ...props, node: readable, sessionId });
}

/** Preserve the native slot's injection, locale, child slots, images and reasoning hooks. */
export function installReadableChatGPT(ctx) {
  if (!ctx.slots.entries) return;
  ctx.slots.inject('conversation.chat.node', () => {
    const native = ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === 'assistant-step' && entry.component !== ReadableChatGPTAssistant);
    if (!native) return;
    return ctx.slots.register({ ...native.options, name: 'conversation.chat.node', key: 'assistant-step', priority: (native.options.priority ?? 0) - 10,
      inject: (...args) => ({ ...native.options.inject?.(...args), nativeAssistant: native.component }),
    }, ReadableChatGPTAssistant);
  });
}
