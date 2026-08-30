---
id: UX-1
title: P0 用户体验正确性修复：过时文案 / 中文硬编码 / 术语 tooltip
status: pending
owner: leader-1
depends_on: []
touches:
  - src/client/dict.ts
  - src/formmodel.ts
  - src/client/AutopilotPanel.tsx
---

# P0 用户体验正确性修复：过时文案 / 中文硬编码 / 术语 tooltip

产品评审（2026-08-31）给出的 UX 优化建议，本次只落地 **P0 三项正确性修复**（改动小、风险低、立即见效）；P1/P2/P3 建议见文末「后续建议（未排期）」。

## 任务清单（todolist）

- [x] UX-1.1 设置卡片文案过时：`config.intro` 仍写「下次带 patch 启动时生效」，实际保存即热生效
- [x] UX-1.2 升级分诊表单硬编码中文：`escalationFields()` 的 label/placeholder 是中文常量，英文面板显示中文
- [ ] UX-1.3 术语黑话加 tooltip：`gates.badge`「门 3/4」、返工轮次、统计卡等用户不可读

## 验收标准

### 场景一：config.intro 文案与行为一致

- **Given** 设置 → 插件 → 插件配置 的 autopilot 卡片
- **Then** 卡片说明文案反映「保存即热生效」，不再误导用户需要重启
- **And** zh / en 字典同步更新

### 场景二：升级分诊表单走 i18n

- **Then** `escalationFields` 接受可选翻译函数，面板侧传 `t` 渲染本地化文案
- **And** 服务端（`service.ts`）不传时回退中文，与整体中文的工单页一致
- **And** zh / en 字典同步更新

### 场景三：术语 tooltip

- **Then** 质量门徽标、返工轮次、统计卡带解释性 tooltip
- **And** zh / en 字典同步更新

## 超出范围

- P1 待办中心 / 升级快捷动作 / async 提交后引导等中高价值建议（另行排期，见下）

## 后续建议（未排期）

- **P1**：统一「待办中心」（聚合问卷/升级/卡住/needs-human 到单一行动入口）；升级也进注意力信号；升级分诊快捷动作；async 提交后引导
- **P2**：看板搜索/过滤与卡片详情可达；活动时间线；设置卡片扩展（完整配置/连通测试/即时校验）；首次使用引导；完成态总结
- **P3**：async「继续」摩擦（宿主写入口）；多团队切换 UI；可访问性（hover-only tooltip、纯色状态点、键盘导航）
