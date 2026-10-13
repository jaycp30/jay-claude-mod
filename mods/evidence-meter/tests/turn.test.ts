// Integration: the real hooks, run by the engine, through a whole turn.
import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const ANSWER = 'x'.repeat(400)

// The engine beneath the plugin: a turn id, tools that succeed (or fail when
// asked), and a finished turn whose text is the answer itself.
function world(on: On, failing: string[] = []) {
  on('turn.start', () => ({ turnId: 't1' }))
  on('tool.call', ($, e) => (failing.includes(e.tool)
    ? { result: 'boom' as never, isError: true }
    : { result: 'ok' as never }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
}

const complete = (extra: Record<string, unknown> = {}) => ({
  answer: ANSWER, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' as const, ...extra,
})

test('a turn that read and tested ends with a tick line', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'why is it slow?', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const done = await $.turn.complete(complete())
  expect(done.text).toBe('✓ 1 read · 1 check passed')
})

test('a failing tool turns the line into a warning', async ($, on) => {
  world(on, ['Bash'])
  await $.turn.start({ text: 'q', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect((await $.turn.complete(complete())).text).toBe('⚠ 1 check FAILED')
})

test('a new turn starts from zero', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'q1', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' })
  await $.turn.complete(complete())
  await $.turn.start({ text: 'q2', turnId: 't1' })
  expect((await $.turn.complete(complete())).text).toBe('⚠ unchecked: answered without reading or running anything')
})

test('subagent turns and interrupted turns are left alone', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'q', turnId: 't1' })
  expect((await $.turn.complete(complete({ agentId: 'a1' }))).text).toBe(ANSWER)
  expect((await $.turn.complete(complete({ reason: 'aborted', isAborted: true }))).text).toBe(ANSWER)
})
