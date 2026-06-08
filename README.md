# 8号 智能体 SKILL 库

8号（董事长助理）专属技能、脚本、档案。

## 目录结构

```
8hao-skills/
├── README.md                  # 本文件
├── SKILL.md                   # 飞书重连技能（人类 + AI 都能读）
├── connect-feishu.ps1         # 飞书一键重连脚本
├── start-bridge.ps1           # 桥接器启动（经 .env.8hao 注入凭证）
├── stop-bridge.ps1            # 桥接器停止
├── verify-after-restart.js    # 重启后一键自检 Node 脚本
├── verify-mcp-after-restart.md# 重启后自检手册
├── pm2-cheatsheet.md          # pm2 启停命令备忘
└── bridge/                    # 飞书 WS 长连接桥接器（pm2 守护）
    ├── package.json
    ├── bridge.js
    ├── ecosystem.config.js
    ├── launch-detached.cmd
    └── feishu-inbox.jsonl, feishu-outbox.jsonl, bridge.log, ...
```

## 现有技能

| 技能 | 文件 | 用途 |
|------|------|------|
| 飞书重连 | `SKILL.md` + `connect-feishu.ps1` | 8号 飞书凭证同步 + 连通验证 |
| 桥接器管理 | `start-bridge.ps1` + `stop-bridge.ps1` + `pm2-cheatsheet.md` | 8号 飞书 WS 长连接桥接器（pm2 守护，常驻 PID 由 pm2 分配）|
| 重启自检 | `verify-after-restart.js` + `verify-mcp-after-restart.md` | Claude Code 重启后一键 5 步自检 |

## 引用

- 8号 部署档案：`D:\BACK\FreeCode\8hao-docs\8HAO_FEISHU_SETUP.md`
- 8号 .env 凭证：`D:\BACK\FreeCode\.env.8hao`
- Claude Code 配置：`C:\Users\39701\NiuClaude\.claude.json`

## 约定

- 所有技能文件不放在 C 盘根目录（节省 C 盘空间）
- 凭证以环境变量 / .env 文件方式管理，不进对话明文
- 每个技能包含 SKILL.md（文档） + 可执行脚本
- 桥接器在 pm2 守护下常驻，**正常情况下不需要重启**；如需停用 `pm2 stop 8hao-feishu-bridge`
