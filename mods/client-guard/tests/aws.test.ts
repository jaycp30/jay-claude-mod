// Unit tests for the pure parsing in hooks/aws.ts and hooks/claudemd.ts.
import { describe, expect, test } from 'claude-code/testing'

import {
  clientContext, isRiskyProfile, missingRegionHint, parseAwsCalls,
} from '../hooks/aws'
import { bashWritesClaudeMd, isClaudeMd, pendingHeadings } from '../hooks/claudemd'

describe('parseAwsCalls', () => {
  test('reads service, operation, profile and region', () => {
    const [call] = parseAwsCalls('aws --profile acme-ro ec2 describe-instances --region eu-west-2')
    expect(call?.service).toBe('ec2')
    expect(call?.operation).toBe('describe-instances')
    expect(call?.profile).toBe('acme-ro')
    expect(call?.region).toBe('eu-west-2')
    expect(call?.isWrite).toBe(false)
  })

  test('flags writes, including ssm send-command', () => {
    expect(parseAwsCalls('aws ssm send-command --document-name X')[0]?.isWrite).toBe(true)
    expect(parseAwsCalls('aws iam delete-user --user-name bob')[0]?.isWrite).toBe(true)
    expect(parseAwsCalls('aws ssm start-session --target i-1')[0]?.isWrite).toBe(true)
  })

  test('a pipe inside a --query is not a command boundary', () => {
    const [call] = parseAwsCalls('aws ec2 describe-instances --query "Reservations[] | [0]" --region eu-west-1')
    expect(call?.region).toBe('eu-west-1')
  })

  test('finds every call in a chained command', () => {
    const calls = parseAwsCalls('aws sts get-caller-identity && aws s3 rb s3://old --force; echo done')
    expect(calls.map(c => `${c.service} ${c.operation} ${c.isWrite}`))
      .toEqual(['sts get-caller-identity false', 's3 rb true'])
  })

  test('finds calls inside $( ) and honours env prefixes and exports', () => {
    const [inner] = parseAwsCalls('ID=$(AWS_PROFILE=acme aws ec2 run-instances --count 1)')
    expect(inner?.profile).toBe('acme')
    expect(inner?.isWrite).toBe(true)
    const [later] = parseAwsCalls('export AWS_REGION=ap-northeast-1; aws lambda list-functions')
    expect(later?.region).toBe('ap-northeast-1')
  })

  test('s3 cp is a read when it downloads, a write when it uploads', () => {
    expect(parseAwsCalls('aws s3 cp s3://b/k ./k')[0]?.isWrite).toBe(false)
    expect(parseAwsCalls('aws s3 cp ./k s3://b/k')[0]?.isWrite).toBe(true)
  })

  test('--dry-run and read exceptions count as reads', () => {
    expect(parseAwsCalls('aws ec2 run-instances --dry-run')[0]?.isWrite).toBe(false)
    expect(parseAwsCalls('aws logs start-query --log-group-name g')[0]?.isWrite).toBe(false)
  })

  test('an operation held in a variable is treated as a write', () => {
    expect(parseAwsCalls('aws ec2 $op --instance-ids i-1')[0]?.isWrite).toBe(true)
  })

  test('ignores commands that only mention aws', () => {
    expect(parseAwsCalls('ls ~/.aws')).toEqual([])
    expect(parseAwsCalls('grep -rn "aws" .')).toEqual([])
    expect(parseAwsCalls('grep -rn aws hooks/')).toEqual([])
  })

  test('an s3 upload with options last is still a write', () => {
    // The last word is the region here, not the destination.
    expect(parseAwsCalls('aws s3 cp ./f s3://b/k --profile acme --region eu-west-2')[0]?.isWrite).toBe(true)
    expect(parseAwsCalls('aws s3 sync s3://b/ ./local --region eu-west-2')[0]?.isWrite).toBe(false)
    expect(parseAwsCalls('aws s3 cp s3://a/k s3://b/k')[0]?.isWrite).toBe(true)
  })

  test('commands handed to another shell are parsed', () => {
    expect(parseAwsCalls('bash -c "aws iam delete-user --user-name bob"')[0]?.isWrite).toBe(true)
    expect(parseAwsCalls("ssh bastion 'aws s3 rm s3://b/k'")[0]?.operation).toBe('rm')
  })

  test('wrappers before aws are skipped', () => {
    expect(parseAwsCalls('sudo env AWS_PROFILE=acme aws ec2 terminate-instances --instance-ids i-1')[0]?.profile).toBe('acme')
    expect(parseAwsCalls('cat ids | xargs -I {} aws ec2 stop-instances --instance-ids {}')[0]?.operation).toBe('stop-instances')
    expect(parseAwsCalls('timeout 30 aws sts get-caller-identity')[0]?.service).toBe('sts')
  })
})

describe('missingRegionHint', () => {
  const hint = (cmd: string) => {
    const [call] = parseAwsCalls(cmd)
    return call ? missingRegionHint(call, 'ap-northeast-1', 'ap-southeast-1') : 'no call'
  }
  test('suggests the personal region for regional services', () => {
    expect(hint('aws lambda list-functions')).toBe('--region ap-northeast-1')
    expect(hint('aws s3 mb s3://new-bucket')).toBe('--region ap-northeast-1')
  })
  test('suggests the SSO region for Identity Center', () => {
    expect(hint('aws sso-admin list-instances')).toBe('--region ap-southeast-1')
  })
  test('passes global services, s3 ls and calls that set a region', () => {
    expect(hint('aws iam list-roles')).toBeUndefined()
    expect(hint('aws s3 ls')).toBeUndefined()
    expect(hint('AWS_REGION=us-east-1 aws bedrock list-foundation-models')).toBeUndefined()
  })
})

describe('context helpers', () => {
  test('clientContext reads client and ticket from the folder', () => {
    expect(clientContext('/Users/j/Documents/Acme/12345-vpn-fix/sub', '/Users/j/Documents'))
      .toEqual({ client: 'Acme', ticket: '12345' })
    expect(clientContext('/Users/j/Documents/Acme/shared', '/Users/j/Documents'))
      .toEqual({ client: 'Acme', ticket: undefined })
    expect(clientContext('/Users/j/Claude-test', '/Users/j/Documents')).toEqual({})
  })
  test('isRiskyProfile: write-capable or prod', () => {
    expect(isRiskyProfile('acme-ro')).toBe(false)
    expect(isRiskyProfile('acme')).toBe(true)
    expect(isRiskyProfile('acme-prd-app-ro')).toBe(true)
  })
})

describe('CLAUDE.md helpers', () => {
  test('isClaudeMd matches CLAUDE.md and CLAUDE.local.md only', () => {
    expect(isClaudeMd('/Users/j/.claude/CLAUDE.md')).toBe(true)
    expect(isClaudeMd('proj/CLAUDE.local.md')).toBe(true)
    expect(isClaudeMd('/notes/claude-md-proposals.md')).toBe(false)
  })
  test('bashWritesClaudeMd catches writes, not reads', () => {
    expect(bashWritesClaudeMd('echo "- rule" >> ~/.claude/CLAUDE.md')).toBe(true)
    expect(bashWritesClaudeMd("sed -i '' 's/a/b/' CLAUDE.md")).toBe(true)
    expect(bashWritesClaudeMd('cat ~/.claude/CLAUDE.md | head')).toBe(false)
    expect(bashWritesClaudeMd('grep -n region CLAUDE.md')).toBe(false)
    expect(bashWritesClaudeMd('ls CLAUDE.md 2>/dev/null')).toBe(false)
    expect(bashWritesClaudeMd('cp CLAUDE.md /tmp/backup.md')).toBe(false)
    expect(bashWritesClaudeMd('cp /tmp/new.md ./CLAUDE.md')).toBe(true)
    expect(bashWritesClaudeMd('echo x | tee -a ~/.claude/CLAUDE.md')).toBe(true)
  })
  test('pendingHeadings lists only open proposals', () => {
    const text = '# t\n\n## 2026-10-11 09:00 · a\n- Status: #proposal/pending\n\n## 2026-10-10 · b\n- Status: #proposal/done\n'
    expect(pendingHeadings(text)).toEqual(['2026-10-11 09:00 · a'])
  })
})
