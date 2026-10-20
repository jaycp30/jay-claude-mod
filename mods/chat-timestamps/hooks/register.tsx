// chat-timestamps: a small time under each of your prompts and each of
// Claude's reply blocks, like a messaging app.
//
// The engine doesn't hand a message's time to the renderer, so the mod
// records it itself: `session.append` fires as each row is stored, and the
// row's time goes into `$.state` under the row's id. The render hooks look
// that id up (`e.requestId`) and wrap the engine's own drawing with the time.
// Rows stored before the mod loaded (a resumed session) have no time, and are
// drawn exactly as before.

import { atom, memberOf, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SentAt } from '../types'
import { isChatRow, parseOffset, timeLabel } from './time'

const sentAt = atom({ plugin: 'chat-timestamps', key: 'sentAt' } as const, null as SentAt)

// Set by session.start; the module's own variables reset on every reload.
let offsetMinutes = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const run = await $.process.run(['date', '+%z']).catch(() => undefined)
    offsetMinutes = parseOffset(run?.stdout ?? '') ?? 0
    return next(e)
  })

  // Record when each chat row is stored. The row itself goes on untouched.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (isChatRow(e) && stored.uuid) {
      const now = await $.clock.now()
      await update($, memberOf(sentAt, { requestId: stored.uuid }), () => now)
    }
    return stored
  }).catch(($, e, next) => next(e)) // a failed recording must never touch the row

  // User rows: time on the right, under the message.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (!e.requestId) return drawn
    const at = await read($, memberOf(sentAt, { requestId: e.requestId }))
    if (at === null) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Box justifyContent="flex-end">
          <Text dimColor>{timeLabel(at, offsetMinutes)}</Text>
        </Box>
      </Box>
    )
  })

  // Claude's reply blocks: time on the left, under the block.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (!e.requestId) return drawn
    const at = await read($, memberOf(sentAt, { requestId: e.requestId }))
    if (at === null) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Text dimColor>{timeLabel(at, offsetMinutes)}</Text>
      </Box>
    )
  })
}
