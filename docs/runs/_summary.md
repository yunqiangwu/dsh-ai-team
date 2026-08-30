# 试点汇总：首次真实环境无人值守（S1–S4）

> 状态：**已完成**（2026-08-31，四场景全部跑完）。
> 所属：方案见 [../pilot-scenarios.md](../pilot-scenarios.md)；运行 Runbook 以 [../../PILOT.md](../../PILOT.md) 为准。
> 团队：`demo`（`team_e0d02c7e`），rootDir `.dsh-ai-team-l1`，generic 自建远端 `/tmp/dsh-ai-team-l1.git`。

## 结论

四试点场景全部通过，完成率 100%、无同因反复升级、耗时远低于 `maxTaskHours`。对照 PILOT.md §8 收尾判定，**可以进下一级**（L0–L2 已覆盖；下一级建议：部署 + 健康检查/回滚、更大负载并行，或换一个带真实 CI 的自建远端）。

## 场景一览

| 场景 | 验证点 | 放权级 | 契约 | 结果 |
| --- | --- | --- | --- | --- |
| [S1](s1-gfm-template.md) GFM 表格闭环 | 已答问卷→拆契约→派发→门→审→合并，无升级 | L0/L1 | MD2HTML-1..4 | ✅ 4/4 done，0 升级 |
| [S2](s2-parallel-lock.md) 并行派发 + 域锁 | 一次拆 2 独立契约、并行派发、域锁零冲突 | L2 | S2-1/S2-2 | ✅ 2/2 done，0 升级 |
| [S3](s3-human-decision.md) 人工决策 + 问卷复核 | `ask_human` 问卷→人拍板→`[decision]` 回写→继续开发 | L1（人在环） | S3-1/S3-2 | ✅ 2/2 done，0 意外升级，1 次预期人工拍板 |
| [S4](s4-escalation.md) 升级分诊 + 放行 | 受控升级→原因可读→面板作答→`escalation_resolve`→自动恢复 | L1（可中断） | S4-1 | ✅ 1/1 done，1 次人为触发 manual 升级 |

## 累计指标（completion.md）

- 派发 9 / 完成 9 / 审查轮次 0（全部首轮 approve）
- 质量门 9 次，失败 0；`gateFailures 0`
- 升级直方图：`manual: 1`（S4 人为触发、明确标注、处置清晰，非真实阻塞）
- 部署 0 / 回滚 0；learnings 空（人为探测未污染学习记录）
- 任务耗时：4m–11m（对照 `maxTaskHours=2h`，墙体预算充分）

## 升级直方图与处置

| 原因 | 次数 | 触发 | 处置 |
| --- | --- | --- | --- |
| `manual` | 1 | S4 人为触发（探测） | 面板作答 + `escalation_resolve` 放行；任务退回 pending → 自动重派 → done |

无真实阻塞升级、无 `task-stuck`/`budget-exceeded`/`review-rounds-exceeded` 等异常。

## 运行期发现（不影响闭环，按可用性/文档项记录）

1. **面板刷新滞后（P2，已修根因）**：运行中 `state.json` 中间态在面板滞拍；已在主循环加「有实际变更即推一帧投影」。
2. **运行期 data 损坏自愈（本次实测）**：重启时 `state.json` 被截断 0 字节，服务改名留存 `state.json.corrupt-<ts>`，凭磁盘真相源（`.tasks/`、git、`completion.md`）重建运行态。
3. **`notification.autoResume` 关闭时的放行语义（P2，S4 实测）**：面板/工单作答只回写 `notification.submitted`，需再补一次 `escalation_resolve` 才真正放行；PILOT §6 本就将两条等价列出，后续试点可评估对 pilot 配置开启 `autoResume` 以少一步。
4. **`[decision]` 回写落点不精确（P2，S3 实测）**：`sectionMatched: false` 时注记落在文档尾部；内容可读、不阻塞，属文档回写规范项。
5. **`contract_create` 跨域上限护栏（正向观察）**：过宽的 `touches` 会被 `crossDomainThreshold` 拦下，leader 能自查收敛——护栏有效。

## 收尾判定（对照 PILOT §8）

- 完成率 100% ≥ 80%、无同因反复升级（learnings 为空）→ ✅ **进下一级**
- 校准预算：单任务 4–11min ≪ `maxTaskHours=2h`，可在下一级下调 `maxTaskHours` 收紧成本护栏
- 「待升格」清单：上述 P2 发现值得长期化的（如 autoResume 语义、`[decision]` 落点、跨域上限）建议以 docs-only 变更沉淀进 PILOT/README 后再 `learning_promote` 标记