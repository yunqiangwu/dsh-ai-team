/**
 * Minimal client-side contracts of the DSH Web runtime, as consumed by this
 * plugin. These mirror @deepseek-ai/dsh-client-runtime (cordis Context in the
 * browser), dsh-client-locale and dsh-client-ui-slots; declared locally so the
 * package typechecks without pulling the whole client stack into dependents.
 * Only the surface dsh-ai-team actually uses is spelled out.
 */

/** Translator bound to the plugin's locale namespace; {var} interpolation. */
export type Translator = (key: string, params?: Record<string, string | number>) => string

/** Standard props every slot component receives from the host UI. */
export interface SlotProps {
  sessionId?: string
  /** Reactive read of a host-side session projection (undefined until first push). */
  useProjection: <T = unknown>(key: string) => T | undefined
  t: Translator
}

export interface SlotRegistration {
  /** Slot name (position), e.g. conversation.input.dock. */
  name: string
  /** Unique id within the slot. */
  id: string
  /** Sort order inside list slots. */
  order?: number
  /** Locale namespace the component's `t` is bound to. */
  locale?: string
}

export interface ClientContext {
  /** Register a disposer tied to the client plugin's lifecycle. */
  effect(disposer: () => void, label?: string): void
  locale: {
    /** Register zh/en dictionaries under a namespace; returns a disposer. */
    register(
      namespace: string,
      dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ): () => void
  }
  slots: {
    /** Run `callback` in the scope of one declared slot. */
    inject(slotName: string, callback: () => unknown): void
    /** Register a React component into a slot; returns a disposer. */
    register(meta: SlotRegistration, component: unknown): () => void
  }
}
