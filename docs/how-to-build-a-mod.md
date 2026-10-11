# How to build a Claude Code mod

A walkthrough of how the two mods in this repo were built: the model behind mods, the build
and test loop, and the mistakes made along the way. Written against Claude Code 2.1.295; the API
is early access, so check the type file your build writes (below) when something doesn't match.

## 1. What a mod is, and when to reach for one

A **mod** is a plugin whose behaviour is code: a hooks module that Claude Code calls at defined
points (a tool call, a permission decision, a message being stored, the UI being drawn).

Use a mod when a rule must *hold*, not just be suggested:

| Mechanism | What it is | Holds under a long session? |
| --- | --- | --- |
| `CLAUDE.md` | Instructions the model reads | No: advice, and it can be lost or outweighed |
| Memory | Notes the model recalls | No: same |
| Mod | Code the engine runs on every matching event | Yes |

`client-guard` exists because CLAUDE.md said "always pass `--region`" and "don't edit my
CLAUDE.md", and transcripts showed both rules being broken hundreds of times.

## 2. The three files

```
my-mod/
├── .claude-plugin/plugin.json   name, version, description, settings (userConfig)
├── hooks/hooks.json             { "modules": ["./register.tsx"] }
└── hooks/register.tsx           export const register: Register = (on, options) => { ... }
```

A mod that keeps values in session state adds `types/index.d.ts` (its *state contract*) and
names it in `plugin.json` as `"types": "./types/index.d.ts"`.

## 3. The one idea: `($, e, next)`

Every hook has the same shape:

```ts
on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
  if (isProtected(e.file_path)) return { deny: 'protected' }   // answer yourself
  return next(e)                                                // or carry on
})
```

- **`e`**: the event's input (here: the Edit's `file_path`, `old_string`, ...).
- **`next(e)`**: "carry on to everything beneath me" (other plugins, then Claude Code's own
  behaviour). It resolves to the event's result.
- **Return without calling `next`** to answer for yourself, e.g. refuse the call.
- **`$`**: everything outside your module: files (`$.fs`), the clock, state, UI, processes.
  The module runs in a sandbox with no Node and no DOM; `$` is the only way out.

## 4. Picking the event

| You want to... | Event | Used in |
| --- | --- | --- |
| Refuse or rewrite a tool call | `tool.call` | CLAUDE.md rule |
| Decide whether a call is *permitted* (allow / ask / deny) | `tool.check` | AWS rules |
| React to every message stored in the chat | `session.append` | chat-timestamps |
| Draw something | `ui.render` with `{ component: ... }` | context bar, timestamps |
| Add a slash command | `$.command.register` + `command.run` | `/claude-md-proposals` |
| Run setup once per load | `session.start` | time zone lookup |

**`tool.call` vs `tool.check`.** `tool.call` wraps the call itself: you can refuse it, rewrite its
input, or look at its result. `tool.check` is only the permission decision. Its `next(e)` resolves
to what Claude Code would decide (your settings rules, the permission mode) and runs nothing.
The AWS guard sits on `tool.check` so that, once you approve, it can answer `allow` and you
don't get a second permission prompt.

## 5. Pattern: a guard that asks a human

```ts
const checkAws: Hook<'tool.check'> = async ($, e, next) => {
  const plan = await planFor($, commandOf(e.input))
  if (plan.kind === 'pass') return next(e)
  const verdict = await next(e)                 // your settings rules first
  if (verdict.decision === 'deny') return verdict
  const answer = await $.ui.ask(plan.question, { options: ['Allow once', 'Deny'] })
    .catch(() => undefined)                     // dismissed = no
  return answer === 'Allow once'
    ? { decision: 'allow' }
    : { decision: 'deny', reason: 'The user did not approve. Give them the command to run.' }
}
```

Why `$.ui.ask` instead of returning `{ decision: 'ask' }`: a plain `ask` goes to whatever
decides for the current permission mode, and in auto mode that can be the auto-mode classifier.
`$.ui.ask` always reaches a person.

The `reason` on a deny is **read by the model**. Write it as an instruction ("re-run with
`--region ap-northeast-1`") and Claude fixes the call itself.

### Fail closed, narrowly

If a hook throws, Claude Code skips it and the call goes on: a broken guard is an open guard.
A `.catch` handler answers in the hook's place:

```ts
on('tool.check', { tool: 'Bash' }, checkAws).catch(($, e, next) =>
  looksLikeAws(e.input) ? { decision: 'deny', reason: 'guard failed' } : next(e))
```

Refusing *everything* on failure would mean one bug blocks all shell use, so the handler
refuses only what the guard was protecting.

## 6. Keep the logic pure

`client-guard` splits into:

- `aws.ts`, `claudemd.ts`: plain functions on strings (parse `aws` calls, classify read vs
  write, build a proposal entry). No `$`, so they unit-test trivially.
- `register.tsx`: wiring only (which event calls which function).

Most bugs live in the pure part. One example: splitting a command on `|` broke
`--query "Reservations[] | [0]"`, so the splitter only splits *outside* quotes, and a test pins it.

## 7. State and drawing

Values a drawing reads live in `$.state`, declared in the contract:

```ts
// types/index.d.ts
export type SentAt = number | null
declare module 'claude-code' {
  interface PluginState {
    'chat-timestamps': { sentAt: StateFamily<SentAt> }
  }
}
```

```ts
const sentAt = atom({ plugin: 'chat-timestamps', key: 'sentAt' } as const, null as SentAt)
await update($, memberOf(sentAt, { requestId: rowId }), () => now)   // write (not while drawing)
const at = await read($, memberOf(sentAt, { requestId: e.requestId }))  // read (while drawing)
```

- A **render hook never writes** state. Write from another event (`session.append` here).
- Reading while drawing *subscribes* that drawing: a later write redraws exactly its readers.
- A **family** (`StateFamily`) holds one value per id. One big map would redraw every message
  each time any message is recorded; a family redraws one.
- To decorate the engine's own drawing, wrap it: `const drawn = await next(e)`, then return
  `<Box flexDirection="column">{drawn}<Text dimColor>14:32</Text></Box>`.
- Elements come from the surface: `const { Box, Text } = $.ui.resolve(e)`.
- For colours, use the theme keys (`'warning'`, `'success'`, `'subtle'`) so it reads in light and dark.

## 8. The build loop

1. **Write** the mod in the session's mods folder (the `plugin-authoring` skill names it). The
   first write makes Claude Code ask *"Enable hot reloading for this session?"*. Say yes, and
   every later edit reloads when the turn ends.
2. **Validate**: `claude plugin validate <folder>` reads the module the way the engine will and
   lists what it hooks, what it calls, and what the engine would refuse.
3. **Type-check** with `tsc`, using the tsconfig from the header of the type file Claude Code
   writes (`.claude-plugin/types/claude-code/index.d.ts` once the mod has loaded).
4. **Test**: `claude plugin test <folder>` runs `tests/*.test.ts(x)` against the real engine.
   Everything beneath your hooks is the test's to answer:
   ```ts
   on('session.cwd', () => ({ value: '/home/me/Documents/Acme/12345-x' }))
   on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
   on('tool.check', () => ({ decision: 'allow' }))   // the engine's verdict beneath you
   ```
5. **Try it live** in the session, then copy it to a repo to share.

## 9. Mistakes made building these (so you don't)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Validator: *"the hook is not a function declared at the top of this file"* | Hook defined inside `register` and passed by name | Declare hooks at the top level; `register` only wires them. Settings reach them through a module variable set in `register`. |
| Type error on `$.process.run({ argv: [...] })` | Prose suggested an object | It's `$.process.run(['date', '+%z'])`. **The type file is the authority, not the prose.** |
| Validator: *"sentAt is not declared"* although it was | Contract file had only `export {}` | Export at least one real type from the contract file. |
| Test: *"returned something that is not a result object"* | Mocked `$` call returned a bare value | Mocks answer `{ value }` or `{ deny }`. |
| Test: *"no implementation for session.append"* | This build's kit has no store beneath appends raised by a test (and `mock.session` is declared but missing) | Move the decision into a pure function (`isChatRow`), unit-test that, and verify the drawing live. |
| Timestamps in UTC | The hooks sandbox has no time zone | Ask the host once: `$.process.run(['date', '+%z'])`. |

A second reviewer (a separate agent asked only to break the guard) then found four more, all
fixed with a test each:

| Bug | Concrete input | Fix |
| --- | --- | --- |
| Upload passed as a read | `aws s3 cp ./f s3://b/k --region eu-west-2`: "last word" was the region | Source and destination are the two words right after the operation |
| Nested command not seen | `bash -c "aws iam delete-user ..."` | Also parse quoted strings that contain `aws ` |
| False alarms | Bash's `description` ("read the aws hook") was parsed as a command; `grep -rn "aws" .` looked like a call | Read only `command`; only the *command word* can be the aws binary |
| Rule silently off for others | The MCP tool name includes the user's own server key | Match the `__call_aws` suffix |

The lesson: tests you write yourself check the cases you thought of. Ask someone (or something)
to attack the rule.

## 10. Sharing

A repo becomes a marketplace with `.claude-plugin/marketplace.json`:

```json
{
  "name": "jay-claude-mod",
  "owner": { "name": "jaycp30" },
  "plugins": [{ "name": "client-guard", "source": "./mods/client-guard" }]
}
```

Others install with `/plugin install client-guard --marketplace jaycp30/jay-claude-mod`. Before
publishing, keep `.claude-plugin/types/` out of git (it's generated, and it lists your connected
MCP tools), and grep the tests for real client names, account IDs and profile names. Test fixtures
are where those leak.
