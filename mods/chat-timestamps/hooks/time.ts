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

// Local date and time, e.g. "2026-Oct-20 14:32": year first so it reads in
// order, the month as a word so 10/11 can't be misread as day or month.
export function timeLabel(at: number, offsetMinutes: number): string {
  const local = new Date(at + offsetMinutes * 60_000)
  const date = `${local.getUTCFullYear()}-${MONTHS[local.getUTCMonth()]}-${pad(local.getUTCDate())}`
  return `${date} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
}

// The routes a row comes in by that the person sees as a chat message: their
// prompt, a prompt folded into a running turn, and Claude's reply blocks.
const CHAT_DOORS = new Set(['prompt', 'delivery', 'response'])

// Whether a stored row is a chat message of the main conversation (a
// subagent's rows carry an agentId and are never drawn as the chat).
export function isChatRow(row: { door: string; agentId?: string }): boolean {
  return row.agentId === undefined && CHAT_DOORS.has(row.door)
}
