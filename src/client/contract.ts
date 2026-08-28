/**
 * Minimal client-side contracts of the DSH Web runtime, as consumed by this
 * plugin. These mirror @deepseek-ai/dsh-client-runtime (cordis Context in the
 * browser), dsh-client-locale and dsh-client-ui-slots; declared locally so the
 * package typechecks without pulling the whole client stack into dependents.
 * Only the surface dsh-ai-team actually uses is spelled out.
 */

/** Translator bound to the plugin's locale namespace; {var} interpolation. */
export type Translator = (key: string, params?: Record<string, string | number>) => string;

/** Standard props every slot component receives from the host UI. */
export interface SlotProps {
  sessionId?: string;
  /** Reactive read of a host-side session projection (undefined until first push). */
  useProjection: <T = unknown>(key: string) => T | undefined;
  t: Translator;
}

export interface SlotRegistration {
  /** Slot name (position), e.g. conversation.input.dock. */
  name: string;
  /** Unique id within the slot. */
  id: string;
  /** Sort order inside list slots. */
  order?: number;
  /** Locale namespace the component's `t` is bound to. */
  locale?: string;
  /** Keyed-slot key (settings.plugin.item keys on the namespace it edits). */
  key?: string;
  /** Build the props passed to the registered component. */
  inject?: () => unknown;
}

/** Client-side sync view of one settings namespace (mirror of the scope contract). */
export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable';
  value: T | undefined;
  base: unknown;
  user: unknown;
  revision: number | undefined;
  writable: boolean;
  mode: 'host' | 'memory';
}

/** Reactive owner handle over one namespace's durable section. */
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>;
  subscribe(listener: () => void): () => void;
  /** Queue one scalar field write (dot path). */
  set(field: string, value: unknown): Promise<void>;
  /** Clear a field so it re-inherits the composition layer. */
  unset(field: string): Promise<void>;
}

export interface ClientContext {
  /** Register a disposer tied to the client plugin's lifecycle. */
  effect(disposer: () => void, label?: string): void;
  locale: {
    /** Register zh/en dictionaries under a namespace; returns a disposer. */
    register(
      namespace: string,
      dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ): () => void;
    /** Bind a translator to a locale namespace; returns { key, params } => string. */
    bind(namespace: string): Translator;
  };
  slots: {
    /** Run `callback` in the scope of one declared slot. */
    inject(slotName: string, callback: () => unknown): void;
    /** Register a React component into a slot; returns a disposer. */
    register(meta: SlotRegistration, component: unknown): () => void;
  };
  /** Settings transport: bind one namespace's bounded scope on this fiber. */
  settingsScope: {
    bind<T>(spec: { namespace: string }): SettingsScope<T>;
  };
}
