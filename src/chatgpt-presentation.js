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

export function ReadableChatGPTAssistant({ nativeAssistant, node, sessionId, renderFactorySlot, ...props }) {
  const readable = React.useMemo(() => readableChatGPTNode(node, sessionId), [node, sessionId]);
  // The original entry owns its child-slot declarations; redeclaring them on a
  // shadow entry is rejected by SlotCore. Delegate to the same native factories
  // that the built-in reasoning/image child components use instead.
  const renderSlot = React.useCallback((name, owner) => {
    if (name === 'conversation.chat.reasoning.body') return renderFactorySlot('conversation.chat.reasoning.content', owner);
    if (name === 'conversation.chat.message.images') return renderFactorySlot('conversation.images.content', owner);
    throw new Error(`Unsupported native assistant child slot: ${name}`);
  }, [renderFactorySlot]);
  return React.createElement(nativeAssistant, { ...props, node: readable, sessionId, renderSlot, renderFactorySlot });
}

/** Keep the native assistant, injected policy hooks, locale and media factories. */
export function installReadableChatGPT(ctx) {
  if (!ctx.slots.entries) return;
  ctx.slots.inject('conversation.chat.node', () => {
    const native = ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === 'assistant-step' && entry.component !== ReadableChatGPTAssistant);
    if (!native) return;
    // entries() returns normalized entries: rendering contracts live beside options,
    // which contains only election fields. Losing these makes the native renderer
    // crash and silently abdicate this entry in favor of the undecorated assistant.
    return ctx.slots.register({ ...native.options, name: 'conversation.chat.node', key: 'assistant-step', priority: (native.options.priority ?? 0) - 10,
      locale: native.locale, store: native.store,
      inject: (...args) => ({ ...native.inject?.(...args), nativeAssistant: native.component }),
    }, ReadableChatGPTAssistant);
  });
}
