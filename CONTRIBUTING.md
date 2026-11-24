# 贡献指南 / Contributing

感谢你愿意改进 chat-web！下面是参与前需要知道的最小信息。

## 环境 / Requirements

- Node.js >= 22.12
- pnpm（仓库使用 pnpm 的 workspace 风格目录：根目录前端 + `server/` 后端）

```sh
pnpm install
pnpm --dir server install
```

## 常用命令 / Commands

| 命令 | 用途 |
| --- | --- |
| `pnpm dev:static` | 纯静态模式开发（无需后端，数据存浏览器本地） |
| `pnpm dev` | 同时起后端（:8787）与前端（:8090），同源 `/api` 联调 |
| `pnpm type` | 前后端 TypeScript 类型检查 |
| `pnpm lint` | oxlint 检查 |
| `pnpm format` | oxfmt 格式化 |
| `pnpm test:server` | 后端接口与 SSE 测试 |
| `pnpm build:static` | 构建纯静态产物到 `dist/` |

提交前请至少跑通 `pnpm type`、`pnpm lint`；改动后端时再跑 `pnpm test:server`。

## 提交规范 / Commit style

使用 [Conventional Commits](https://www.conventionalcommits.org/) 的形式，例如
`feat(share): 支持只分享选中消息`、`fix(sider): 修复收起后图标错位`、`docs: 补充 nginx 配置说明`。
一个 PR 只做一件事，便于评审与回滚。

## 代码约定 / Conventions

- 注释与文案使用**简体中文**，界面文案同时补 `src/i18n/zh.ts` 与 `src/i18n/en.ts`；
- 组件放在 `src/components/<域>/`，每个组件一个目录，样式用 CSS Modules；
- 不要提交 `server/.env`、`server/data/`、`dist/` 等本地文件（见 `.gitignore`）；
- 新增第三方依赖前请确认许可证与本项目（MIT）兼容。

## 提 PR / Pull request

1. Fork 并基于 `main` 开分支；
2. 关联相关 issue，写清动机与验证方式（截图/录屏更好）；
3. 确认 CI（类型检查、lint、静态构建）全绿。
