// Integration tests: the real hooks, run by the engine, with the disk, the
// store, the command list and the model mocked in memory.
import type { FsEntry, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const HOME = '/home/jay'

const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })
const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n`

const FOLDERS: Record<string, FsEntry[]> = {
  [`${HOME}/.claude/skills`]: [dir('terraform-skill'), dir('graphify'), dir('codereview')],
  '/plugins/pr/commands': [file('codereview.md')],
  '/plugins/ecc/skills': [dir('one'), dir('two')],
}
const FILES: Record<string, string> = {
  [`${HOME}/.claude/skills/terraform-skill/SKILL.md`]: skillMd('terraform-skill', 'Terraform modules and state.'),
  [`${HOME}/.claude/skills/graphify/SKILL.md`]: skillMd('graphify', 'Graph a large corpus.'),
  [`${HOME}/.claude/skills/codereview/SKILL.md`]: skillMd('codereview', 'An older copy of the PR review.'),
  '/plugins/pr/commands/codereview.md': '---\ndescription: Multi-model PR review\n---\n',
  '/plugins/ecc/skills/one/SKILL.md': skillMd('one', 'One.'),
  '/plugins/ecc/skills/two/SKILL.md': skillMd('two', 'Two.'),
  [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
    plugins: { 'pr@codereview-ai': [{ installPath: '/plugins/pr' }], 'ecc@ecc': [{ installPath: '/plugins/ecc' }] },
  }),
  [`${HOME}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'pr@codereview-ai': true, 'ecc@ecc': false } }),
}

// What the session loaded: graphify is on disk but not loaded here.
const LOADED = [
  { name: 'help', description: 'Show help', source: 'builtin' },
  { name: 'terraform-skill', description: 'Terraform modules and state.', source: 'user' },
  { name: 'figma', description: 'Import a Figma design.', source: 'plugin', plugin: 'hyperframes' },
  { name: 'pr:codereview', description: 'Multi-model PR review', source: 'plugin', plugin: 'pr' },
]

const SORTED = {
  'terraform-skill': 'DevOps & cloud', figma: 'UI / UX design',
  'pr:codereview': 'Code quality & review', graphify: 'Research & learning',
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// A reply, an answered-but-failed call, or a call the engine refuses to send.
type ModelAnswer = { text: string } | { fail: true } | { refuse: true }

// Mocks everything the plugin reaches and returns what it observed.
function world(on: On, model: (prompt: string) => ModelAnswer, options: { listFails?: boolean } = {}) {
  const seen = { prompts: [] as string[], opened: [] as string[] }
  const open = new Set<string>()
  mock.env(on, { HOME })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: `${HOME}/Claude-test/infra` }))
  on('command.register', () => ({ value: { command: 'skill-map' } }))
  on('command.list', () => (options.listFails ? { deny: 'no list' } : { value: LOADED as never }))
  on('fs.list', ($, e) => {
    const entries = FOLDERS[e.path]
    return entries ? { value: entries } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', ($, e) => {
    const text = FILES[e.path]
    return text !== undefined ? { value: text } : { deny: `ENOENT: ${e.path}` }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('model.complete', ($, e) => {
    const prompt = String(e.prompt)
    seen.prompts.push(prompt)
    const answer = model(prompt)
    if ('refuse' in answer) return { deny: 'blocked model' }
    return 'fail' in answer
      ? { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE } as never }
      : { value: { isAnswered: true, text: answer.text, usage: USAGE } }
  })
  // Another mod's band beneath this one (context-meter's, say).
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  return seen
}

// A model that sorts and suggests as asked.
const goodModel = (prompt: string): ModelAnswer => prompt.startsWith('Sort')
  ? { text: JSON.stringify(SORTED) }
  : { text: JSON.stringify([{ name: 'terraform-skill', reason: 'You are in an infra folder.' }, { name: 'ghost', reason: 'x' }]) }

const BAND = {
  component: 'AbovePrompt', requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PANE = {
  component: 'Pane', requestId: 'skill-map',
  props: { title: 'Skills', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const

describe('the book', () => {
  test('a closed-book button beside the other bands, on every surface', async ($, on) => {
    world(on, goodModel)
    await $.session.start(start)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ plugin: 'skill-map', surface, ...BAND } as never)
      expect((await band.find({ key: 'book' }))?.props.label).toBe('📕')
      expect(await band.find({ type: 'Text', text: 'other band' })).toBeDefined()
      await band.unmount()
    }
  })

  test('pressing it opens the pane and the book; pressing again closes both', async ($, on) => {
    const seen = world(on, goodModel)
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    await band.press({ key: 'book' })
    expect(seen.opened).toEqual(['skill-map'])
    expect((await band.find({ key: 'book' }))?.props.label).toBe('📖')
    await band.press({ key: 'book' })
    expect((await band.find({ key: 'book' }))?.props.label).toBe('📕')
    await band.unmount()
  })
})

describe('hosted by context-meter', () => {
  // Answers reads of context-meter's state: whether it hosts buttons, and
  // whether it has a reading (so draws its row).
  function contextMeter(on: On, state: { hostsButton: boolean; snapshot: unknown }) {
    on('state.get', ($, e, next) => {
      const { plugin, key } = e as unknown as { plugin: string; key: string }
      const value = key === 'hostsButton' ? state.hostsButton : state.snapshot
      return plugin === 'context-meter' ? { value: { value, version: 1 } as never } : next(e)
    })
  }

  test('when context-meter hosts the book and has a reading, the band is left to it', async ($, on) => {
    world(on, goodModel)
    contextMeter(on, { hostsButton: true, snapshot: { total: 1 } })
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    expect(await band.find({ key: 'book' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'other band' })).toBeDefined()
    await band.unmount()
  })

  test('an older context-meter with a reading but no hosting still gets the book drawn', async ($, on) => {
    world(on, goodModel)
    contextMeter(on, { hostsButton: false, snapshot: { total: 1 } })
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    expect((await band.find({ key: 'book' }))?.props.label).toBe('📕')
    await band.unmount()
  })

  test('/skill-map toggle flips the pane silently and updates the offered book', async ($, on) => {
    const seen = world(on, goodModel)
    // Watch what skill-map offers context-meter: every write of hostedButton.
    const offers: string[] = []
    on('state.set', ($, e, next) => {
      const { key, value } = e as { key: string; value?: { label?: string; args?: string } }
      if (key === 'hostedButton') offers.push(`${value?.label} / ${value?.args}`)
      return next(e)
    })
    await $.session.start(start)
    // The fields the engine stamps on a typed command.
    const run = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }

    const result = await $.command.run({ command: 'skill-map', args: 'toggle', ...run } as never)
    expect(result.text).toBeUndefined()
    expect(seen.opened).toEqual(['skill-map'])
    await $.command.run({ command: 'skill-map', args: 'toggle', ...run } as never)
    // The states offered in order; the same state written twice in a row is one.
    const changes = offers.filter((o, i) => o !== offers[i - 1])
    expect(changes).toEqual(['📕 / toggle', '📖 / toggle', '📕 / toggle'])
  })
})

describe('the pane', () => {
  test('lists skills under coloured groups, sorted by the model once', async ($, on) => {
    const seen = world(on, goodModel)
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    await band.press({ key: 'book' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: 'skill-map', surface, ...PANE } as never)
      const devops = await pane.find({ type: 'Text', text: /DevOps & cloud/ })
      expect(devops?.text).toBe('■ DevOps & cloud  1')
      expect(devops?.props.color).toBe('warning')
      expect(await pane.find({ type: 'Text', text: 'terraform-skill' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '/pr:' })).toBeDefined()
      expect((await pane.find({ type: 'Text', text: /also installed as/ }))?.text).toBe('  also installed as /codereview')
      expect(await pane.find({ type: 'Text', text: /Graph a large corpus\. · not active here/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /1 built-in commands not listed/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /Turned-off plugins not listed: ecc \(2\)/ })).toBeDefined()
      await pane.unmount()
    }
    expect(seen.prompts.filter(p => p.startsWith('Sort'))).toHaveLength(1)

    // Close and open again: everything is in the store, so no new model call.
    await band.press({ key: 'book' })
    await band.press({ key: 'book' })
    expect(seen.prompts.filter(p => p.startsWith('Sort'))).toHaveLength(1)
    await band.unmount()
  })

  test('clicking a skill types it into the prompt box, keeping the draft', async ($, on) => {
    world(on, goodModel)
    let draft = 'plan the VPC change'
    on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
    on('prompt.fill', ($, e) => {
      draft = e.text
      return { isFilled: true }
    })
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    await band.press({ key: 'book' })
    const pane = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...PANE } as never)
    await pane.press({ key: 'skill:terraform-skill' })
    expect(draft).toBe('/terraform-skill plan the VPC change')
    await pane.unmount()
    await band.unmount()
  })

  test('when the model fails, skills show under Unsorted with a warning', async ($, on) => {
    world(on, () => ({ fail: true }))
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    await band.press({ key: 'book' })
    const pane = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...PANE } as never)
    expect((await pane.find({ type: 'Text', text: /Sorting stopped/ }))?.text)
      .toBe('Sorting stopped (api-error); the rest stay under Unsorted.')
    expect((await pane.find({ type: 'Text', text: /^■ Unsorted/ }))?.text).toBe('■ Unsorted  5')
    await pane.unmount()
    await band.unmount()
  })

  test('suggestions use the folder and recent prompts, and drop invented skills', async ($, on) => {
    const seen = world(on, goodModel)
    await $.session.start(start)
    await $.prompt.submit({ text: 'plan the VPC change' } as never).catch(() => undefined)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    await band.press({ key: 'book' })
    const pane = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...PANE } as never)
    await pane.press({ key: 'suggest' })

    const asked = seen.prompts.find(p => p.includes('pick the 3 to 5')) ?? ''
    expect(asked).toContain(`Working folder: ${HOME}/Claude-test/infra`)
    expect(asked).toContain('- plan the VPC change')
    expect((await pane.find({ type: 'Text', text: /★/ }))?.text).toBe('★ /terraform-skill')
    expect(await pane.find({ type: 'Text', text: /ghost/ })).toBeUndefined()
    await pane.unmount()
    await band.unmount()
  })

  test('an unreadable sort reply stops visibly, stores nothing, and is tried again', async ($, on) => {
    const seen = world(on, prompt => (prompt.startsWith('Sort') ? { text: 'Sorry, I cannot do that.' } : { text: '[]' }))
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    await band.press({ key: 'book' })
    const pane = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...PANE } as never)
    expect((await pane.find({ type: 'Text', text: /Sorting stopped/ }))?.text)
      .toBe("Sorting stopped (the model's reply could not be read); the rest stay under Unsorted.")
    expect((await pane.find({ type: 'Text', text: /^■ Unsorted/ }))?.text).toBe('■ Unsorted  5')
    await pane.unmount()
    await band.press({ key: 'book' })
    await band.press({ key: 'book' })
    expect(seen.prompts.filter(p => p.startsWith('Sort'))).toHaveLength(2)
    await band.unmount()
  })

  test('a suggestion call the engine refuses shows the error instead of sticking', async ($, on) => {
    world(on, prompt => (prompt.startsWith('Sort') ? { text: JSON.stringify(SORTED) } : { refuse: true }))
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    await band.press({ key: 'book' })
    const pane = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...PANE } as never)
    await pane.press({ key: 'suggest' })
    expect((await pane.find({ type: 'Text', text: /^No suggestions/ }))?.text).toMatch(/blocked model/)
    expect((await pane.find({ key: 'suggest' }))?.props.label).toBe('Suggest again')
    await pane.unmount()
    await band.unmount()
  })

  test("a failed command list is shown and spends no model call", async ($, on) => {
    const seen = world(on, goodModel, { listFails: true })
    await $.session.start(start)
    const band = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...BAND } as never)
    await band.press({ key: 'book' })
    const pane = await $.ui.mount({ plugin: 'skill-map', surface: 'desktop', ...PANE } as never)
    expect(await pane.find({ type: 'Text', text: /command list could not be read/ })).toBeDefined()
    expect(seen.prompts).toHaveLength(0)
    await pane.unmount()
    await band.unmount()
  })
})
