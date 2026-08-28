# 贡献指南 (Contributing)

感谢你考虑为 **dsh-ai-team** 做贡献！本插件遵循 DSH「一切皆插件」的理念，
欢迎 Issue、功能建议与 Pull Request。

## 环境要求

- Node.js **≥ 22.19**
- pnpm（本项目使用 pnpm workspace；`pnpm-workspace.yaml` 已声明 `esbuild` 构建脚本许可）

## 本地开发

```bash
git clone https://github.com/yunqiangwu/dsh-ai-team.git
cd dsh-ai-team
pnpm install
pnpm build
pnpm dsh web --patch ./cordis.patch.yml   # 启动 Web UI 调试
```

常用脚本：

| 命令 | 说明 |
|---|---|
| `pnpm build` | 编译 Host + Client 并打包为 `lib/` |
| `pnpm typecheck` | 两端 TypeScript 类型检查（不产出） |
| `pnpm test` | 运行集成测试（多 Agent 协作全流程） |
| `pnpm exec tsx tests/smoke-cordis.ts` | 用真实 cordis `Context` 加载构建产物冒烟测试 |

## 代码约定

1. **TypeScript ESM（NodeNext）**：相对导入必须带 `.js` 后缀，例如 `import { TeamService } from './service.js'`。
2. **Host / Client 分离**：Host 端逻辑放在 `src/`，Web UI 放在 `src/client/`；两端各自 `tsconfig`。
3. **解耦**：核心 `TeamService` 不依赖 Cordis `ctx`，便于独立单测。
4. **资源清理**：通过 `ctx` 注册的资源随插件生命周期自动释放；外部资源（如监听、子进程）用 `ctx.effect()` 手动清理。
5. **配置校验**：新增配置项请在 `src/index.ts` 的 `Config`（schemastery）中声明默认值与约束。
6. **不修改核心**：所有能力扩展都通过本插件（或其它插件）实现，不改动 DSH 核心文件。

## 提交规范

- 分支：`feat/xxx`、`fix/xxx`、`docs/xxx`、`chore/xxx`。
- 提交信息建议遵循 [Conventional Commits](https://www.conventionalcommits.org/)（如 `feat: add parallel review`，`fix: resolve merge conflict on approve`）。
- 保持 PR 聚焦单一改动；如需大改动，请先开 Issue 讨论。

## 测试

提交 PR 前请确保：

```bash
pnpm typecheck
pnpm test
pnpm exec tsx tests/smoke-cordis.ts
```

新增功能请附带测试（集成测试或冒烟测试）。

## 开源协议

本项目以 [MIT](./LICENSE) 许可证发布。提交代码即表示你同意以相同许可证授权你的贡献。
