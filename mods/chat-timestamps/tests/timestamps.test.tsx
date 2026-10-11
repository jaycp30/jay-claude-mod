import { describe, expect, test } from 'claude-code/testing'

import { isChatRow, parseOffset, timeLabel } from '../hooks/time'

// 2026-10-11 15:31 UTC, i.e. 16:31 at UTC+01:00.
const AT = Date.UTC(2026, 9, 11, 15, 31)
const USER_PROPS = { text: 'hello', origin: { kind: 'composer' }, isExpanded: true } as const

describe('time helpers', () => {
  test('parseOffset reads date +%z output', () => {
    expect(parseOffset('+0100\n')).toBe(60)
    expect(parseOffset('-0530')).toBe(-330)
    expect(parseOffset('garbage')).toBeUndefined()
  })

  test('same local day shows the time only', () => {
    expect(timeLabel(AT, AT, 60)).toBe('16:31')
  })

  test('another day shows the date too', () => {
    const nextDay = AT + 24 * 60 * 60_000
    expect(timeLabel(AT, nextDay, 60)).toBe('Oct 11 16:31')
  })

  test('the offset decides the local day', () => {
    // 23:30 UTC on the 11th is 08:30 on the 12th at UTC+09:00, while
    // 10:00 UTC on the 11th is still the 11th there (19:00).
    const late = Date.UTC(2026, 9, 11, 23, 30)
    const earlier = Date.UTC(2026, 9, 11, 10, 0)
    expect(timeLabel(late, late, 540)).toBe('08:30')
    expect(timeLabel(late, earlier, 540)).toBe('Oct 12 08:30')
  })
})

describe('which rows get a time', () => {
  test('prompts, mid-turn messages and replies of the main chat', () => {
    expect(isChatRow({ door: 'prompt' })).toBe(true)
    expect(isChatRow({ door: 'delivery' })).toBe(true)
    expect(isChatRow({ door: 'response' })).toBe(true)
  })
  test('not tool results, notices or a subagent\'s rows', () => {
    expect(isChatRow({ door: 'tool-result' })).toBe(false)
    expect(isChatRow({ door: 'notice' })).toBe(false)
    expect(isChatRow({ door: 'prompt', agentId: 'agent-1' })).toBe(false)
  })
})

// The recorded-time drawing is checked live: this build's test kit has no
// store beneath session.append for a test to fill (see docs/how-to-build-a-mod.md).
describe('drawing', () => {
  test('a message without a recorded time is drawn exactly as before', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>hello</Text>
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'chat-timestamps', surface, component: 'UserMessage', props: USER_PROPS, requestId: 'unknown',
      })
      expect(await ui.find({ type: 'Text', text: 'hello' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\d\d:\d\d/ })).toBeUndefined()
      await ui.unmount()
    }
  })
})
