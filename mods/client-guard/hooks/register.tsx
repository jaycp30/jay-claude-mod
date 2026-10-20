// client-guard: four rules, one module.
//
//  1. Client AWS writes ask the person first (tool.check, so it is a
//     permission decision, and $.ui.ask, so the person answers it -- never the
//     auto-mode classifier).
//  2. Personal-project AWS calls must carry --region (tool.check deny, which
//     the model reads and fixes itself).
//  3. CLAUDE.md is never edited by Claude; the edit becomes a proposal in a
//     notes file (tool.call deny).
//  4. A band above the prompt shows client, ticket, profile and region.
//
// The engine requires a hook passed by name to be a function declared at the
// top level of this file, so the logic lives up here and `register` at the
// bottom only wires hooks to events. Settings reach the top level through the
// module variable `config`, set when `register` runs.

import { atom, read, update } from 'claude-code'
import type { CatchHandler, EngineInterface, Hook, PluginOptions, Register } from 'claude-code'

import type { AwsContext } from '../types'
import {
  clientContext, isRiskyProfile, isUnder, missingRegionHint, parseAwsCalls,
} from './aws'
import type { AwsCall } from './aws'
import {
  bashWritesClaudeMd, isClaudeMd, pendingHeadings, PROPOSALS_HEADER,
  proposalBody, proposalEntry,
} from './claudemd'
import type { ProposedChange } from './claudemd'

const lastAws = atom({ plugin: 'client-guard', key: 'lastAws' } as const, null as AwsContext | null)

const ALLOW = 'Allow once'
const DENY = 'Deny'

// The AWS API MCP server's tool is named mcp__<server key>__call_aws, and the
// server key is whatever each user called it, so match the suffix.
function isAwsMcpTool(tool: string): boolean {
  return /__call_aws$/.test(tool)
}

// ---- Settings ---------------------------------------------------------------

let config: PluginOptions = {}

// The folders from the settings with ~ expanded. Cached per module load.
let resolvedPaths: Promise<{ work: string; side: string; proposals: string }> | undefined
function paths($: EngineInterface) {
  resolvedPaths ??= (async () => {
    const home = (await $.env.get('HOME')) ?? ''
    const expand = (p: unknown) => String(p).replace(/^~(?=\/|$)/, home)
    return {
      work: expand(config.workRoot),
      side: expand(config.sideRoot),
      proposals: expand(config.proposalsFile),
    }
  })()
  return resolvedPaths
}

// The machine's UTC offset, for proposal timestamps. The hooks environment
// has no time zone of its own, so session.start asks the host once.
let offsetMinutes = 0
let offsetLabel = 'UTC'

async function stamp($: EngineInterface): Promise<string> {
  const local = new Date((await $.clock.now()) + offsetMinutes * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} `
    + `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} ${offsetLabel}`
}

// Every string field of an object, joined: the AWS MCP tool's input, whatever
// field it carries its CLI command in.
function commandOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const values = Object.values(input as Record<string, unknown>)
  return values.filter((v): v is string => typeof v === 'string').join('\n')
}

// The shell command a guarded tool would run, or undefined for any other tool.
// For Bash only `command` counts: its `description` is prose and once made
// "check the aws hook" look like an AWS call.
function awsCommandOf(tool: string, input: unknown): string | undefined {
  if (tool === 'Bash') {
    const command = (input as { command?: unknown } | null)?.command
    return typeof command === 'string' ? command : ''
  }
  return isAwsMcpTool(tool) ? commandOf(input) : undefined
}

// A guard that fails must not fail open. When a hook itself breaks, refuse
// anything that looks like AWS or CLAUDE.md and let everything else through,
// so a bug here can't stop all shell use.
function looksGuarded(text: string): boolean {
  return /\baws\b|CLAUDE(\.local)?\.md/i.test(text)
}

// ---- Rules 1 and 2: AWS calls ---------------------------------------------

type Plan =
  | { kind: 'pass' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; question: string; summary: string }

async function planFor($: EngineInterface, command: string): Promise<Plan> {
  const calls = parseAwsCalls(command)
  if (calls.length === 0) return { kind: 'pass' }
  const cwd = await $.session.cwd()
  const { work, side } = await paths($)

  if (isUnder(cwd, side)) {
    const fixes = calls
      .map(c => ({ c, hint: missingRegionHint(c, String(config.sideRegion), String(config.ssoRegion)) }))
      .filter((x): x is { c: AwsCall; hint: string } => x.hint !== undefined)
    if (fixes.length > 0) {
      const lines = fixes.map(f => `- aws ${f.c.service} ${f.c.operation}: add ${f.hint}`)
      return {
        kind: 'deny',
        reason: 'client-guard: personal-project AWS calls must pass --region explicitly '
          + `(the CLI default region is not the one to use).\n${lines.join('\n')}\n`
          + 'Re-run with the region added. If the stack lives elsewhere, use its region.',
      }
    }
  }

  if (isUnder(cwd, work)) {
    const writes = calls.filter(c => c.isWrite)
    if (writes.length > 0) {
      const { client } = clientContext(cwd, work)
      const summary = writes
        .map(c => `aws ${c.service} ${c.operation} (profile ${c.profile ?? 'default'}, region ${c.region ?? 'profile default'})`)
        .join('; ')
      return {
        kind: 'ask',
        summary,
        question: `${client ? `${client}: ` : ''}${summary}. Allow this AWS write in a client account?`,
      }
    }
  }
  return { kind: 'pass' }
}

const checkAws: Hook<'tool.check'> = async ($, e, next) => {
  const command = awsCommandOf(e.tool, e.input)
  if (command === undefined) return next(e)
  const plan = await planFor($, command)
  if (plan.kind === 'pass') return next(e)
  if (plan.kind === 'deny') return { decision: 'deny', reason: plan.reason }

  // Respect the person's own settings first: a rule that already denies this
  // call wins, and nobody is asked.
  const verdict = await next(e)
  if (verdict.decision === 'deny') return verdict
  // A query from $.tool.check (no real call) must not pop a dialog.
  if (e.tool_use_id === undefined) return { decision: 'ask', reason: plan.summary }

  // Dismissing the dialog rejects; that counts as a no.
  const answer = await $.ui
    .ask(plan.question, { options: [ALLOW, DENY], header: 'AWS write' })
    .catch(() => undefined)
  if (answer === ALLOW) {
    return { decision: 'allow', reason: `client-guard: approved by the user (${plan.summary})` }
  }
  const said = answer && answer !== DENY ? ` They said: "${answer}".` : ''
  return {
    decision: 'deny',
    reason: `client-guard: the user did not approve this client-account AWS write (${plan.summary}).${said} `
      + 'Do not retry it or work around it. Give the user the exact command in a bash block so they can run it themselves.',
  }
}

const checkAwsFailed: CatchHandler<Hook<'tool.check'>> = ($, e, next) =>
  looksGuarded(awsCommandOf(e.tool, e.input) ?? '')
    ? { decision: 'deny', reason: 'client-guard could not check this AWS call, so it was refused. Give the user the command to run themselves.' }
    : next(e)

// Remember the profile/region of the latest AWS call for the band. This only
// observes: the call goes on unchanged.
async function remember($: EngineInterface, command: string): Promise<void> {
  const calls = parseAwsCalls(command)
  const latest = calls[calls.length - 1]
  if (latest) {
    await update($, lastAws, () => ({ profile: latest.profile ?? 'default', region: latest.region }))
  }
}

// ---- Rule 3: CLAUDE.md is hand-curated -------------------------------------

async function propose($: EngineInterface, file: string, change: ProposedChange) {
  const { proposals } = await paths($)
  const existing = await $.fs.read(proposals).catch(() => PROPOSALS_HEADER)
  const when = await stamp($)
  const entry = proposalEntry({
    stamp: when,
    project: await $.session.cwd(),
    file,
    body: proposalBody(change),
  })
  await $.fs.write(proposals, `${existing.replace(/\n*$/, '\n\n')}${entry}`)
  // The same text proposalEntry puts after "## ", so Claude can find it.
  return { proposals, heading: `${when} · ${file}` }
}

function proposalReason(where: { proposals: string; heading: string }): string {
  return 'client-guard: CLAUDE.md files are hand-curated, so this edit was not applied. '
    + `It was recorded as a proposal in ${where.proposals} under "## ${where.heading}". `
    + 'Now edit that entry: replace "(Claude adds the reason here)" with one or two sentences on why the change helps. '
    + 'Then tell the user in one line that a CLAUDE.md proposal was recorded. Do not retry the edit or apply it another way.'
}

const CLAUDE_MD_REFUSAL = 'client-guard: CLAUDE.md files are hand-curated and are never edited by Claude. '
  + 'Describe the change as a proposal instead.'

// ---- Wiring -----------------------------------------------------------------

export const register: Register = (on, options) => {
  config = options

  on('session.start', async ($, e, next) => {
    const run = await $.process.run(['date', '+%z']).catch(() => undefined)
    const match = /^([+-])(\d\d)(\d\d)$/.exec(run?.stdout.trim() ?? '')
    if (match) {
      const sign = match[1] === '-' ? -1 : 1
      offsetMinutes = sign * (Number(match[2]) * 60 + Number(match[3]))
      offsetLabel = `UTC${match[1]}${match[2]}:${match[3]}`
    }
    await $.command.register({
      name: 'claude-md-proposals',
      description: 'Lists the CLAUDE.md changes Claude proposed instead of applying.',
    })
    return next(e)
  })

  // Rules 1 and 2, for the shell and for the AWS MCP server.
  // No matcher: Bash plus the AWS MCP tool under whatever server key it has;
  // checkAws passes every other tool straight through.
  on('tool.check', checkAws).catch(checkAwsFailed)

  // Rule 3.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!isClaudeMd(e.file_path)) return next(e)
    const where = await propose($, e.file_path, { kind: 'edit', oldText: e.old_string, newText: e.new_string })
    return { deny: proposalReason(where) }
  }).catch(($, e, next) => (next.called ? next(e) : isClaudeMd(e.file_path) ? { deny: CLAUDE_MD_REFUSAL } : next(e)))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!isClaudeMd(e.file_path)) return next(e)
    const where = await propose($, e.file_path, { kind: 'write', content: e.content })
    return { deny: proposalReason(where) }
  }).catch(($, e, next) => (next.called ? next(e) : isClaudeMd(e.file_path) ? { deny: CLAUDE_MD_REFUSAL } : next(e)))

  // Rule 3's shell backstop, plus remembering AWS context for the band.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (bashWritesClaudeMd(e.command)) {
      const { proposals } = await paths($)
      return {
        deny: `${CLAUDE_MD_REFUSAL} Shell commands that write CLAUDE.md are refused too. `
          + `Append the change as a new entry in ${proposals} (same format as the entries there), then tell the user in one line.`,
      }
    }
    await remember($, e.command)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : bashWritesClaudeMd(e.command) ? { deny: CLAUDE_MD_REFUSAL } : next(e)))

  on('tool.call', async ($, e, next) => {
    if (isAwsMcpTool(e.tool)) await remember($, commandOf(e))
    return next(e)
  }).catch(($, e, next) => next(e)) // only observes; a failure must not block any tool

  on('command.run', { command: 'claude-md-proposals' }, async $ => {
    const { proposals } = await paths($)
    const text = await $.fs.read(proposals).catch(() => undefined)
    if (text === undefined) return { text: `No proposals yet (${proposals} does not exist).` }
    const pending = pendingHeadings(text)
    if (pending.length === 0) return { text: `No pending CLAUDE.md proposals in ${proposals}.` }
    return {
      text: `${pending.length} pending CLAUDE.md proposal(s) in ${proposals}:\n`
        + pending.map(h => `- ${h}`).join('\n'),
    }
  })

  // Rule 4: the context band above the prompt. Other mods draw bands too
  // (context-meter), so this one stacks on top of whatever is beneath it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { work } = await paths($)
    const { client, ticket } = clientContext(await $.session.cwd(), work)
    const aws = await read($, lastAws)
    if (!client && !aws) return below

    const { Box, Text } = $.ui.resolve(e)
    const isRisky = isRiskyProfile(aws?.profile)
    const parts = [
      client,
      ticket ? `#${ticket}` : undefined,
      aws ? aws.profile : 'no AWS call yet',
      aws ? (aws.region ?? 'profile region') : undefined,
    ].filter((p): p is string => p !== undefined)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="subtle">{parts.join(' · ')}{aws ? '  ' : ''}</Text>
          {aws ? (
            <Text color={isRisky ? 'warning' : 'success'} bold={isRisky}>
              {isRisky ? 'write-capable' : 'read-only'}
            </Text>
          ) : null}
        </Box>
        {below}
      </Box>
    )
  })
}
