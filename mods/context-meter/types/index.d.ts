// What context-meter keeps in the session's state: the latest breakdown of
// the context window, trimmed to what the band and the pane draw. Every
// drawing that reads it redraws when a new one is written.

// One category of the window, as /context lists it.
export type ContextRow = {
  name: string
  tokens: number
  // The theme colour /context draws this category in (e.g. "promptBorder").
  color: string
  // used: in the window · free: room left · buffer: compaction reserve ·
  // deferred: tool schemas loaded on demand, not in the window.
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type ContextSnapshot = {
  // Tokens in use (the engine's estimate) and the window measured against.
  total: number
  max: number
  // Where auto-compaction kicks in; absent when it's off.
  compactAt?: number
  model: string
  rows: ContextRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      snapshot: ContextSnapshot | null
      // True once this mod draws buttons other mods offer after `details`
      // (skill-map's book), so they know not to draw their own.
      hostsButton: boolean
    }
  }
}
