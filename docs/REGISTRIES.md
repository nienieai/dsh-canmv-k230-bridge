# 上架社区市场

DSH 生态没有单一官方市场，社区是「GitHub 仓库 + PR 提交 registry 条目」模式。
各市场 registry 字段名略有差异，以目标仓库 README 为准（下面是通用元数据块）。

## 通用元数据块（提交时按目标仓库格式调整）

```json
{
  "name": "dsh-canmv-k230-bridge",
  "description": "DSH 动态插件：桥接 CanMV K230 开发板（悬浮面板 + 串口运行脚本与预览）",
  "repo": "https://github.com/nienieai/dsh-canmv-k230-bridge",
  "npm": "dsh-canmv-k230-bridge",
  "tags": ["canmv", "k230", "serial", "camera", "preview"],
  "install": "动态插件：cordis_define 粘贴 lib/host.js + lib/client.js",
  "platforms": ["windows"],
  "license": "MIT"
}
```

## 各市场提交入口

| 市场 | 仓库 | 提交方式 |
|---|---|---|
| WhaleHub | vvlife/whalehub-dsh | 按仓库 README 的 registry 格式提 PR |
| dsh-market | dsh-market/dsh-market | 按仓库 README 提 PR（DSH 内可视化市场） |
| dshfind | hikariming/dshfind | 提 PR / issue |
| awesome-deepseek-harness | 0xsline/awesome-deepseek-harness | 提 PR 加一条精选条目 |

## 说明

本项目为**动态插件**形态：通过 `cordis_define` 提交 `lib/host.js` + `lib/client.js` 使用，
**不支持**静态 npm bundle 安装（静态环境缺少动态 harness 桥，模型工具与面板 RPC 依赖它）。
