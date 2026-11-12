import { basename } from 'node:path';
import { ExportArchive } from './archive.js';
import { digest } from './source.js';
import { normalizeChatGPTText } from './chatgpt-format.js';

const text = value => ({ type: 'text', text: String(value ?? '') });
const ms = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value * 1000)) : 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parent links are authoritative: recent exports need not contain children arrays. */
export function conversationPath(conversation) {
  const mapping = conversation.mapping;
  if (!object(mapping)) throw new Error('ChatGPT 会话缺少 mapping');
  const keys = Object.keys(mapping);
  if (!keys.length) return [];
  let current = conversation.current_node;
  if (!current || !Object.hasOwn(mapping, current)) throw new Error('ChatGPT current_node 无效，无法确定当前分支');
  const path = [], seen = new Set();
  while (current != null) {
    if (seen.has(current)) throw new Error('ChatGPT 会话 parent 关系存在循环');
    if (!Object.hasOwn(mapping, current) || !object(mapping[current])) throw new Error('ChatGPT 会话缺少父节点');
    seen.add(current); path.push(current); current = mapping[current].parent;
  }
  return path.reverse();
}

function assetName(asset) {
  const pointer = asset.pointer;
  return asset.name || (typeof pointer === 'string' ? pointer.split('/').at(-1) : '') || '未命名附件';
}

export function projectChatGPT(record) {
  const message = record.item.message;
  if (!record.active || !message || message.metadata?.is_visually_hidden_from_conversation) return undefined;
  const role = message.author?.role;
  const content = [], assets = [], seen = new Set();
  const addAsset = asset => {
    if (typeof asset.pointer !== 'string' || !asset.pointer) return;
    const key = asset.pointer.split('/').at(-1).replace(/\.dat$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    assets.push({ ...asset, index: content.length });
    content.push(text(`[ChatGPT ${asset.kind === 'image' ? '图片' : '附件'}：${assetName(asset)}]`));
  };
  const part = value => {
    if (typeof value === 'string') { content.push(text(role === 'assistant' ? normalizeChatGPTText(value, message.metadata).text : value)); return; }
    if (!object(value)) { content.push(text(`[ChatGPT 未知内容]\n${JSON.stringify(value)}`)); return; }
    switch (value.content_type) {
      case 'image_asset_pointer': addAsset({ pointer: value.asset_pointer, kind: 'image', mimeType: value.mime_type }); break;
      case 'audio_asset_pointer': addAsset({ pointer: value.asset_pointer, kind: 'file', mimeType: 'audio/' + (value.format || 'wav') }); break;
      case 'audio_transcription': content.push(text(value.text)); break;
      case 'real_time_user_audio_video_asset_pointer':
        if (typeof value.audio_asset_pointer === 'string') addAsset({ pointer: value.audio_asset_pointer, kind: 'file', mimeType: 'audio/wav' });
        else if (value.audio_asset_pointer) part({ ...value.audio_asset_pointer, content_type: 'audio_asset_pointer' });
        for (const frame of value.frames_asset_pointers || []) {
          if (typeof frame === 'string') addAsset({ pointer: frame, kind: 'image' });
          else if (object(frame)) part({ ...frame, content_type: 'image_asset_pointer' });
        }
        if (value.video_container_asset_pointer) addAsset({ pointer: value.video_container_asset_pointer, kind: 'file' });
        break;
      default: content.push(text(`[ChatGPT ${value.content_type || '未知内容'}]\n${JSON.stringify(value)}`));
    }
  };
  const body = message.content || {};
  if (['text', 'multimodal_text'].includes(body.content_type)) {
    for (const value of body.parts || []) part(value);
  } else if (body.content_type === 'reasoning_recap') {
    content.push({ type: 'reasoning', text: typeof body.content === 'string' ? body.content : JSON.stringify(body.content ?? '') });
  } else if (body.content_type === 'thoughts') {
    const thoughts = body.thoughts;
    content.push({ type: 'reasoning', text: Array.isArray(thoughts) ? thoughts.map(t => typeof t === 'string' ? t : [t.summary, t.content].filter(Boolean).join('\n') || JSON.stringify(t)).join('\n\n') : JSON.stringify(thoughts ?? '') });
  } else content.push(text(`[ChatGPT ${body.content_type || '未知内容'}]\n${JSON.stringify(body)}`));
  for (const attachment of message.metadata?.attachments || []) {
    if (!object(attachment)) continue;
    addAsset({ pointer: attachment.id || attachment.file_id, kind: attachment.mime_type?.startsWith('image/') ? 'image' : 'auto',
      name: attachment.name, mimeType: attachment.mime_type });
  }
  if (role !== 'user' && role !== 'assistant') {
    // Historical tool/system data is an ordinary assistant record, never live instructions.
    content.unshift(text(`[ChatGPT 历史 ${role || '未知角色'} 记录]`));
    for (const asset of assets) asset.index++;
  }
  return { role: role === 'user' ? 'user' : 'assistant', content, ...(assets.length ? { assets } : {}),
    ...(message.metadata?.model_slug ? { model: message.metadata.model_slug } : {}) };
}

export function chatGPTRecords(snapshot) {
  return snapshot.records.filter(r => r.active).sort((a, b) => a.order - b.order)
    .map(record => ({ record, projected: projectChatGPT(record) }));
}

/** Read sharded ChatGPT exports without materializing the full corpus or extracting attachments. */
export class ChatGPTSource {
  constructor(path, sourceId) { this.requestedPath = path; this.requestedSourceId = sourceId; this.warnings = []; }
  async open(signal) {
    this.archive = await new ExportArchive(this.requestedPath).open(signal);
    try {
      this.path = this.archive.path;
      const names = this.archive.names();
      let files;
      if (this.archive.has('export_manifest.json')) {
        const manifest = await this.archive.json('export_manifest.json', signal);
        files = manifest.logical_files?.['conversations.json']?.files;
        if (files !== undefined && (!Array.isArray(files) || !files.length || files.some(n => typeof n !== 'string') || new Set(files).size !== files.length)) throw new Error('ChatGPT 对话分片清单无效');
      }
      files ??= this.archive.has('conversations.json') ? ['conversations.json'] : names.filter(n => /^conversations-\d+\.json$/.test(n)).sort();
      if (!files.length) throw new Error('导出包中未找到 ChatGPT conversations.json 或对话分片');
      const user = this.archive.has('user.json') ? await this.archive.json('user.json', signal) : {};
      const account = this.requestedSourceId ? ['manual', this.requestedSourceId] : user.id ? ['account', user.id] : null;
      if (!account) throw new Error('导出包缺少稳定账户 ID，请提供 sourceId；同一账户的后续导出请使用相同 sourceId');
      this.home = `chatgpt:${digest(account)}`;
      this.threads = new Map();
      this.summary = { shards: files.length, conversations: 0, messages: 0, selectedMessages: 0, offPathMessages: 0, branchedConversations: 0, contentTypes: {}, unsupported: [] };
      for (const file of files) {
        const conversations = await this.archive.json(file, signal);
        if (!Array.isArray(conversations)) throw new Error('ChatGPT 对话文件必须是 JSON 数组');
        for (const [index, conversation] of conversations.entries()) {
          signal?.throwIfAborted();
          const id = conversation.id || conversation.conversation_id;
          if (typeof id !== 'string' || !id) throw new Error('ChatGPT 会话缺少 ID');
          if (this.threads.has(id)) throw new Error('ChatGPT 导出包含重复会话 ID');
          let path = [], error;
          try { path = conversationPath(conversation); } catch (e) { error = e.message; }
          const selected = new Set(path), children = new Map();
          for (const [key, node] of Object.entries(conversation.mapping || {})) {
            if (!node) continue;
            if (node.parent) children.set(node.parent, (children.get(node.parent) || 0) + 1);
            if (!node.message) continue;
            this.summary.messages++;
            this.summary[selected.has(key) ? 'selectedMessages' : 'offPathMessages']++;
            const type = node.message.content?.content_type || 'unknown';
            this.summary.contentTypes[type] = (this.summary.contentTypes[type] || 0) + 1;
          }
          if ([...children.values()].some(n => n > 1)) this.summary.branchedConversations++;
          this.threads.set(id, { id, title: conversation.title || '', created_at_ms: ms(conversation.create_time),
            archived: conversation.is_archived ? 1 : 0, is_pinned: !!(conversation.is_starred || conversation.pinned_time),
            model_provider: 'openai', model: conversation.default_model_slug || 'chatgpt-import', sourceKind: 'chatgpt',
            file, index, ...(error ? { error } : {}) });
        }
      }
      this.summary.conversations = this.threads.size;
      this.assetNames = this.archive.has('conversation_asset_file_names.json') ? await this.archive.json('conversation_asset_file_names.json', signal) : {};
      this.library = this.archive.has('library_files.json') ? await this.archive.json('library_files.json', signal) : [];
      const pages = names.filter(n => /^pages\/[^/]+\/metadata\.json$/.test(n)).length;
      if (pages) this.summary.unsupported.push(`Pages 文档 ${pages} 个`);
      if (names.some(n => n.startsWith('sites/'))) this.summary.unsupported.push('Sites 数据');
      if (this.archive.has('group_chats.json')) {
        const groups = await this.archive.json('group_chats.json', signal);
        const count = Array.isArray(groups) ? groups.length : groups.chats?.length || 0;
        if (count) this.summary.unsupported.push(`群聊 ${count} 个`);
      }
      if (this.library.length) this.summary.unsupported.push('未关联到当前对话路径的文件库记录');
      if (this.summary.unsupported.length) this.warnings.push(`本次仅导入个人对话；未单独导入：${this.summary.unsupported.join('、')}。`);
      if (this.summary.offPathMessages) this.warnings.push(`${this.summary.offPathMessages} 条其他分支消息保留为原始记录，默认不加入续聊上下文。`);
      return this;
    } catch (error) { this.close(); throw error; }
  }

  list(options = {}) {
    return [...this.threads.values()].filter(t => (options.includeArchived !== false || !t.archived)
      && (!options.threadIds?.length || options.threadIds.includes(t.id)));
  }

  async read(thread, signal) {
    if (thread.error) throw new Error(thread.error);
    if (this.cacheFile !== thread.file) {
      this.cache = await this.archive.json(thread.file, signal); this.cacheFile = thread.file;
    }
    const conversation = this.cache[thread.index];
    const path = conversationPath(conversation), order = new Map(path.map((key, i) => [key, i]));
    const { mapping, ...metadata } = conversation;
    const { file, index, error, ...publicThread } = thread;
    const records = Object.keys(mapping).sort().map(key => ({ key, time: ms(mapping[key]?.message?.create_time) || thread.created_at_ms,
      active: order.has(key), order: order.get(key) ?? -1, item: mapping[key] }));
    const snapshot = { thread: { ...publicThread, chatgpt: metadata }, createdAt: thread.created_at_ms, mode: 'chatgpt', turns: [], records, supplemental: [],
      source: { kind: 'chatgpt', sourceId: this.home, archivePath: this.path }, archive: this.archive, resolveAsset: asset => this.resolveAsset(asset), skipLocationNotice: true };
    snapshot.fingerprint = digest({ metadata: snapshot.thread, records, presentationFormat: 1 });
    return snapshot;
  }

  resolveAsset(asset) {
    const pointer = asset.pointer;
    if (typeof pointer !== 'string' || /^https?:/i.test(pointer)) throw new Error('远程附件未自动下载');
    const id = pointer.split('/').at(-1);
    if (!id || id.includes('\\') || id === '..' || id === '.') throw new Error('附件标识无效');
    const candidates = [id, `${id}.dat`];
    const entry = candidates.find(n => this.archive.has(n));
    const library = Array.isArray(this.library) ? this.library.find(f => f.file_id === id || f.id === id) : undefined;
    if (!entry) throw Object.assign(new Error('导出包中未找到附件文件'), { code: 'ENOENT' });
    return { entry, name: basename(asset.name || this.assetNames[entry] || library?.file_name || entry),
      mimeType: asset.mimeType || library?.mime_type };
  }
  close() { this.archive?.close(); this.cache = undefined; }
}
