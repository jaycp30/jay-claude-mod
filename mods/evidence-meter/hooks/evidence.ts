// Pure logic: classify each tool call of a turn, then summarise the turn as
// one line. No `$` here, so every rule is unit-tested on plain values.
//
// The meter measures grounding (what was looked at and run), not correctness:
// reading three files doesn't mean they were the right three.

export type Kind = 'read' | 'command' | 'check' | 'web' | 'edit' | 'agent' | 'other'

export type Call = {
  kind: Kind
  failed: boolean
  // Edited file, so "changed 2 files" counts files, not edits.
  file?: string
}

// Commands that verify something: test runners, type-checkers, validators.
// A passing one is the strongest evidence a turn can have.
const CHECK_COMMAND = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b`,
  String.raw`\b(pytest|vitest|jest|tsc|mypy|ruff|eslint|shellcheck)\b`,
  String.raw`\bpython3?\s+-m\s+(pytest|unittest)\b`,
  String.raw`\b(go|cargo)\s+test\b`,
  String.raw`\bmake\s+(test|check)\b`,
  String.raw`\bclaude\s+plugin\s+(test|validate)\b`,
  String.raw`\bterraform\s+(validate|plan)\b`,
  String.raw`\bcdk\s+synth\b`,
  String.raw`\bplaywright\s+test\b`,
].join('|'))

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])

export function classify(tool: string, input: Record<string, unknown>): Omit<Call, 'failed'> {
  if (READ_TOOLS.has(tool)) return { kind: 'read' }
  if (EDIT_TOOLS.has(tool)) {
    const file = typeof input.file_path === 'string' ? input.file_path
      : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    return { kind: 'edit', file }
  }
  if (WEB_TOOLS.has(tool)) return { kind: 'web' }
  if (AGENT_TOOLS.has(tool)) return { kind: 'agent' }
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return { kind: CHECK_COMMAND.test(command) ? 'check' : 'command' }
  }
  // MCP tools: browsers and fetchers read the web; the rest (AWS, databases, ...)
  // query live systems, which counts as running something.
  if (tool.startsWith('mcp__')) {
    return { kind: /browser|playwright|fetch|search|page_text|read_page/i.test(tool) ? 'web' : 'command' }
  }
  // AskUserQuestion, ToolSearch, Skill, TaskCreate...: not evidence either way.
  return { kind: 'other' }
}

// Answers shorter than this with no tools are small talk ("C.", "push"),
// labelled neutrally rather than warned about.
const SUBSTANTIAL_CHARS = 300

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function summarize(calls: Call[], answer: string): string {
  const count = (kind: Kind, failed?: boolean) =>
    calls.filter(c => c.kind === kind && (failed === undefined || c.failed === failed)).length
  const reads = count('read')
  const commands = count('command')
  const checksPassed = count('check', false)
  const checksFailed = count('check', true)
  const web = count('web')
  const agents = count('agent')
  const failed = calls.filter(c => c.failed && c.kind !== 'check').length
  const files = new Set(calls.filter(c => c.kind === 'edit').map(c => c.file ?? '?')).size

  const evidence = reads + commands + checksPassed + checksFailed + web + agents
  if (evidence === 0 && files === 0) {
    return answer.trim().length >= SUBSTANTIAL_CHARS
      ? '⚠ unchecked: answered without reading or running anything'
      : '○ no tools used'
  }

  const parts: string[] = []
  if (reads) parts.push(plural(reads, 'read', 'reads'))
  if (commands) parts.push(plural(commands, 'command', 'commands'))
  if (checksPassed) parts.push(`${plural(checksPassed, 'check', 'checks')} passed`)
  if (checksFailed) parts.push(`${plural(checksFailed, 'check', 'checks')} FAILED`)
  if (web) parts.push(`${web} web`)
  if (agents) parts.push(plural(agents, 'subagent', 'subagents'))
  if (files) parts.push(`changed ${plural(files, 'file', 'files')}`)
  if (failed) parts.push(`${failed} failed`)

  // Files changed but nothing run after the last change: the edit itself is
  // unverified, whatever was read before it.
  const lastEdit = calls.map(c => c.kind).lastIndexOf('edit')
  const ranAfterEdit = calls.slice(lastEdit + 1).some(c => c.kind === 'check' || c.kind === 'command')
  const isUnverifiedEdit = files > 0 && !ranAfterEdit
  if (isUnverifiedEdit) parts.push('nothing run after the last change')

  const isWarning = checksFailed > 0 || failed > 0 || isUnverifiedEdit
  return `${isWarning ? '⚠' : '✓'} ${parts.join(' · ')}`
}
