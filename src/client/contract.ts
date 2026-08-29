/**
 * 本插件所依赖的 DSH Web 运行时最小客户端契约。这里镜像了
 * @deepseek-ai/dsh-client-runtime（浏览器端的 cordis Context）、
 * dsh-client-locale 与 dsh-client-ui-slots；之所以在本地声明，是为了让本包
 * 能够独立完成 typecheck，而不必把整套 client 技术栈拖进依赖方。
 * 只列出 dsh-ai-team 真正用到的那部分接口。
 */

/** 绑定到插件 locale namespace 的翻译函数；支持 {var} 插值。 */
export type Translator = (key: string, params?: Record<string, string | number>) => string;

/** 宿主 UI 传给每个 slot 组件的标准 props。 */
export interface SlotProps {
  sessionId?: string;
  /** 响应式读取宿主侧的 session projection（首次推送前为 undefined）。 */
  useProjection: <T = unknown>(key: string) => T | undefined;
  t: Translator;
}

export interface SlotRegistration {
  /** Slot 名称（位置），例如 conversation.input.dock。 */
  name: string;
  /** Slot 内唯一 id。 */
  id: string;
  /** 列表型 slot 内的排序值。 */
  order?: number;
  /** 组件 `t` 所绑定的 locale namespace。 */
  locale?: string;
  /** 带 key 的 slot 的键值（settings.plugin.item 以它所编辑的 namespace 为 key）。 */
  key?: string;
  /** 构造传给被注册组件的 props。 */
  inject?: () => unknown;
}

/** 单个 settings namespace 在客户端的同步视图（scope 契约的镜像）。 */
export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable';
  value: T | undefined;
  base: unknown;
  user: unknown;
  revision: number | undefined;
  writable: boolean;
  mode: 'host' | 'memory';
}

/** 对某个 namespace 持久化区间的响应式持有句柄。 */
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>;
  subscribe(listener: () => void): () => void;
  /** 将一次标量字段写入（点路径）排队提交。 */
  set(field: string, value: unknown): Promise<void>;
  /** 清空某字段，使其重新继承组合层的值。 */
  unset(field: string): Promise<void>;
}

export interface ClientContext {
  /** 注册一个与客户端插件生命周期绑定的 disposer。 */
  effect(disposer: () => void, label?: string): void;
  locale: {
    /** 在某个 namespace 下注册 zh/en 字典；返回 disposer。 */
    register(
      namespace: string,
      dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ): () => void;
    /** 将翻译函数绑定到某个 locale namespace；返回 { key, params } => string。 */
    bind(namespace: string): Translator;
  };
  slots: {
    /** 在某个已声明 slot 的作用域内执行 `callback`。 */
    inject(slotName: string, callback: () => unknown): void;
    /** 把一个 React 组件注册进 slot；返回 disposer。 */
    register(meta: SlotRegistration, component: unknown): () => void;
  };
  /** 设置传输通道：在当前 fiber 上绑定某个 namespace 的有界 scope。 */
  settingsScope: {
    bind<T>(spec: { namespace: string }): SettingsScope<T>;
  };
}
