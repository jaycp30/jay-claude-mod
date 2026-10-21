// What skill-map keeps in the session's state. The pane and the band read
// these; every write redraws them.

// One skill or slash command, merged from what the session loaded and what
// was found on disk.
export type Skill = {
  // What the person types, without the slash ("terraform-skill", "pr:codereview").
  name: string
  description: string
  // The text its group is decided on, and fingerprinted to spot a change: the
  // file's own description when there is one, so a skill moving in and out of
  // the session (whose one-line description can differ) is not re-sorted.
  sortText: string
  // Who provides it: "user" (~/.claude), a plugin's name, or "mcp".
  provider: string
  // False when it is installed but this session did not load it (a skill
  // scoped to other folders, say).
  isActive: boolean
}

// The whole list as the pane last read it.
export type Catalog = {
  skills: Skill[]
  // Things left out on purpose, so the pane can say so.
  builtinCount: number
  disabledPlugins: { name: string; count: number }[]
  // True when this session's command list could not be read: every skill
  // then looks inactive, so the pane says so and sorting waits.
  listFailed: boolean
}

// Where the one-off sort of new skills into groups stands.
export type SortStatus =
  | { kind: 'idle' }
  | { kind: 'sorting'; count: number }
  | { kind: 'failed'; reason: string }

// A skill the model thinks fits this session, and why.
export type Pick = { name: string; reason: string }

export type Suggestions =
  | { kind: 'none' }
  | { kind: 'thinking' }
  | { kind: 'done'; picks: Pick[] }
  | { kind: 'failed'; reason: string }

// Keep in sync with context-meter's copy (mods/context-meter/hooks/meter.ts):
// neither mod depends on the other, so each writes the shape down itself.
// The book button skill-map offers to another mod's band row, so it can sit
// on that line (context-meter draws it after its `details`). The host knows
// nothing about skill-map: it draws `label` and runs `/<command> <args>` on a
// press. Rewritten whenever the pane opens or closes.
export type HostedButton = {
  // 📕 while the pane is shut, 📖 while it shows.
  label: string
  command: string
  args: string
}

declare module 'claude-code' {
  interface PluginState {
    'skill-map': {
      // True while the pane is open: the band draws the open book.
      isOpen: boolean
      hostedButton: HostedButton | null
      // The quick buttons from the settings (🧐, 🙋🏻), offered the same way:
      // the host draws them after the book.
      quickButtons: HostedButton[]
      catalog: Catalog | null
      // name -> group, from the store plus the person's overrides.
      groups: Record<string, string>
      sortStatus: SortStatus
      suggestions: Suggestions
      filter: string
      // The person's last few prompts, for the suggestions.
      recentPrompts: string[]
    }
  }
}
