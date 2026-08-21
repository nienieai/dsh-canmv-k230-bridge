# dsh-canmv-k230-bridge

CanMV K230 开发板桥接插件（DeepSeek Harness / DSH 动态 Cordis 插件）：
**悬浮面板** + **11 个模型工具**，基于官方 USBDBG 协议（对照 `kendryte/canmv-vscode-extension` 实现）。

当前版本：**v12.27**（host v12.18 + client v12.23）

## 文件

| 文件 | 说明 |
|------|------|
| `host.js` | Host 半侧源码（`code.host`）——11 个模型工具 + 面板 RPC + USBDBG 活动会话 |
| `client.js` | Client 半侧源码（`code.client`）——悬浮面板 + 设置页「CanMV」开关悬浮窗 |
| `README.md` | 本文档 |

## 模型工具（11 个）

- `canmv_ports` — 枚举串口（注册表 + USB VID/PID），标注 CanMV K230 板
- `canmv_exec` — 执行任意 Python 代码（≤8KB，粘贴模式 + base64 单行包裹）
- `canmv_upload` — 上传文件到板载文件系统（≤4MB，分块写入）
- `canmv_fs` — 板载文件系统：ls / cat / rm / mkdir
- `canmv_reset` — 软复位并捕获启动输出
- `canmv_info` — 板信息：MicroPython 版本、os.uname、内存
- `canmv_runfile` — 运行本地 .py 脚本（USBDBG 活动会话交付）
- `canmv_frame` — 取最新预览帧（JPEG）
- `canmv_preview` — 开/关预览抓帧
- `canmv_session` — 会话状态 + 输出日志尾部
- `canmv_stop` — 停止当前脚本会话

## 悬浮面板

- `shell.overlay` 可拖拽、可收起悬浮窗：连接/断开 · 信息 · 复位 · 清屏
- 📂 打开脚本（资源管理器）或拖放 .py 载入 → ▶ 运行脚本（自动开启预览）
- 👁 实时预览（FB 帧缓冲 JPEG）；「面板状态」与「开发板调试」分流显示
- 设置页「CanMV」可开关悬浮窗
- 会话为后台进程不限时；帧冻结哨兵（60s 无帧自动 FB 重武装并标记）

## 使用（作为 DSH 动态插件）

用 `cordis_define`（kind `new`，idPrefix `canmv`）提交：

- `code.host` = `host.js` 全文
- `code.client` = `client.js` 全文（两半必须同时提供）

然后 `cordis_run` 激活；Client 半侧首次激活需页面审批。

依赖的 Host 组合能力：`shell`（PowerShell 后端，Windows）、`sandboxPolicy`、`fs`。

## 关键实现说明

- 板载 USB 口 VID `1209:ABD1`（如 COM5）@ 12000000；DTR 边沿激活；Ctrl-E 粘贴模式
- 中文交付必须用纯字节级 UTF-8→base64（宿主沙箱 `btoa` 是 UTF-8 感知实现，双重编码会产生乱码）
- 会话必须用 `shell.start()` 后台进程（`shell.run()` 的 timeoutMs 会被部署默认 10 分钟钳制）
- 大脚本经 base64 文件传递 + 字节数自校验（不匹配拒绝交付）
- USBDBG 协议：0x30 + cmd + uint32LE 帧；0x8D 同步 / 0x11 软复位 / 0x05 SCRIPT_EXEC /
  0x8E/0x8F TX 输出流 / 0x87 运行状态 / 0x0D/0x81/0x82 预览抓帧

## 限制

- 仅 Windows（PowerShell + .NET SerialPort + 注册表）
- 动态插件为进程级：DSH 重启后需重新 `cordis_define` + `cordis_run`
- `canmv_exec` 单次 ≤ 8KB；大脚本走面板「运行脚本」或 `canmv_runfile`
- 沙箱需 workspace-write（FullLanguage）模式
