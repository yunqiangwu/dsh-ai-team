---
id: PIL-1
title: README 补「故障排查」章节
status: done
touches:
  - README.md
---

# README 补「故障排查」章节

## 验收标准

### 场景一：章节存在且可查

- **Given** 仓库 main 分支的 README.md
- **When** 在文末查看
- **Then** 新增 `## 故障排查` 章节，含 ≥ 5 条「症状 → 原因 → 处置」三段式条目
- **And** 条目覆盖至少：bootstrap 命令不存在（`bootstrap-failed`）、非 github 平台 `requireCiGreen` 不生效、设置卡片改动需带 `--patch` 重启、任务卡死与墙钟预算升级的含义、工单端点仅回环访问

### 场景二：改动面受控

- **When** 对比任务分支与 main 的 diff
- **Then** 仅 README.md 一个文件被修改，且改动全部为追加，不重写或删除既有章节
- **And** 未触及 `.github/`、`AGENTS.md`、`LICENSE`（本任务范围外，不是禁区——2026-08-29 起默认 `forbiddenPaths` 只剩 `LICENSE`）
