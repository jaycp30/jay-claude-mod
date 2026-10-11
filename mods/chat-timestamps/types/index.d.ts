// chat-timestamps keeps one value per transcript row: when it was stored,
// in milliseconds since the epoch, or null when the mod didn't see it stored.
// A family (one member per row id) means recording a new message redraws
// only that message, not the whole chat.
export type SentAt = number | null

declare module 'claude-code' {
  interface PluginState {
    'chat-timestamps': { sentAt: StateFamily<SentAt> }
  }
}
