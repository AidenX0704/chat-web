# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

请不要在公开 issue 里披露安全问题，改用 GitHub 的
[私密漏洞报告](https://github.com/AidenX0704/chat-web/security/advisories/new)，或直接联系仓库维护者。
我们会在确认后尽快修复，并在修复版本发布后致谢（如果你愿意署名）。

Please do not open a public issue for security problems. Use GitHub's private
[security advisory](https://github.com/AidenX0704/chat-web/security/advisories/new) instead.

## 部署方需要注意 / For self-hosters

- 本仓库**不含任何 API Key 或口令**：`server/.env` 已被 `.gitignore` 与 `.dockerignore` 排除，请自行填写并妥善保管；
- 后端只有唯一账号（`AUTH_USERNAME` / `AUTH_PASSWORD`），部署到公网请使用长随机口令，并把 `COOKIE_SECURE` 设为 `true`；
- 请通过 HTTPS + 反向代理暴露服务，不要把后端 8787 端口直接映射到公网；
- 纯静态部署模式下会话与 API Key 全部保存在浏览器本地，请自行评估共享设备的风险。

## 支持范围 / Supported versions

项目处于早期阶段，只对最新 `main` 分支提供安全修复。
