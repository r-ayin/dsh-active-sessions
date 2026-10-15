/**
 * dsh-active-sessions — host 半区。
 * 纯浏览器插件（同 better-sidebar 模式）：host 侧无行为，
 * UI 全部在 client 半区（src/client/index.tsx → lib/client.js）。
 */
export const name = 'dsh-active-sessions'

/** Host loader entry: browser-only plugin, no host-side behavior. */
export function apply(): void {}
