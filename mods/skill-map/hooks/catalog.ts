// Pure logic for skill-map: reading skill files, merging the two sources,
// the groups and their colours, and the prompts sent to the model and the
// parsing of its replies. No `$` here, so all of it is unit-tested on plain
// values.

import type { Pick, Skill } from '../types'

// ---- Groups -----------------------------------------------------------------

// The fixed groups, in the order the pane lists them, each with the theme
// colour it is drawn in. Theme keys follow the person's light/dark theme, so
// no hex is invented here.
export const GROUPS = [
  { name: 'UI / UX design', color: 'bashBorder' },
  { name: 'DevOps & cloud', color: 'warning' },
  { name: 'Code quality & review', color: 'success' },
  { name: 'Video & media', color: 'error' },
  { name: 'Docs & office files', color: 'suggestion' },
  { name: 'Notes & Obsidian', color: 'merged' },
  { name: 'Finance', color: 'planMode' },
  { name: 'Research & learning', color: 'claude' },
  { name: 'Claude Code & mods', color: 'permission' },
  { name: 'Other', color: 'subtle' },
] as const

// Where a skill goes before it is sorted, or when the model's answer for it
// can't be used. Shown last, so a failed sort is visible, never hidden.
export const UNSORTED = 'Unsorted'

const GROUP_NAMES: ReadonlySet<string> = new Set(GROUPS.map(g => g.name))

export function groupColor(group: string): string {
  return GROUPS.find(g => g.name === group)?.color ?? 'inactive'
}

// ---- Skill files --------------------------------------------------------------

// Reads `name` and `description` from a SKILL.md or command file's
// frontmatter. Handles the three forms seen in practice: a plain value, a
// quoted one, and a `>` / `|` block on the indented lines after the key.
// Anything else is left out rather than guessed.
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const lines = (match[1] ?? '').split(/\r?\n/)
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[i] ?? '')
    if (!field) continue
    const key = field[1] as 'name' | 'description'
    let value = (field[2] ?? '').trim()
    if (/^[>|][-+]?$/.test(value)) {
      // A block: every following line that is indented belongs to it.
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1] ?? '')) {
        block.push((lines[i + 1] ?? '').trim())
        i++
      }
      value = block.filter(Boolean).join(' ')
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1)
    }
    if (value) out[key] = value
  }
  return out
}

// A short, stable fingerprint of a description, so a skill is sorted again
// only when what it says about itself changes (djb2; not for security).
export function fingerprint(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

// The first sentence of a description, cut to `max` characters, for one row.
export function shortDescription(text: string, max = 140): string {
  const first = /^(.+?[.!?])(\s|$)/.exec(text.trim())?.[1] ?? text.trim()
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

// ---- Merging ------------------------------------------------------------------

// One command as $.command.list() reports it (CommandInfo's fields we use).
export type LoadedCommand = { name: string; description: string; source: string; plugin?: string }

// A skill or command file found on disk.
export type DiskSkill = { name: string; description: string; provider: string }

// Joins what the session loaded with what is on disk. A name in both is one
// skill, active, described by the session (the description it actually
// routes on). On disk only: installed but not loaded here. Built-in commands
// (/help, /compact) are not installed by anyone, so they are only counted.
export function mergeSkills(
  loaded: readonly LoadedCommand[],
  onDisk: readonly DiskSkill[],
): { skills: Skill[]; builtinCount: number } {
  const byName = new Map<string, Skill>()
  let builtinCount = 0
  for (const c of loaded) {
    if (c.source === 'builtin') { builtinCount++; continue }
    const provider = c.source === 'plugin' ? (c.plugin ?? 'plugin') : c.source
    byName.set(c.name, { name: c.name, description: c.description, sortText: c.description, provider, isActive: true })
  }
  for (const d of onDisk) {
    const known = byName.get(d.name)
    if (known) {
      // Loaded and on disk: sort on the file's description, which doesn't
      // change with whether this session loaded the skill.
      if (d.description) known.sortText = d.description
      continue
    }
    byName.set(d.name, { ...d, sortText: d.description, isActive: false })
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { skills, builtinCount }
}

// A plugin's skill is named "<plugin>:<skill>". The pane dims the prefix so
// the skill's own name stands out; the whole name is still what is typed.
export function splitName(name: string): { prefix: string; base: string } {
  const at = name.lastIndexOf(':')
  return at < 0 ? { prefix: '', base: name } : { prefix: name.slice(0, at + 1), base: name.slice(at + 1) }
}

// Skills installed more than once under different prefixes (a copy in
// ~/.claude/skills and the same one from a plugin or the claude.ai account):
// name -> the other names it shares its base with.
export function findDuplicates(skills: readonly Skill[]): Map<string, string[]> {
  const byBase = new Map<string, string[]>()
  for (const s of skills) {
    const { base } = splitName(s.name)
    byBase.set(base, [...(byBase.get(base) ?? []), s.name])
  }
  const out = new Map<string, string[]>()
  for (const names of byBase.values()) {
    if (names.length < 2) continue
    for (const name of names) out.set(name, names.filter(n => n !== name))
  }
  return out
}

// The prompt box after clicking a skill: `/name ` at the front, so it runs as
// a slash command, with whatever the person already typed kept after it. A
// draft that starts with one of the `commands` has that command swapped; any
// other leading `/word` (a path like /Users/jay/app.py) is kept as typed.
export function withSkill(draft: string, name: string, commands: ReadonlySet<string>): string {
  const text = draft.trimStart()
  if (text === '') return `/${name} `
  const first = /^\/(\S+)\s*/.exec(text)
  if (first && commands.has(first[1] ?? '')) {
    const rest = text.slice(first[0].length)
    return rest ? `/${name} ${rest}` : `/${name} `
  }
  return `/${name} ${text}`
}

// ---- Grouping for the pane ---------------------------------------------------

export type Group = { name: string; color: string; skills: Skill[] }

// The skills under their groups, in GROUPS order then Unsorted, empty groups
// left out. `filter` matches the name or description, case-insensitively.
export function groupSkills(
  skills: readonly Skill[],
  groups: Readonly<Record<string, string>>,
  filter: string,
): Group[] {
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? skills.filter(s => s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle))
    : skills
  const order = [...GROUPS.map(g => g.name), UNSORTED]
  return order
    .map(name => ({
      name,
      color: groupColor(name),
      skills: shown.filter(s => (GROUP_NAMES.has(groups[s.name] ?? '') ? groups[s.name] : UNSORTED) === name),
    }))
    .filter(g => g.skills.length > 0)
}

// Overrides file: `{ "skill-name": "Group name" }`. Entries naming a group
// that doesn't exist are dropped, so a typo can't make a skill vanish.
export function parseOverrides(text: string): Record<string, string> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return {} }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [name, group] of Object.entries(parsed)) {
    if (typeof group === 'string' && GROUP_NAMES.has(group)) out[name] = group
  }
  return out
}

// ---- Model prompts and replies ------------------------------------------------

// Model replies sometimes wrap JSON in a ```json fence or add a sentence
// around it; take the outermost {...} or [...] and parse that.
function extractJson(text: string, open: '{' | '['): unknown {
  const close = open === '{' ? '}' : ']'
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return undefined }
}

export function sortPrompt(skills: readonly Skill[]): string {
  const list = skills.map(s => `- ${s.name}: ${shortDescription(s.description, 300)}`).join('\n')
  return 'Sort each of these Claude Code skills into exactly one group.\n\n'
    + `Groups: ${GROUPS.map(g => g.name).join(' | ')}\n\n`
    + 'Use "Other" when none fits. Reply with one JSON object mapping each skill name to its group, '
    + 'names exactly as given, and nothing else.\n\n'
    + `Skills:\n${list}`
}

// Keeps only answers for skills that were asked about and groups that exist.
export function parseSortReply(text: string, asked: readonly string[]): Record<string, string> {
  const parsed = extractJson(text, '{')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const wanted = new Set(asked)
  const out: Record<string, string> = {}
  for (const [name, group] of Object.entries(parsed)) {
    if (wanted.has(name) && typeof group === 'string' && GROUP_NAMES.has(group)) out[name] = group
  }
  return out
}

export function suggestPrompt(context: { cwd: string; prompts: readonly string[] }, skills: readonly Skill[]): string {
  const list = skills.map(s => `- ${s.name}: ${shortDescription(s.description, 200)}`).join('\n')
  const prompts = context.prompts.length > 0
    ? context.prompts.map(p => `- ${p}`).join('\n')
    : '(none yet)'
  return 'A developer is working in Claude Code. From the installed skills below, pick the 3 to 5 '
    + 'that would help most with what they are doing now. Prefer skills they would not think of on their own.\n\n'
    + `Working folder: ${context.cwd}\n\nTheir recent prompts:\n${prompts}\n\n`
    + `Skills:\n${list}\n\n`
    + 'Reply with a JSON array of {"name": ..., "reason": ...}, the reason one short sentence '
    + 'tied to their work, names exactly as given, and nothing else.'
}

// Keeps picks that name a real skill (the model may invent one), at most 5,
// no duplicates.
export function parseSuggestReply(text: string, names: readonly string[]): Pick[] {
  const parsed = extractJson(text, '[')
  if (!Array.isArray(parsed)) return []
  const known = new Set(names)
  const picks: Pick[] = []
  for (const item of parsed) {
    const { name, reason } = (item ?? {}) as { name?: unknown; reason?: unknown }
    if (typeof name !== 'string' || !known.has(name) || picks.some(p => p.name === name)) continue
    picks.push({ name, reason: typeof reason === 'string' ? reason : '' })
    if (picks.length === 5) break
  }
  return picks
}
