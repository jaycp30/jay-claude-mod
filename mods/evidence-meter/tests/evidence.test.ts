import { describe, expect, test } from 'claude-code/testing'

import { classify, summarize } from '../hooks/evidence'
import type { Call } from '../hooks/evidence'

const LONG = 'x'.repeat(400)
const call = (tool: string, input: Record<string, unknown> = {}, failed = false): Call =>
  ({ ...classify(tool, input), failed })

describe('classify', () => {
  test('sorts tools into kinds', () => {
    expect(classify('Read', {}).kind).toBe('read')
    expect(classify('Grep', {}).kind).toBe('read')
    expect(classify('WebFetch', {}).kind).toBe('web')
    expect(classify('Agent', {}).kind).toBe('agent')
    expect(classify('AskUserQuestion', {}).kind).toBe('other')
    expect(classify('Edit', { file_path: '/a.ts' })).toEqual({ kind: 'edit', file: '/a.ts' })
  })

  test('test runners and validators are checks, other shell is a command', () => {
    expect(classify('Bash', { command: 'npm test' }).kind).toBe('check')
    expect(classify('Bash', { command: 'cd app && npm run test -- --watch=false' }).kind).toBe('check')
    expect(classify('Bash', { command: 'claude plugin test ./mods/x' }).kind).toBe('check')
    expect(classify('Bash', { command: 'terraform plan -out tf.plan' }).kind).toBe('check')
    expect(classify('Bash', { command: 'ls -la' }).kind).toBe('command')
    expect(classify('Bash', { command: 'cat attest.md' }).kind).toBe('command')
  })

  test('MCP browsers are web, other MCP tools query live systems', () => {
    expect(classify('mcp__Claude_Browser__get_page_text', {}).kind).toBe('web')
    expect(classify('mcp__my-aws__call_aws', {}).kind).toBe('command')
  })
})

describe('summarize', () => {
  test('no tools: neutral for small talk, a warning for a real answer', () => {
    expect(summarize([], 'C.')).toBe('○ no tools used')
    expect(summarize([], LONG)).toBe('⚠ unchecked: answered without reading or running anything')
  })

  test('reads and passing checks are a tick', () => {
    const line = summarize([call('Read'), call('Read'), call('Bash', { command: 'pytest' })], LONG)
    expect(line).toBe('✓ 2 reads · 1 check passed')
  })

  test('a failing check or tool is a warning', () => {
    expect(summarize([call('Bash', { command: 'npm test' }, true)], LONG)).toBe('⚠ 1 check FAILED')
    expect(summarize([call('Read'), call('Bash', { command: 'ls nope' }, true)], LONG))
      .toBe('⚠ 1 read · 1 command · 1 failed')
  })

  test('changes with nothing run afterwards are flagged', () => {
    const edits = [call('Read'), call('Edit', { file_path: '/a' }), call('Edit', { file_path: '/a' })]
    expect(summarize(edits, LONG)).toBe('⚠ 1 read · changed 1 file · nothing run after the last change')
    const tested = [...edits, call('Bash', { command: 'npm test' })]
    expect(summarize(tested, LONG)).toBe('✓ 1 read · 1 check passed · changed 1 file')
  })

  test('a run before the change does not verify it', () => {
    const order = [call('Bash', { command: 'npm test' }), call('Write', { file_path: '/b' })]
    expect(summarize(order, LONG)).toContain('nothing run after the last change')
  })
})
