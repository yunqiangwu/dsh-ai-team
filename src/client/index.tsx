// dsh-ai-team — client (browser) half of the plugin.
//
// The client renders a floating "AI Team" collaboration panel into the
// `shell.overlay` slot (a root-scoped list slot every plugin can contribute to).
// It is registered through ctx.slots; Cordis removes it automatically on unload,
// so there is no manual teardown.

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { TeamPanel } from './TeamPanel.js';

export const inject = ['slots'] as const;

// Teach TypeScript that the `shell.overlay` slot exists on the slots service.
// The DSH app shell (ui-layout) owns this root-scoped list slot and renders it
// as a floating overlay; plugins contribute additively by registering into it.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' };
  }
}

export function apply(ctx: ClientContext): void {
  // Wait until the ui-shell has declared the overlay slot, then register.
  ctx.slots.inject('shell.overlay', () => {
    const dispose = ctx.slots.register(
      { name: 'shell.overlay', id: 'ai-team-panel' },
      TeamPanel,
    );
    return () => dispose();
  });
}
