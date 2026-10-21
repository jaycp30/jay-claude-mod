# jay-claude-mod

Two [Claude Code](https://code.claude.com) mods: plugins made of function hooks that change how
Claude Code itself behaves.

| Mod | What it does |
| --- | --- |
| [`client-guard`](mods/client-guard) | Asks **you** before any AWS write in a client account, makes personal-project AWS calls pass `--region`, keeps `CLAUDE.md` hand-curated, and shows the AWS context above the prompt. |
| [`chat-timestamps`](mods/chat-timestamps) | Puts a small time under each of your prompts and each of Claude's replies, like a messaging app. |
| [`evidence-meter`](mods/evidence-meter) | One line under every answer saying what Claude actually checked that turn: files read, commands and tests run, what failed. |
| [`context-meter`](mods/context-meter) | How full the context window is: a line above the prompt, and `/context-meter` for the breakdown by category. |
| [`skill-map`](mods/skill-map) | A 📕 button above the prompt opens every installed skill and slash command, grouped and coloured, with picks for this session on top. |

They grew out of months of real usage: a lot of AWS CLI work in other people's accounts, and
repeated "please don't edit my CLAUDE.md". Rules in `CLAUDE.md` are advice a long session can
lose; a mod is code that runs on every tool call.

New to mods? [docs/how-to-build-a-mod.md](docs/how-to-build-a-mod.md) walks through how these two
were built, including the mistakes.

> **Early access.** The function-hooks API these mods use may change between Claude Code
> releases. Built and tested on Claude Code 2.1.295.

## Install

At the prompt of a Claude Code **terminal** session (the desktop app's Code tab doesn't take the
command, but mods installed at the user scope load there too):

```
/plugin install client-guard --marketplace jaycp30/jay-claude-mod
```

```
/plugin install chat-timestamps --marketplace jaycp30/jay-claude-mod
```

Answer `y` to add the marketplace, then pick the user scope.

## client-guard

### Rules

1. **Client AWS writes ask you.** In a session whose folder is under *Client work folder*, any
   `aws` command that changes something (`create-*`, `delete-*`, `put-*`, `ssm send-command`, an
   `s3 cp` *to* S3, …) opens a dialog only you can answer, whatever the permission mode.
   Read-only calls pass silently. A settings rule that already denies the call still wins.
   Unknown verbs, and operations held in a shell variable, count as writes.
2. **Personal projects pass `--region`.** In a session under *Personal projects folder*, a
   regional `aws` call without `--region` (or `AWS_REGION=`) is refused with the fix, so Claude
   re-runs it instead of landing in the CLI's default region. Global services (`iam`, `sts`,
   `route53`, `cloudfront`, `organizations`) and `s3 ls` are exempt; Identity Center calls
   (`sso-admin`, `identitystore`) are pointed at the *IAM Identity Center region*.
3. **CLAUDE.md is hand-curated.** Claude's Edit/Write to any `CLAUDE.md` or `CLAUDE.local.md` is
   refused and recorded as a dated proposal (with a diff) in the *proposals file*, tagged
   `#proposal/pending`. Claude then adds a one-line "Why". `/claude-md-proposals` lists the
   open ones. Shell writes to a `CLAUDE.md` are refused too (best effort).
4. **Context bar** above the prompt: `Acme · #12345 · acme-ro · eu-west-2  read-only`, turning to
   a warning colour for a profile without `-ro` or one naming `prd`/`prod`. Client and ticket come
   from the folder layout `<Client work folder>/<Client>/<ticket-number>-<anything>`.

### Settings

Set them in `/config`, or in `~/.claude/settings.json` under `pluginConfigs`:

| Setting | Default |
| --- | --- |
| `workRoot`: client work folder | `~/Documents` |
| `sideRoot`: personal projects folder | `~/Claude-test` |
| `sideRegion`: personal default region | `ap-northeast-1` |
| `ssoRegion`: IAM Identity Center region | `ap-southeast-1` |
| `proposalsFile`: where CLAUDE.md proposals go | `~/.claude/claude-md-proposals.md` |

### Limits

Know what it does **not** see before you rely on it:

- **Only AWS CLI commands**, run through Bash (including `bash -c "..."`, `ssh host '...'`,
  `sudo`/`env`/`xargs`/`timeout` prefixes) or the AWS API MCP server (any server name ending in
  `__call_aws`). Terraform, CDK, SAM, boto3/SDK scripts and the console are not covered.
- **Scripts run silently.** If Claude writes `fix.sh` and runs `bash fix.sh`, the `aws` calls inside
  are not seen. Same for `eval` and anything built at run time.
- **Interactive sessions**: `aws ssm start-session` and `aws ecs execute-command` are asked
  about when they start, but nothing typed inside them is seen.
- **It goes by the session's folder, not the profile.** A session started outside
  *Client work folder* (say in `~`) gets no ask, even with a client profile.
- The CLAUDE.md shell check reads command *text*, so a command that merely contains a
  `tee … CLAUDE.md` string (a heredoc, test data) is refused too. The Edit/Write rule is the
  real guard; the shell check is a backstop.
- If the guard itself crashes, it refuses AWS and CLAUDE.md calls and lets everything else run.

## chat-timestamps

Records when each message of the main chat is stored and shows it under the message as
`2026-Oct-20 14:32`, in your machine's time zone.

**Limit:** messages stored before the mod loaded (a resumed session, or the start of the session
where you install it) have no time to show and are drawn as before.

## evidence-meter

Claude has no confidence score to show: the API returns no token probabilities. What *can*
be shown honestly is what the answer is grounded in. Under every answer:

| Line | Meaning |
| --- | --- |
| `✓ 3 reads · 2 commands · 1 check passed` | It looked and ran things, and nothing failed |
| `⚠ 1 check FAILED` / `⚠ … · 2 failed` | A test, type-check or validator failed, or a tool errored |
| `⚠ … · changed 2 files · nothing run after the last change` | It edited files and didn't run anything afterwards |
| `⚠ unchecked: answered without reading or running anything` | A substantial answer from memory alone |
| `○ no tools used` | A short reply (under 300 characters) with no tools: small talk |

*Checks* are test runners, type-checkers and validators (`npm test`, `pytest`, `tsc`,
`terraform plan`, `claude plugin test`, …). Only the main conversation's tools count; a
subagent counts once.

**Limits:** it measures grounding, not correctness. Reading three files doesn't mean they
were the right three. A check it doesn't recognise counts as a plain command.

Pair it with the `/how-sure` skill
([jay-claude-skill](https://github.com/jaycp30/jay-claude-skill/tree/main/general/how-sure))
when you want the claims in one answer audited one by one.

## context-meter

The same numbers `/context` shows, kept on screen.

- **Above the prompt, always:** `context 95k / 1M · 10% · compacts at 987k  █▓▓░░░░░░░░░`,
  in the warning colour once you're 80% of the way to auto-compaction.
- **`[ details ]` on the band, or `/context-meter`,** opens a pane laid out like `/context`:
  the bar full width, then each category (messages, skills, MCP tools, memory files, system
  prompt, agents, compaction buffer, free space, deferred tools) biggest first, with its
  tokens and share of the window.

It refreshes when the session starts, after every answer and after a compaction. The
breakdown is the engine's local estimate (`summary` mode): no API calls, no cost, and the
same totals `/context` shows; `/context` may count a few categories more exactly.
Colours are the theme colours `/context` assigns each category, which the desktop app's own
`/context` view draws in a different palette.

Another mod can put a button after `details` by offering one in its state (skill-map's book
does): context-meter draws it and runs its command when pressed. It reads that state only, and
draws nothing if the shape is wrong.

## skill-map

Every installed skill and slash command in one place, for when you've installed more than you
remember.

- **A book button after context-meter's `details`:** `📕` while the pane is shut, `📖` while it
  shows; clicking it toggles the pane. Without context-meter the book gets a row of its own.
  `/skill-map` opens the pane too.
- **Quick buttons after the book**, from the *Quick buttons* setting: `🧐` for `/how-sure`,
  `🙋🏻` types `/humanizer ` into the prompt box for you to finish. A `run` button tries to run
  its skill at once; Claude Code 2.1.303 doesn't let a mod run a skill, so for now it types it
  instead and you press Enter. Like the book, each press shows as a `/skill-map …` line in the
  chat.
- **The pane** lists everything under coloured groups (UI / UX design, DevOps & cloud, Code
  quality & review, Video & media, Docs & office files, Notes & Obsidian, Finance, Research &
  learning, Claude Code & mods, Other), with a filter box. It merges what the session loaded
  with what is on disk (`~/.claude/skills`, `~/.claude/commands`, enabled plugins), so a skill
  scoped to other folders still shows, marked *not active here*. A skill installed twice
  (`/minimalist-ui` and `/anthropic-skills:minimalist-ui`) says so. Built-in commands and
  turned-off plugins are counted at the bottom, not listed.
- **Click a skill** to type `/skill-name ` into the prompt box, in front of anything you had
  already typed.
- **Suggest for this session** asks the model for 3–5 skills that fit the working folder and
  your last five prompts, each with a one-line reason. Only when pressed.

### Cost

The model (Haiku by default) sorts each new or changed skill into a group once; the answer is
kept across sessions, so opening the pane again makes no call. A skill the model's reply leaves
out goes under *Other*. Each Suggest press is one more small call. Both go through the
session's own API client.

### Settings

| Setting | Default |
| --- | --- |
| Group overrides file: `{ "skill-name": "Group name" }`, wins over the model | `~/.claude/skill-map-overrides.json` |
| Model for sorting and suggestions | `haiku` |
| Quick buttons: comma-separated `label=run:skill` or `label=type:skill` | `🧐=run:how-sure, 🙋🏻=type:humanizer` |

### Limits

- The book is an emoji, not a drawn icon: in this Claude Code version a button holds text only,
  and a Markdown image inside a link draws no image on the desktop.
- Mods can't add icons to the desktop app's header, so the book lives in the band.

## Developing

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json` and a hooks module.
Load one from disk for a session, check it, and run its tests:

```bash
claude --plugin-dir ./mods/client-guard
```

```bash
claude plugin validate ./mods/client-guard
```

```bash
claude plugin test ./mods/client-guard
```

See [docs/how-to-build-a-mod.md](docs/how-to-build-a-mod.md) for the full loop.
