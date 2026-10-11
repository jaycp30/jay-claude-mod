// Integration tests: the real hooks, run by the engine, with the world beneath
// them (cwd, files, env, clock, the permission verdict) mocked in memory.
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const HOME = '/home/jay'
const PROPOSALS = `${HOME}/.claude/claude-md-proposals.md`

// Mocks every outside call the plugin makes and returns the fake file system.
function world(
  on: On,
  cwd: string,
  verdict: { decision: 'allow' | 'deny'; reason?: string } = { decision: 'allow' },
): Record<string, string> {
  const files: Record<string, string> = {}
  mock.env(on, { HOME })
  mock.clock(on, { now: Date.UTC(2026, 9, 11, 8, 30) })
  // A call on `$` answers `{ value }`, or `{ deny }` to make the call reject
  // (which is how a missing file looks to the plugin).
  on('session.cwd', () => ({ value: cwd }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  // The engine's own verdict beneath the plugin (allow, as a permissive mode,
  // unless the test says a settings rule denies).
  on('tool.check', () => verdict)
  return files
}

const bash = (command: string) => ({ tool: 'Bash', input: { command } })

describe('client AWS writes', () => {
  const cwd = `${HOME}/Documents/Acme/12345-vpn-fix`

  test('a write in a client folder needs the person', async ($, on) => {
    world(on, cwd)
    const verdict = await $.tool.check(bash('aws ssm send-command --profile acme --region eu-west-2 --document-name AWS-RunShellScript'))
    // A $.tool.check query opens no dialog, so the guard answers "ask".
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain('aws ssm send-command (profile acme, region eu-west-2)')
  })

  test('a read in a client folder passes untouched', async ($, on) => {
    world(on, cwd)
    const verdict = await $.tool.check(bash('aws ec2 describe-instances --profile acme-ro --region eu-west-2'))
    expect(verdict.decision).toBe('allow')
  })

  test('the AWS MCP tool is guarded the same way', async ($, on) => {
    world(on, cwd)
    const verdict = await $.tool.check({
      tool: 'mcp__AWS_API_MCP_Server__call_aws',
      input: { cli_command: 'aws iam delete-user --user-name bob' },
    })
    expect(verdict.decision).toBe('ask')
  })

  test('the AWS MCP tool is matched whatever its server is called', async ($, on) => {
    world(on, cwd)
    const verdict = await $.tool.check({
      tool: 'mcp__my-aws__call_aws',
      input: { cli_command: 'aws s3 rb s3://old --force' },
    })
    expect(verdict.decision).toBe('ask')
  })

  test("Bash's description is never read as a command", async ($, on) => {
    world(on, cwd)
    const verdict = await $.tool.check({
      tool: 'Bash',
      input: { command: 'cat hooks/aws.ts', description: 'Read the aws ssm send-command hook' },
    })
    expect(verdict.decision).toBe('allow')
  })

  test('a settings rule that denies still wins', async ($, on) => {
    world(on, cwd, { decision: 'deny', reason: 'settings rule' })
    const verdict = await $.tool.check(bash('aws ssm send-command --document-name X'))
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toBe('settings rule')
  })
})

describe('personal-project regions', () => {
  const cwd = `${HOME}/Claude-test/my-app`

  test('a regional call without --region is refused with the fix', async ($, on) => {
    world(on, cwd)
    const verdict = await $.tool.check(bash('aws lambda list-functions'))
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('add --region ap-northeast-1')
  })

  test('Identity Center calls are pointed at the SSO region', async ($, on) => {
    world(on, cwd)
    const verdict = await $.tool.check(bash('aws sso-admin list-instances'))
    expect(verdict.reason).toContain('add --region ap-southeast-1')
  })

  test('calls with a region, and global services, pass', async ($, on) => {
    world(on, cwd)
    expect((await $.tool.check(bash('aws lambda list-functions --region ap-northeast-1'))).decision).toBe('allow')
    expect((await $.tool.check(bash('aws iam list-roles'))).decision).toBe('allow')
  })
})

describe('CLAUDE.md', () => {
  test('an Edit is refused and recorded as a proposal', async ($, on) => {
    const files = world(on, `${HOME}/Claude-test`)
    const result = await $.tool.call({
      tool: 'Edit',
      file_path: `${HOME}/.claude/CLAUDE.md`,
      old_string: '- old rule',
      new_string: '- new rule',
    })
    expect(JSON.stringify(result)).toContain('hand-curated')
    const note = files[PROPOSALS] ?? ''
    expect(note).toContain('# CLAUDE.md proposals')
    expect(note).toContain('## 2026-10-11 08:30 UTC')
    expect(note).toContain('#proposal/pending')
    expect(note).toContain('- - old rule')
    expect(note).toContain('+ - new rule')
  })

  test('a second proposal is appended, not overwritten', async ($, on) => {
    const files = world(on, `${HOME}/Claude-test`)
    const edit = { tool: 'Edit' as const, file_path: 'CLAUDE.md', old_string: 'a', new_string: 'b' }
    await $.tool.call(edit)
    await $.tool.call(edit)
    expect((files[PROPOSALS] ?? '').match(/#proposal\/pending/g)?.length).toBe(2)
  })

  test('a shell write to CLAUDE.md is refused', async ($, on) => {
    world(on, `${HOME}/Claude-test`)
    const result = await $.tool.call({ tool: 'Bash', command: 'echo "- rule" >> ~/.claude/CLAUDE.md' })
    expect(JSON.stringify(result)).toContain('never edited by Claude')
  })
})
