import { en, zh } from './dict.js';
import { ensurePanelStyles } from './styles.js';
import { AutopilotPanel } from './AutopilotPanel.js';
import { AutopilotSettingsCard } from './settings-card.js';
import type { ClientContext } from './contract.js';

/** 依赖的服务：sessions（projection 席位）、slots、locale、settings scope。 */
export const inject = ['sessions', 'slots', 'locale', 'settingsScope'];

// 字典本体在 ./dict.ts；re-export 保持测试与外部消费方的导入路径不变。
export { en, zh };

/** 客户端插件主体。 */
export function apply(ctx: ClientContext): void {
  ensurePanelStyles();
  ctx.effect(() => ctx.locale.register('autopilot', { zh, en }), 'autopilot: dictionaries');
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'autopilot',
        order: 40,
        locale: 'autopilot',
      },
      AutopilotPanel,
    ),
  );
  // 设置卡片：把 `autopilot` 这个 Host namespace 与浏览器端卡片配对。
  // 以 namespace 作为 key，这样插件配置页才能把两份账对上。
  const autopilotScope = ctx.settingsScope.bind<Record<string, unknown>>({ namespace: 'autopilot' });
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        id: 'autopilot',
        key: 'autopilot',
        locale: 'autopilot',
        inject: () => ({ t: ctx.locale.bind('autopilot'), scope: autopilotScope }),
      },
      AutopilotSettingsCard,
    ),
  );
}
