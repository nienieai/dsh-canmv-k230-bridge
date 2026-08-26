# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 首版

内部版本：Host v12.18 + Client v12.23

### 新增
- 客户端 v12.23：设置页「CanMV」可开关悬浮窗（模块级可见性 + 订阅广播，设置页与悬浮窗实时同步）

### 修复 / 加固
- 客户端 v12.22：帧冻结可见性（status.frameStall 提示）
- 主机 v12.18：采纳会话的退出感知兜底（proc=null 会话节流 pidAlive 轮询）
- 主机 v12.17：帧冻结哨兵（60s 无新帧判冻结 + 自动 FB 重武装）
- 主机 v12.16：会话改用后台进程，根治「10 分钟被杀」
- 主机 v12.15：会话循环异常加固（try/catch + loopErrors）
- 主机 v12.11：纯字节级 UTF-8→base64，根治中文乱码

### 历史版本
- v12.14：新增 canmv_frame / canmv_preview / canmv_session / canmv_stop 4 个模型工具
- v12.13：存活判定阈值 6 次、写超时 15s
- v12.9：交付字节数自校验 + 僵尸会话清理 + canmv_runfile
- v12.7：面板载荷改 ASCII-safe base64
- v12.6：会话失步恢复 + 预览刷新
- v12：USBDBG 活动会话（运行脚本 + 预览）
- v11：悬浮面板
- v10：纯工具版
