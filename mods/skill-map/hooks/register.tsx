// skill-map: every installed skill and slash command in one pane, grouped
// and coloured, with the model's picks for this session on top.
//
//  - A book button in the band above the prompt: 📕 while the pane is shut,
//    📖 while it shows. Clicking it toggles the pane. /skill-map opens it too.
//    context-meter draws it after its `details` when it can (hostedButton);
//    otherwise this mod draws it on a row of its own.
//  - The list merges what this session loaded ($.command.list()) with what is
//    on disk (~/.claude/skills, ~/.claude/commands, enabled plugins), so a
//    skill scoped to other folders still shows, marked "not active here".
//  - Groups: the model sorts each new or changed skill once; the answer is kept
//    in $.store across sessions, so opening the pane again costs nothing. An
//    overrides file the person edits always wins.
//  - "Suggest for this session" asks the model for 3-5 skills that fit the
//    working folder and the last few prompts. Only on a press: never automatic.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Catalog, HostedButton, Skill, SortStatus, Suggestions } from '../types'
import {
  findDuplicates, fingerprint, groupSkills, installedQuickButtons, mergeSkills, parseFrontmatter, parseOverrides,
  parseQuickButtons, parseSortReply, parseSuggestReply, shortDescription, sortPrompt, splitName,
  suggestPrompt, withSkill,
} from './catalog'
import type { DiskSkill } from './catalog'

const PANE = 'skill-map'
const TITLE = 'Skills'

const isOpen = atom({ plugin: 'skill-map', key: 'isOpen' } as const, false)
const hostedButton = atom({ plugin: 'skill-map', key: 'hostedButton' } as const, null as HostedButton | null)
const quickButtons = atom({ plugin: 'skill-map', key: 'quickButtons' } as const, [] as HostedButton[])
const catalog = atom({ plugin: 'skill-map', key: 'catalog' } as const, null as Catalog | null)
const groups = atom({ plugin: 'skill-map', key: 'groups' } as const, {} as Record<string, string>)
const sortStatus = atom({ plugin: 'skill-map', key: 'sortStatus' } as const, { kind: 'idle' } as SortStatus)
const suggestions = atom({ plugin: 'skill-map', key: 'suggestions' } as const, { kind: 'none' } as Suggestions)
const filter = atom({ plugin: 'skill-map', key: 'filter' } as const, '')
const recentPrompts = atom({ plugin: 'skill-map', key: 'recentPrompts' } as const, [] as string[])

// context-meter's state, read only to know whether it is drawing the book:
// it says it hosts buttons (hostsButton), and it draws its row once it has a
// reading (snapshot). Another mod's state: nothing is written.
const CONTEXT_METER_HOSTS = { plugin: 'context-meter', key: 'hostsButton' } as const
const CONTEXT_METER_SNAPSHOT = { plugin: 'context-meter', key: 'snapshot' } as const

// The store key for the model's sorting: name -> group and the fingerprint of
// the description it was sorted on.
const SORTED_KEY = 'sorted'
type Sorted = Record<string, { group: string; fp: string }>

// How many skills go in one sorting request, so the reply stays well under
// its token cap.
const SORT_BATCH = 80
const PROMPTS_KEPT = 5

let config: PluginOptions = {}

// Typed setters: an inline `() => ({ kind: 'idle' })` would widen `kind` to string.
const setSortStatus = ($: EngineInterface, value: SortStatus) => update($, sortStatus, () => value)
const setSuggestions = ($: EngineInterface, value: Suggestions) => update($, suggestions, () => value)

// ---- Reading the disk ---------------------------------------------------------

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

function expand(path: unknown, homeDir: string): string {
  return String(path).replace(/^~(?=\/|$)/, homeDir)
}

// A folder's entries, or none when it doesn't exist.
async function list($: EngineInterface, path: string) {
  return $.fs.list(path).catch(() => [])
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await $.fs.read(path).catch(() => undefined)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

// Skills under <dir>/skills/<name>/SKILL.md and commands under
// <dir>/commands/<name>.md, named with `prefix` (a plugin's "name:").
async function scanFolder($: EngineInterface, dir: string, prefix: string, provider: string): Promise<DiskSkill[]> {
  const [skillDirs, commandFiles] = await Promise.all([list($, `${dir}/skills`), list($, `${dir}/commands`)])
  const skills = skillDirs
    .filter(entry => entry.kind === 'dir' || entry.isLink)
    .map(async entry => {
      const text = await $.fs.read(`${dir}/skills/${entry.name}/SKILL.md`).catch(() => undefined)
      if (text === undefined) return undefined
      const meta = parseFrontmatter(text)
      return { name: `${prefix}${meta.name ?? entry.name}`, description: meta.description ?? '', provider }
    })
  const commands = commandFiles
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .map(async entry => {
      const text = await $.fs.read(`${dir}/commands/${entry.name}`).catch(() => '')
      return { name: `${prefix}${entry.name.slice(0, -3)}`, description: parseFrontmatter(text).description ?? '', provider }
    })
  const found = await Promise.all([...skills, ...commands])
  return found.filter((s): s is DiskSkill => s !== undefined)
}

// Everything installed: the person's own skills and commands, and those of
// each enabled plugin. Turned-off plugins are only counted, so a large one
// (ecc's 300+) can't bury the rest. Only the user's own settings.json is
// read for what is turned on: a plugin enabled just for one project counts
// as on, and one listed nowhere counts as on (the install default).
async function scanDisk($: EngineInterface): Promise<{ skills: DiskSkill[]; disabledPlugins: Catalog['disabledPlugins'] }> {
  const claudeDir = `${await home($)}/.claude`
  const installed = (await readJson($, `${claudeDir}/plugins/installed_plugins.json`)) as
    { plugins?: Record<string, { installPath?: string; scope?: string }[]> } | undefined
  const settings = (await readJson($, `${claudeDir}/settings.json`)) as
    { enabledPlugins?: Record<string, boolean> } | undefined

  const own = scanFolder($, claudeDir, '', 'user')
  const plugins = Object.entries(installed?.plugins ?? {}).map(async ([key, installs]) => {
    const name = key.split('@')[0] ?? key
    // A plugin can be installed once per scope; the user-scope copy is the
    // one every session sees.
    const path = (installs.find(i => i.scope === 'user') ?? installs[0])?.installPath
    if (!path) return { name, skills: [], isEnabled: false }
    const skills = await scanFolder($, path, `${name}:`, name)
    return { name, skills, isEnabled: settings?.enabledPlugins?.[key] !== false }
  })
  const results = await Promise.all(plugins)
  return {
    skills: [...(await own), ...results.filter(p => p.isEnabled).flatMap(p => p.skills)],
    disabledPlugins: results
      .filter(p => !p.isEnabled && p.skills.length > 0)
      .map(p => ({ name: p.name, count: p.skills.length })),
  }
}

// ---- Groups ---------------------------------------------------------------------

async function overrides($: EngineInterface): Promise<Record<string, string>> {
  const text = await $.fs.read(expand(config.overridesFile, await home($))).catch(() => '{}')
  return parseOverrides(text)
}

async function storedSorting($: EngineInterface): Promise<Sorted> {
  const value = await $.store.get(SORTED_KEY).catch(() => undefined)
  return typeof value === 'object' && value !== null ? (value as Sorted) : {}
}

// Recomputes what the pane shows from the store and the overrides, and says
// which skills still need the model: new ones and ones whose description
// changed. A changed skill keeps its old group on screen until it is re-sorted.
async function applyGroups($: EngineInterface, skills: readonly Skill[]): Promise<Skill[]> {
  const [sorted, manual] = await Promise.all([storedSorting($), overrides($)])
  const next: Record<string, string> = {}
  const toSort: Skill[] = []
  for (const s of skills) {
    const kept = sorted[s.name]
    const group = manual[s.name] ?? kept?.group
    if (group) next[s.name] = group
    if (!manual[s.name] && kept?.fp !== fingerprint(s.sortText)) toSort.push(s)
  }
  await update($, groups, () => next)
  return toSort
}

// Sorts the given skills with the model, in batches, saving after each so a
// failure part-way keeps what was done. A reply that can't be read at all
// stops the sort (shown in the pane; tried again on the next open). In a reply
// that does read, a skill it leaves out goes to "Other" rather than being
// asked about again on every open.
let isSorting = false
async function sortSkills($: EngineInterface, skills: readonly Skill[]): Promise<void> {
  if (isSorting || skills.length === 0) return
  isSorting = true
  try {
    await setSortStatus($, { kind: 'sorting', count: skills.length })
    for (let i = 0; i < skills.length; i += SORT_BATCH) {
      const batch = skills.slice(i, i + SORT_BATCH)
      const reply = await $.model.complete({
        model: String(config.model), prompt: sortPrompt(batch), maxTokens: 4000, timeoutMs: 90_000,
      })
      if (!reply.isAnswered) {
        await setSortStatus($, { kind: 'failed', reason: reply.reason })
        return
      }
      const answer = parseSortReply(reply.text, batch.map(s => s.name))
      if (Object.keys(answer).length === 0) {
        await setSortStatus($, { kind: 'failed', reason: "the model's reply could not be read" })
        return
      }
      const sorted = await storedSorting($)
      for (const s of batch) sorted[s.name] = { group: answer[s.name] ?? 'Other', fp: fingerprint(s.sortText) }
      await $.store.set(SORTED_KEY, sorted)
      const current = await read($, catalog)
      if (current) await applyGroups($, current.skills)
    }
    await setSortStatus($, { kind: 'idle' })
  } catch (error) {
    await setSortStatus($, { kind: 'failed', reason: String(error) })
  } finally {
    isSorting = false
  }
}

// Reads the whole list again and sorts whatever is new. Called on every open,
// so a skill installed mid-session shows the next time the pane opens.
async function refresh($: EngineInterface): Promise<void> {
  const [loaded, disk] = await Promise.all([$.command.list().catch(() => undefined), scanDisk($)])
  const { skills, builtinCount } = mergeSkills(loaded ?? [], disk.skills)
  const listFailed = loaded === undefined
  await update($, catalog, () => ({ skills, builtinCount, disabledPlugins: disk.disabledPlugins, listFailed }))
  const toSort = await applyGroups($, skills)
  // Without the session's list every skill looks disk-only; sorting on that
  // could spend a model call on skills that are already sorted.
  if (!listFailed) await sortSkills($, toSort)
}

// ---- The pane -------------------------------------------------------------------

// The book: closed while the pane is shut, open while it shows.
function bookLabel(open: boolean): string {
  return open ? '📖' : '📕'
}

// Records whether the pane is open, and offers the matching book to a host
// band (context-meter) in the same step, so the two never disagree.
async function setOpen($: EngineInterface, open: boolean): Promise<void> {
  await update($, isOpen, () => open)
  await update($, hostedButton, () => ({ label: bookLabel(open), command: 'skill-map', args: 'toggle' }))
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
  await setOpen($, true)
  // Not awaited: the pane draws "Reading skills…" while this runs.
  void refresh($).catch(error => $.ui.log(`skill-map: could not read the skills: ${String(error)}`))
}

async function toggle($: EngineInterface): Promise<void> {
  // The engine's pane list decides, not the isOpen atom, so the book can't
  // get out of step with the pane. Closed here as well as in the ui.close
  // hook: a close made from this plugin's own button press does not reach
  // that hook (seen in the tests), and writing "closed" twice is harmless.
  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    await setOpen($, false)
  } else {
    await openPane($)
  }
}

// Types the skill into the prompt box, keeping anything already typed there
// (withSkill). If the draft can't be read, nothing is filled: a replace would
// wipe what the person typed. Under a dialog the box takes nothing, which is
// fine to ignore.
async function typeSkill($: EngineInterface, name: string): Promise<void> {
  const box = await $.prompt.read().catch(() => undefined)
  if (!box) return
  const commands = new Set((await read($, catalog))?.skills.map(s => s.name) ?? [])
  await $.prompt.fill({ text: withSkill(box.text, name, commands), mode: 'replace' }).catch(() => undefined)
}

// Runs a skill as if the person typed it. The engine may refuse to run a
// skill (rather than a mod's own command) from a mod; then it is typed into
// the box instead, so the press still leaves the person one Enter away.
async function runSkill($: EngineInterface, name: string): Promise<void> {
  try {
    await $.command.run({ command: name })
  } catch (error) {
    $.ui.log(`skill-map: /${name} could not run from a button (${String(error)}), so it was typed instead`)
    await typeSkill($, name)
  }
}

// The quick buttons as the host draws them, only for skills this session
// loaded: each press runs `/skill-map run <name>` or `/skill-map type <name>`.
async function offeredQuickButtons($: EngineInterface): Promise<HostedButton[]> {
  const loaded = await $.command.list().catch(() => undefined)
  const names = loaded ? new Set(loaded.map(c => c.name)) : undefined
  return installedQuickButtons(parseQuickButtons(String(config.quickButtons ?? '')), names)
    .map(b => ({ label: b.label, command: 'skill-map', args: `${b.action} ${b.name}` }))
}

// One suggestion request at a time: a second press while one runs does
// nothing (the flag, not the drawn state, which lags a fast double press).
let isSuggesting = false
async function suggest($: EngineInterface): Promise<void> {
  const current = await read($, catalog)
  if (!current || isSuggesting) return
  isSuggesting = true
  try {
    await setSuggestions($, { kind: 'thinking' })
    // Only skills loaded here: a pick that isn't would not run when typed.
    const usable = current.skills.filter(s => s.isActive)
    const prompt = suggestPrompt({ cwd: await $.session.cwd(), prompts: await read($, recentPrompts) }, usable)
    const reply = await $.model.complete({ model: String(config.model), prompt, maxTokens: 1000, timeoutMs: 60_000 })
    if (!reply.isAnswered) {
      await setSuggestions($, { kind: 'failed', reason: reply.reason })
      return
    }
    const picks = parseSuggestReply(reply.text, usable.map(s => s.name))
    await setSuggestions($, picks.length > 0
      ? { kind: 'done', picks }
      : { kind: 'failed', reason: 'the reply named no installed skill' })
  } catch (error) {
    // The engine refused to send (a blocked model, say): show it, don't stick
    // on "Thinking…".
    await setSuggestions($, { kind: 'failed', reason: String(error) })
  } finally {
    isSuggesting = false
  }
}

// ---- Wiring -----------------------------------------------------------------------

export const register: Register = (on, options) => {
  config = options

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // immediate: a press on the hosted book runs `/skill-map toggle` at once,
    // even while a turn is running.
    await $.command.register({
      name: 'skill-map',
      description: 'Show every installed skill, grouped, with picks for this session',
      argumentHint: '[toggle]',
      immediate: true,
    })
    // After a reload the pane may still be up: draw the book to match.
    const panes = await $.ui.panes().catch(() => [])
    await setOpen($, panes.some(p => p.id === PANE))
    const offered = await offeredQuickButtons($)
    await update($, quickButtons, () => offered)
    // State outlives a reload but the work behind it doesn't: a request that
    // was "thinking" or "sorting" when the module reloaded will never finish.
    if ((await read($, suggestions)).kind === 'thinking') await setSuggestions($, { kind: 'none' })
    if ((await read($, sortStatus)).kind === 'sorting') await setSortStatus($, { kind: 'idle' })
    return started
  })

  // `/skill-map` opens the pane; `/skill-map toggle` is what the hosted book
  // runs, and `run <skill>` / `type <skill>` what the quick buttons run. Those
  // answer with no text so a click leaves no line in the chat.
  on('command.run', { command: 'skill-map' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'toggle') {
      await toggle($)
      return {}
    }
    const quick = /^(run|type)\s+(\S+)$/.exec(args)
    if (quick?.[2]) {
      await (quick[1] === 'run' ? runSkill($, quick[2]) : typeSkill($, quick[2]))
      return {}
    }
    await openPane($)
    return { text: 'Skill map opened.' }
  })

  // Whoever closes the pane (the book, the close mark, Esc), the book closes.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await setOpen($, false)
    return result
  }).catch(($, e, next) => next(e))

  // Remembers the person's last few prompts for the suggestions. It only
  // reads: the prompt goes on unchanged.
  on('prompt.submit', async ($, e, next) => {
    if (!e.command && e.text.trim()) {
      const text = e.text.trim().slice(0, 300)
      await update($, recentPrompts, prompts => [...prompts, text].slice(-PROMPTS_KEPT))
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // only observes; a failure must not block a prompt

  // The book's fallback row: at the right of the band, beside the other mods'
  // bands (drawn beneath this hook).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    // context-meter draws the hosted book after its `details` while it has a
    // reading to show; then this hook adds nothing. Without context-meter (or
    // before its first reading) the book gets a row of its own here.
    // Cast: the types only know this mod's own state, and depending on
    // context-meter just for the types would make it required.
    // Each read written out: the engine lists a module's state reads from the
    // source, so every reference must appear literally at its call.
    type Read = Promise<{ value?: unknown }>
    const [hosts, meter] = await Promise.all([
      ($.state.get(CONTEXT_METER_HOSTS as never) as Read).catch(() => undefined),
      ($.state.get(CONTEXT_METER_SNAPSHOT as never) as Read).catch(() => undefined),
    ])
    if (hosts?.value === true && meter?.value) return below
    const [open, quick] = await Promise.all([read($, isOpen), read($, quickButtons)])
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexDirection="column" flexGrow={1}>{below}</Box>
        <Box marginLeft={1}>
          <Button key="book" label={bookLabel(open)} onPress={() => toggle($)} />
          {quick.map(b => (
            <Box key={`quick:${b.args}`} marginLeft={1}>
              <Button
                key={`quickbutton:${b.args}`} label={b.label}
                onPress={() => void $.command.run({ command: b.command, args: b.args })
                  .catch(error => $.ui.log(`skill-map: /${b.command} ${b.args} failed: ${String(error)}`))}
              />
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const current = await read($, catalog)
    if (!current) return <Text dimColor>Reading skills…</Text>

    const [shown, status, picks, needle] = await Promise.all([
      read($, groups), read($, sortStatus), read($, suggestions), read($, filter),
    ])
    const grouped = groupSkills(current.skills, shown, needle)
    const duplicates = findDuplicates(current.skills)
    // The terminal stays compact; other surfaces get a gap between skills.
    const isTerminal = e.surface === 'terminal'
    const byName = new Map(current.skills.map(s => [s.name, s]))
    const suggestLabel = picks.kind === 'thinking' ? 'Thinking…'
      : picks.kind === 'none' ? 'Suggest for this session' : 'Suggest again'

    return (
      <Box flexDirection="column">
        <Text bold>{`${current.skills.length} skills and commands`}</Text>
        {'Input' in ui ? (
          <ui.Input
            key="filter" placeholder="Filter by name or description" value={needle}
            onInput={(value: string) => void update($, filter, () => value)}
            onSubmit={(value: string) => void update($, filter, () => value)}
          />
        ) : null}

        <Box marginTop={1}>
          <Button key="suggest" label={suggestLabel} onPress={() => void suggest($)} />
        </Box>
        {picks.kind === 'failed' && <Text color="warning">{`No suggestions: ${picks.reason}.`}</Text>}
        {picks.kind === 'done' && picks.picks.map(p => (
          <Box key={`pickrow:${p.name}`} flexDirection="column">
            <Button key={`pick:${p.name}`} plain label={`/${p.name}`} onPress={() => typeSkill($, p.name)}>
              <Text color="claude" bold>{`★ /${p.name}`}</Text>
            </Button>
            <Text dimColor>{`  ${p.reason || shortDescription(byName.get(p.name)?.description ?? '')}`}</Text>
          </Box>
        ))}

        {current.listFailed && (
          <Text color="warning">This session's command list could not be read: skills show as not active, and new ones wait to be sorted.</Text>
        )}
        {status.kind === 'sorting' && <Text color="suggestion">{`Sorting ${status.count} new skill(s) into groups…`}</Text>}
        {status.kind === 'failed' && <Text color="warning">{`Sorting stopped (${status.reason}); the rest stay under Unsorted.`}</Text>}

        {grouped.map(group => (
          <Box key={`group:${group.name}`} flexDirection="column" marginTop={1}>
            <Text color={group.color} bold size="heading">{`■ ${group.name}  ${group.skills.length}`}</Text>
            {group.skills.map(s => {
              // Per skill: the name as a button that types it into the prompt
              // box (plugin prefix dimmed so the skill's own name stands out),
              // a smaller description, and a note when it is installed twice.
              const { prefix, base } = splitName(s.name)
              const others = duplicates.get(s.name)
              return (
                <Box key={`row:${s.name}`} flexDirection="column" marginBottom={isTerminal ? 0 : 1}>
                  <Button key={`skill:${s.name}`} plain label={`/${s.name}`} onPress={() => typeSkill($, s.name)}>
                    <Text color={group.color} dimColor>{`/${prefix}`}</Text>
                    <Text color={group.color} dimColor={!s.isActive}>{base}</Text>
                  </Button>
                  <Text dimColor size="footnote" wrap="truncate-end">
                    {`  ${shortDescription(s.description) || '(no description)'}${s.isActive ? '' : ' · not active here'}`}
                  </Text>
                  {others && <Text color="warning" size="footnote">{`  also installed as /${others.join(', /')}`}</Text>}
                </Box>
              )
            })}
          </Box>
        ))}
        {grouped.length === 0 && <Text dimColor>{`Nothing matches "${needle}".`}</Text>}

        <Box flexDirection="column" marginTop={1}>
          {current.builtinCount > 0 && <Text dimColor>{`${current.builtinCount} built-in commands not listed (see /help).`}</Text>}
          {current.disabledPlugins.length > 0 && (
            <Text dimColor>
              {`Turned-off plugins not listed: ${current.disabledPlugins.map(p => `${p.name} (${p.count})`).join(', ')}.`}
            </Text>
          )}
          <Text dimColor>{`Move a skill to another group in ${String(config.overridesFile)}.`}</Text>
        </Box>
      </Box>
    )
  })
}
