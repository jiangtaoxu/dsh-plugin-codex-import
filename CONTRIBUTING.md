# 参与贡献

感谢帮助改进 Codex Import。提交问题和代码前，请先阅读[使用手册](docs/USAGE.md)与[架构说明](docs/ARCHITECTURE.md)。

## 反馈问题

请提供 Harness、插件、Node.js、操作系统版本，以及最小复现步骤、预期与实际结果。若与来源格式有关，使用合成或脱敏的少量 SQLite/JSONL 记录；不要上传完整 `.codex`、`.dsh`、`auth.json`、聊天日志、私人附件、绝对个人路径或凭据。安全问题见 [SECURITY.md](SECURITY.md)。

## 本地开发

```sh
npm ci
npm run build
npm run check
npm test
npm pack --dry-run
```

需要 Node.js 24.9+。修改客户端时编辑 `src/`，用 `npm run build` 生成 `lib/client.js`，不要只修改产物。依赖变动时同步 `package-lock.json`。

## 变更原则

- Codex 来源只读；导入不得执行历史工具或发起模型请求。
- 保留原生消息、Harness 续聊和已保存附件；同步使用追加式事务与原生写锁。
- 预览不写入会话/附件；实际导入与删除遵循现有一次性确认流程。
- 使用 Harness 公开服务和扩展槽，避免修改宿主应用文件。
- 新数据格式或同步修复应有临时、合成数据的回归测试，不提交真实用户历史。

PR 请说明具体问题、行为变化、验证结果与兼容性影响。较大行为调整建议先开 Issue 讨论。项目默认使用 MIT 许可证。
