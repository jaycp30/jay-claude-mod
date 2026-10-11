// CLAUDE.md is hand-curated: Claude never edits it. A blocked edit is turned
// into a dated proposal entry that the person reviews later.

// CLAUDE.md and CLAUDE.local.md, in any folder, any case.
const CLAUDE_MD = /(^|\/)CLAUDE(\.local)?\.md$/i

export function isClaudeMd(path: string): boolean {
  return CLAUDE_MD.test(path)
}

// Best effort: a shell command whose write lands on a CLAUDE.md. It can't
// catch every spelling (a variable holding the path), which is why the
// Edit/Write rule is the real guard and this one a backstop.
const NAME = String.raw`\S*CLAUDE(\.local)?\.md\b`
const SHELL_WRITES = [
  // A redirect into it: > CLAUDE.md, >> CLAUDE.md (not 2>/dev/null after it).
  new RegExp(String.raw`>>?\s*${NAME}`, 'i'),
  // tee [-a] CLAUDE.md
  new RegExp(String.raw`\btee\s+(-\w+\s+)*${NAME}`, 'i'),
  // In-place editors, rm and truncate: CLAUDE.md anywhere in their arguments.
  new RegExp(String.raw`\b(sed|perl)\s+[^;&|]*-\w*i[^;&|]*${NAME}`, 'i'),
  new RegExp(String.raw`\b(rm|truncate)\s+[^;&|]*${NAME}`, 'i'),
  // cp / mv / ln / install: when CLAUDE.md is the destination (last word),
  // and for mv also the source (it disappears).
  new RegExp(String.raw`\b(cp|mv|ln|install)\s+[^;&|]*${NAME}\s*($|[;&|])`, 'i'),
  new RegExp(String.raw`\bmv\s+(-\w+\s+)*${NAME}`, 'i'),
]
export function bashWritesClaudeMd(command: string): boolean {
  return SHELL_WRITES.some(pattern => pattern.test(command))
}

// A unified-diff-looking body for the proposal, capped so a full-file Write
// can't bloat the notes file.
const MAX_LINES = 120
function capped(lines: string[]): string[] {
  return lines.length <= MAX_LINES
    ? lines
    : [...lines.slice(0, MAX_LINES), `... (${lines.length - MAX_LINES} more lines not shown)`]
}

export type ProposedChange =
  | { kind: 'edit'; oldText: string; newText: string }
  | { kind: 'write'; content: string }

export function proposalBody(change: ProposedChange): string {
  if (change.kind === 'write') {
    return capped(change.content.split('\n').map(l => `+ ${l}`)).join('\n')
  }
  const removed = change.oldText.split('\n').map(l => `- ${l}`)
  const added = change.newText.split('\n').map(l => `+ ${l}`)
  return capped([...removed, ...added]).join('\n')
}

// Header for a fresh proposals file, following the vault's conventions
// (H1, a one-line summary, #tags).
export const PROPOSALS_HEADER = `# CLAUDE.md proposals

Changes Claude wanted to make to a CLAUDE.md, recorded instead of applied. Review, apply by hand, then mark each one done. #claude-code

`

export type ProposalEntry = {
  stamp: string
  project: string
  file: string
  body: string
}

// One entry. The "Why" line is for Claude to fill in right after the block;
// the status tag lets later reviews find the open ones with a search.
export function proposalEntry(entry: ProposalEntry): string {
  return `## ${entry.stamp} · ${entry.file}

- Project: \`${entry.project}\`
- Status: #proposal/pending
- Why: (Claude adds the reason here)

\`\`\`diff
${entry.body}
\`\`\`

`
}

// The open proposals' headings, for the /claude-md-proposals command.
export function pendingHeadings(fileText: string): string[] {
  const sections = fileText.split(/^## /m).slice(1)
  return sections
    .filter(s => s.includes('#proposal/pending'))
    .map(s => (s.split('\n')[0] ?? '').trim())
}
