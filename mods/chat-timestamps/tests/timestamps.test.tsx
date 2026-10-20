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

  test('every label is YYYY-Mon-DD HH:MM in local time', () => {
    expect(timeLabel(AT, 60)).toBe('2026-Oct-11 16:31')
    expect(timeLabel(AT, 0)).toBe('2026-Oct-11 15:31')
  })

  test('single-digit days and hours are zero-padded', () => {
    expect(timeLabel(Date.UTC(2026, 0, 5, 7, 4), 0)).toBe('2026-Jan-05 07:04')
  })

  test('the offset decides the local date', () => {
    // 23:30 UTC on the 11th is already 08:30 on the 12th at UTC+09:00, and
    // 00:30 UTC on Jan 1st is still New Year's Eve at UTC-05:00.
    expect(timeLabel(Date.UTC(2026, 9, 11, 23, 30), 540)).toBe('2026-Oct-12 08:30')
    expect(timeLabel(Date.UTC(2027, 0, 1, 0, 30), -300)).toBe('2026-Dec-31 19:30')
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
