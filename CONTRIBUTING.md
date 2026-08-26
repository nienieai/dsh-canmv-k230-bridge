# Contributing

感谢你的贡献！本仓库是 `dsh-canmv-k230-bridge`（DSH CanMV K230 桥接插件）。

## 工作流

1. Fork 本仓库并创建分支：`git checkout -b feat/your-feature`
2. 修改后运行本地检查（见下）
3. 提交并推送：`git push origin feat/your-feature`
4. 打开 Pull Request，附上变更说明

## 开发约定

- **两半必须同时更新**：改 Host 或 Client 任一半，`code.host` 与 `code.client` 都要同步提交，
  漏任一半会导致插件变成无功能包。
- **中文传输**：交付到板子的脚本必须用纯字节级 UTF-8→base64（`utf8B64` 实现），
  不要用宿主沙箱的 `btoa` —— 它是 UTF-8 感知实现，会双重编码产生乱码。
- **会话不限时**：长任务必须用 `shell.start()` 后台进程，
  不要用 `shell.run()` —— 其 `timeoutMs` 会被部署默认 10 分钟钳制。

## 本地检查（纯 JS，无构建）

```powershell
node --check host.js
node --check client.js
```

## 许可

本项目基于 MIT License（见 `LICENSE`）。提交即表示你同意在
`LICENSE` 和 `THIRD_PARTY_NOTICES` 的条款下发布你的贡献。
