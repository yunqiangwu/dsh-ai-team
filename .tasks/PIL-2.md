---
id: PIL-2
title: 生成 CHANGELOG.md
status: pending
touches:
  - CHANGELOG.md
---

# 生成 CHANGELOG.md

## 验收标准

### 场景一：变更日志存在且成体系

- **Given** 仓库的 git 提交历史（`git log --oneline`，Conventional Commits）
- **When** 查看仓库根目录
- **Then** 新建 `CHANGELOG.md`，采用 Keep a Changelog 风格，按版本分节（当前 1.0.x 系列从 git 历史归纳）
- **And** 每版本条目 ≤ 10 条，feat / fix 优先，正文中文

### 场景二：改动面受控

- **When** 对比任务分支与 main 的 diff
- **Then** 仅新增根目录 `CHANGELOG.md` 一个文件，无其它改动
- **And** 未触及 `.github/`、`AGENTS.md`、`LICENSE`（human-only 区）
