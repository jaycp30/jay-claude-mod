// Pure time formatting. The hooks environment has no time zone of its own,
// so callers pass the machine's UTC offset (read once from `date +%z`).

// Parses `date +%z` output such as "+0100" or "-0530" into minutes.
export function parseOffset(text: string): number | undefined {
  const match = /^([+-])(\d\d)(\d\d)$/.exec(text.trim())
  if (!match) return undefined
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

// "14:32" for a message from the same local day as `today`, otherwise
// "Oct 10 14:32" -- the way messaging apps label older messages.
export function timeLabel(at: number, today: number, offsetMinutes: number): string {
  const local = new Date(at + offsetMinutes * 60_000)
  const now = new Date(today + offsetMinutes * 60_000)
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  const isSameDay = local.getUTCFullYear() === now.getUTCFullYear()
    && local.getUTCMonth() === now.getUTCMonth()
    && local.getUTCDate() === now.getUTCDate()
  return isSameDay ? time : `${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()} ${time}`
}

// The routes a row comes in by that the person sees as a chat message: their
// prompt, a prompt folded into a running turn, and Claude's reply blocks.
const CHAT_DOORS = new Set(['prompt', 'delivery', 'response'])

// Whether a stored row is a chat message of the main conversation (a
// subagent's rows carry an agentId and are never drawn as the chat).
export function isChatRow(row: { door: string; agentId?: string }): boolean {
  return row.agentId === undefined && CHAT_DOORS.has(row.door)
}
