# dsh-canmv-k230-bridge

> **开发中（WIP）**：功能尚未稳定，接口可能变更，代码可能存在缺陷或未充分测试的路径。请勿直接用于生产环境，使用前请自行审查并在目标硬件上验证。

> **AI 生成声明**：`lib/host.js` 与 `lib/client.js` 主要由 AI 编程助手辅助生成与调试，可能包含逻辑错误或未经充分安全审计，尤其涉及硬件控制、串口通信与文件系统操作。发现问题欢迎提交 Issue 或 Pull Request。

CanMV K230 开发板桥接插件（DeepSeek Harness / DSH 动态 Cordis 插件）：悬浮面板 + 11 个模型工具，基于官方 USBDBG 协议（参考 `kendryte/canmv-vscode-extension` 实现）。

当前版本：**0.1.0**（内部：host v12.18 + client v12.23）

## 特性

- 悬浮面板（`shell.overlay`）：可拖拽、可收起；连接/断开、信息、复位、清屏
- 脚本载入：资源管理器选择或拖放 `.py` 到面板，运行后自动开启预览
- 实时预览：FB 帧缓冲 JPEG；「面板状态」与「开发板调试」分流显示
- 设置页「CanMV」：可开关悬浮窗
- 11 个模型工具：端口、执行、上传、文件系统、复位、信息、运行文件、取帧、预览、会话、停止
- 不限时会话：后台进程运行，无 10 分钟钳制；内置帧冻结哨兵（60s 无帧自动重武装并标记）

## 文件

| 文件 | 说明 |
|------|------|
| `lib/host.js` | Host 半侧源码（`code.host`）：模型工具 + 面板 RPC + USBDBG 活动会话 |
| `lib/client.js` | Client 半侧源码（`code.client`）：悬浮面板 + 设置页 |
| `LICENSE` | 项目许可（MIT） |
| `THIRD_PARTY_NOTICES` | 第三方声明（USBDBG 协议参考自 canmv-vscode-extension，BSD-3-Clause） |
| `CHANGELOG.md` | 版本记录 |
| `package.json` | 包元数据（name/version/license） |
| `.gitignore` | 忽略运行产物 |
| `docs/REGISTRIES.md` | 社区市场上架说明 |
| `tools/syntax-check.mjs` | 语法检查脚本 |
| `CONTRIBUTING.md` | 贡献指南 |

## 使用（作为 DSH 动态插件）

用 `cordis_define`（kind `new`，idPrefix `canmv`）提交：

- `code.host` = `lib/host.js` 全文
- `code.client` = `lib/client.js` 全文（两半必须同时提供，漏任一半会成为无功能包）

然后 `cordis_run` 激活；Client 半侧首次激活需页面审批。

依赖的 Host 组合能力：`shell`（PowerShell 后端，Windows）、`sandboxPolicy`、`fs`。

## 模型工具（11 个）

- `canmv_ports`：枚举串口（注册表 + USB VID/PID），标注 CanMV K230 板（VID 1209:ABD1）
- `canmv_exec`：执行任意 Python 代码（≤8KB，粘贴模式 + base64 单行包裹）
- `canmv_upload`：上传文件到板载文件系统（≤4MB，分块写入）
- `canmv_fs`：板载文件系统：ls / cat / rm / mkdir
- `canmv_reset`：软复位并捕获启动输出
- `canmv_info`：板信息：MicroPython 版本、os.uname、内存
- `canmv_runfile`：运行本地 `.py` 脚本（USBDBG 活动会话交付）
- `canmv_frame`：取最新预览帧（JPEG）
- `canmv_preview`：开 / 关预览抓帧
- `canmv_session`：会话状态 + 输出日志尾部
- `canmv_stop`：停止当前脚本会话

## 架构

```
┌─ Host（Node.js）─────────────────────────────┐
│  11 个模型工具（harness.registerTool）         │
│  面板 RPC（harness.handle panel.* ）           │
│  USBDBG 活动会话（shell.start 后台进程）        │
└──────────────┬───────────────────────────────┘
               │  runtime/ 目录文件              │
┌──────────────▼───────────────┐
│ Client（浏览器）               │
│  shell.overlay 悬浮面板        │
│  settings.section 设置页       │
└──────────────────────────────┘
```

- 会话通过 `shell.start()` 后台进程运行（无超时），经 `runtime/` 目录的状态、日志、抓帧文件与 Host/Client 通信。
- 中文交付使用纯字节级 UTF-8→base64（宿主沙箱 `btoa` 为 UTF-8 感知实现，直接 `btoa` 会双重编码产生乱码）。

## USBDBG 协议要点

- 板载 USB 口 VID `1209:ABD1`（如 COM5）@ 12000000；DTR 边沿激活；Ctrl-E 粘贴模式
- 0x30 + cmd + uint32LE 帧：0x8D 同步 / 0x11 软复位 / 0x05 SCRIPT_EXEC / 0x8E/0x8F TX 输出流 / 0x87 运行状态 / 0x0D/0x81/0x82 预览抓帧

## 限制

- 仅 Windows（PowerShell + .NET SerialPort + 注册表）
- 动态插件为进程级：DSH 重启后需重新 `cordis_define` + `cordis_run`
- `canmv_exec` 单次 ≤ 8KB；大脚本走面板「运行脚本」或 `canmv_runfile`
- 沙箱需 workspace-write（FullLanguage）模式
- 硬件操作存在风险：错误命令可能对开发板 / 存储造成影响，请谨慎使用

## 许可

本项目基于 **MIT License**（见 `LICENSE`）。USBDBG 协议实现参考自 `kendryte/canmv-vscode-extension`（BSD-3-Clause，© Canaan Bright Sight Co., Ltd 2026），详见 `THIRD_PARTY_NOTICES`。

## 致谢

- [kendryte/canmv-vscode-extension](https://github.com/kendryte/canmv-vscode-extension)：USBDBG 协议参考
- DeepSeek Harness (DSH)：插件运行平台
