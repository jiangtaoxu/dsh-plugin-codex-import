import { randomUUID } from 'node:crypto';

export const ATTACHMENT_REASONS = {
  missing: '原文件不存在', permission: '没有读取权限', 'too-large': '超过大小或像素限制',
  format: '图片格式不支持或数据损坏', remote: '远程附件未下载', path: '路径无效或不是普通文件',
  changed: '复制时原文件发生变化', service: '附件服务不可用', other: '其他读取或保存错误',
};
const pair = () => ({ references: 0, unique: 0 });
const counts = () => ({ images: pair(), files: pair() });

/** Reference counts plus global source identity sets; no transcript or attachment bytes. */
export class AttachmentAudit {
  constructor() {
    this.id = randomUUID(); this.rows = new Map();
    this.totals = { available: counts(), missing: counts(), reference: counts() }; this.reasons = new Map();
    this.uniqueSets = new Map(); this.version = 0; this.complete = false;
  }
  add(entry, thread, messageKey) {
    const type = entry.type === 'image' ? 'images' : 'files';
    const status = entry.status === 'reference' ? 'reference' : entry.reasonCode ? 'missing' : 'available';
    const reason = entry.reasonCode || '';
    const assetKey = `${type}:${entry.identity}`;
    const increment = (group, bucket) => {
      let seen = this.uniqueSets.get(group);
      if (!seen) this.uniqueSets.set(group, seen = new Set());
      bucket.references++;
      if (!seen.has(assetKey)) { seen.add(assetKey); bucket.unique++; }
    };
    increment(status, this.totals[status][type]);
    if (reason) {
      if (!this.reasons.has(reason)) this.reasons.set(reason, counts());
      increment(`reason:${reason}`, this.reasons.get(reason)[type]);
    }
    const key = JSON.stringify([assetKey, status, reason]);
    let row = this.rows.get(key);
    if (!row) {
      row = { type: entry.type, status, reasonCode: reason, reason: status === 'reference' ? '代码位置引用（不计入附件）' : ATTACHMENT_REASONS[reason] || '',
        detail: entry.detail || '', name: entry.name, source: entry.source, references: 0, locations: new Set(), conversations: new Map() };
      this.rows.set(key, row);
    }
    row.references++;
    if (entry.location) row.locations.add(entry.location);
    let conversation = row.conversations.get(thread.id);
    if (!conversation) {
      conversation = { id: thread.id, title: String(thread.name || thread.title || thread.first_user_message || thread.id).replace(/\s+/g, ' ').slice(0, 160),
        project: thread.cwd || '', references: 0, messages: new Set() };
      row.conversations.set(thread.id, conversation);
    }
    conversation.references++; conversation.messages.add(String(messageKey)); this.version++;
  }
  snapshot() {
    return { id: this.id, version: this.version, complete: this.complete, ...structuredClone(this.totals),
      reasons: [...this.reasons].map(([code, value]) => ({ code, label: ATTACHMENT_REASONS[code] || code, ...structuredClone(value) })) };
  }
  query(params = new URLSearchParams()) {
    const type = params.get('type') || ''; const status = params.get('status') || 'missing';
    const reason = params.get('reason') || ''; const search = (params.get('q') || '').trim().toLocaleLowerCase();
    const filtered = [...this.rows.values()].filter(row => (!type || row.type === type) && (!status || status === 'all' || row.status === status)
      && (!reason || row.reasonCode === reason) && (!search || [row.name, row.source, row.reason, row.detail,
        ...[...row.conversations.values()].flatMap(c => [c.title, c.id, c.project])].some(v => String(v).toLocaleLowerCase().includes(search))));
    const total = filtered.length; const size = 30; const pages = Math.max(1, Math.ceil(total / size));
    const requested = Number(params.get('page') || 1);
    const page = Math.max(1, Math.min(pages, Number.isSafeInteger(requested) ? requested : 1));
    return { audit: this.snapshot(), page, pages, total, rows: filtered.slice((page - 1) * size, page * size).map(row => ({
      ...row, locations: [...row.locations], conversations: [...row.conversations.values()].map(c => ({ ...c, messages: [...c.messages] })),
    })) };
  }
}

/** Keep only recent task audits, separate from the bounded native job output tail. */
export class AttachmentAudits {
  constructor() { this.reports = new Map(); }
  create() {
    const audit = new AttachmentAudit(); this.reports.set(audit.id, audit);
    while (this.reports.size > 3) this.reports.delete(this.reports.keys().next().value);
    return audit;
  }
}
export function installAttachmentAuditRoute(ctx, audits) {
  return ctx.connection.fetch.register({
    path: '/api/codex-import/attachments', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const params = new URL(request.url).searchParams;
      const audit = audits.reports.get(params.get('id'));
      if (!audit) return Response.json({ error: '附件明细已失效，请重新预览。仅保留最近三次任务，重启后需重新扫描。' }, { status: 404 });
      return Response.json(audit.query(params), { headers: { 'cache-control': 'no-store' } });
    },
  });
}
