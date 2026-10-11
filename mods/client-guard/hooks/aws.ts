// Pure parsing of shell commands into AWS CLI calls, and the read/write call
// on each one. No `$` here, so every rule can be unit-tested on plain strings.

export type AwsCall = {
  service: string
  operation: string
  profile?: string
  region?: string
  // The shell segment the call came from, for messages.
  text: string
  isWrite: boolean
}

// Global options that take a value. Needed to find the service name in
// `aws --profile x --region y ec2 describe-instances`: without this list the
// walker would think `x` is the service.
const VALUE_OPTIONS = new Set([
  '--profile', '--region', '--output', '--endpoint-url', '--query', '--color',
  '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout',
  '--cli-binary-format',
])

// Operation-name prefixes that only read. Anything not matched here counts as
// a write, so a new or unknown verb fails safe (it asks instead of slipping by).
const READ_PREFIXES = [
  'describe', 'get', 'list', 'head', 'lookup', 'search', 'scan', 'query',
  'filter', 'tail', 'batch-get', 'validate', 'estimate', 'simulate',
  'preview', 'select', 'wait', 'ls', 'presign', 'decode', 'help',
]

// Whole `service operation` pairs that read despite their verb.
const READ_EXCEPTIONS = new Set([
  'logs start-query', 'logs stop-query',
  'sts assume-role', 'sts assume-role-with-web-identity',
  'sso login', 'sso logout',
])

// Services whose whole surface is local or account-global, so they never need
// --region: `configure` edits ~/.aws, the rest are global services.
export const REGIONLESS_SERVICES = new Set([
  'configure', 'help', 'iam', 'sts', 'organizations', 'route53',
  'route53domains', 'cloudfront', 'sso',
])

// Identity Center services: these belong in the SSO region, not the default.
export const SSO_SERVICES = new Set(['sso-admin', 'identitystore', 'sso-oidc'])

type Token = { text: string; isQuoted: boolean }

// Splits a command line into tokens, keeping quoted strings together and
// remembering which were quoted: a quoted "aws" is an argument (grep "aws"),
// never the aws binary. Deliberately small: it is not a shell parser, just
// enough to read `aws <options> <service> <operation> <args>` out of typical
// commands.
function tokenize(segment: string): Token[] {
  const tokens: Token[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of segment.matchAll(pattern)) {
    const quoted = match[1] ?? match[2]
    tokens.push(quoted !== undefined ? { text: quoted, isQuoted: true } : { text: match[3] ?? '', isQuoted: false })
  }
  return tokens
}

// Commands that run the command after them: `sudo aws ...`, `xargs aws ...`.
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'command', 'exec', 'xargs', 'timeout'])
// Wrapper flags that take a value (`xargs -I {}`, `xargs -n 1`).
const WRAPPER_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-u', '-s', '-k'])

// Where the command word is: past leading VAR=value assignments, wrappers and
// their flags, and `timeout`'s duration. Only a token in that position is the
// aws binary, so `grep -rn aws .` or `ls ~/.aws` is never mistaken for a call.
function commandIndex(tokens: Token[]): number {
  let i = 0
  let lastWrapper: string | undefined
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token || token.isQuoted) return i
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) { i++; continue }
    if (WRAPPERS.has(token.text)) { lastWrapper = token.text; i++; continue }
    if (lastWrapper && token.text.startsWith('-')) {
      i += WRAPPER_VALUE_FLAGS.has(token.text) ? 2 : 1
      continue
    }
    if (lastWrapper === 'timeout' && /^\d/.test(token.text)) { i++; continue }
    return i
  }
  return i
}

// Splits a command line into the commands it runs. A new command starts after
// `;`, `&&`, `||`, `|`, a newline, `$(` or a backtick -- but only outside
// quotes, because JMESPath queries use `|` too: `--query "Reservations[] | [0]"`
// must stay one command or a `--region` after it would be lost. `$(` still
// splits inside double quotes, where the shell runs it.
function splitCommands(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    const next = command[i + 1] ?? ''
    if (quote) {
      if (char === quote) quote = undefined
      if (quote === '"' && char === '$' && next === '(') {
        segments.push(current)
        current = ''
        i++
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const isDouble = (char === '&' && next === '&') || (char === '|' && next === '|')
      || (char === '$' && next === '(')
    if (isDouble || char === ';' || char === '|' || char === '\n' || char === '`') {
      segments.push(current)
      current = ''
      if (isDouble) i++
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

function isReadOperation(service: string, operation: string, tokens: string[]): boolean {
  if (tokens.includes('--dry-run')) return true
  if (READ_EXCEPTIONS.has(`${service} ${operation}`)) return true
  // `aws s3 cp s3://bucket/key ./local` downloads: a read of the client
  // account. Source and destination are the two words right after the
  // operation; anything else (an option first, an S3 destination) counts as a
  // write. Not "the last word": that is often an option value like the region.
  if (service === 's3' && (operation === 'cp' || operation === 'sync')) {
    const [source = '', destination = ''] = tokens
    const isPlain = !source.startsWith('-') && destination !== '' && !destination.startsWith('-')
    return isPlain && source.startsWith('s3://') && !destination.startsWith('s3://')
  }
  return READ_PREFIXES.some(p => operation === p || operation.startsWith(`${p}-`))
}

// Reads `VAR=value` assignments that prefix a command, e.g.
// `AWS_PROFILE=x AWS_REGION=y aws ...` or `sudo env AWS_PROFILE=x aws ...`.
function leadingAssignments(tokens: string[], name: string): string | undefined {
  for (const token of tokens) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(token)
    if (match?.[1] === name) return match[2]
  }
  return undefined
}

// Finds every `aws ...` call in a command. Commands that export AWS_PROFILE /
// AWS_REGION earlier in the same line are honoured for the calls after them.
export function parseAwsCalls(command: string): AwsCall[] {
  const calls: AwsCall[] = []
  let exportedProfile: string | undefined
  let exportedRegion: string | undefined

  for (const segment of splitCommands(command)) {
    // Drop subshell / group openers so `(aws ...)` and `{ aws ...; }` parse.
    const tokens = tokenize(segment.trim().replace(/^[({\s]+/, ''))

    // `export AWS_PROFILE=x` (or a bare assignment) carries forward.
    for (const token of tokens) {
      const match = /^(AWS_PROFILE|AWS_REGION|AWS_DEFAULT_REGION)=(\S+)$/.exec(token.text)
      if (match?.[1] === 'AWS_PROFILE') exportedProfile = match[2]
      else if (match) exportedRegion = match[2]
    }

    // A command handed to another shell as a string (`bash -c "aws ..."`,
    // `ssh host 'aws ...'`) is parsed too. This only ever adds calls, so it
    // errs towards asking.
    for (const token of tokens) {
      if (token.isQuoted && /(^|[\s;&|(])aws\s/.test(token.text)) calls.push(...parseAwsCalls(token.text))
    }

    // The aws binary must be the command word; it may be spelled as a path.
    const awsIndex = commandIndex(tokens)
    const binary = tokens[awsIndex]
    if (!binary || binary.isQuoted || !(binary.text === 'aws' || binary.text.endsWith('/aws'))) continue
    const before = tokens.slice(0, awsIndex).map(t => t.text)
    const rest = tokens.slice(awsIndex + 1).map(t => t.text)

    let profile = leadingAssignments(before, 'AWS_PROFILE') ?? exportedProfile
    let region = leadingAssignments(before, 'AWS_REGION')
      ?? leadingAssignments(before, 'AWS_DEFAULT_REGION') ?? exportedRegion

    // Walk global options until the first bare word: that is the service.
    let index = 0
    while (index < rest.length && (rest[index] ?? '').startsWith('--')) {
      const [flag, inlineValue] = (rest[index] ?? '').split('=', 2)
      const takesValue = VALUE_OPTIONS.has(flag ?? '')
      const value = inlineValue ?? (takesValue ? rest[index + 1] : undefined)
      if (flag === '--profile') profile = value
      if (flag === '--region') region = value
      index += takesValue && inlineValue === undefined ? 2 : 1
    }
    const service = rest[index] ?? ''
    const operation = rest[index + 1] ?? ''
    if (!service) continue

    // Options after the operation: --profile / --region can appear anywhere.
    const tail = rest.slice(index + 2)
    tail.forEach((token, i) => {
      const [flag, inlineValue] = token.split('=', 2)
      const value = inlineValue ?? tail[i + 1]
      if (flag === '--profile') profile = value
      if (flag === '--region') region = value
    })

    // A service or operation held in a shell variable ($svc) can't be judged,
    // so it is treated as a write: unknown means ask.
    const isKnown = /^[a-z0-9-]+$/.test(service) && /^[a-z0-9-]*$/.test(operation)
    calls.push({
      service,
      operation,
      profile,
      region,
      text: segment.trim(),
      isWrite: !isKnown || !isReadOperation(service, operation, tail),
    })
  }
  return calls
}

// The fix to suggest for a personal-project call with no region, or undefined
// when the call is fine as it is.
export function missingRegionHint(
  call: AwsCall,
  sideRegion: string,
  ssoRegion: string,
): string | undefined {
  if (call.region) return undefined
  if (REGIONLESS_SERVICES.has(call.service)) return undefined
  // `aws s3 ls` lists every bucket regardless of region; other s3 verbs
  // (mb creates a bucket!) do depend on it.
  if (call.service === 's3' && call.operation === 'ls') return undefined
  const region = SSO_SERVICES.has(call.service) ? ssoRegion : sideRegion
  return `--region ${region}`
}

// True when `path` is `root` or inside it. Both must already be absolute.
export function isUnder(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, '')
  return path === base || path.startsWith(`${base}/`)
}

// For <workRoot>/<Client>/<ticket-folder>/..., returns the client name and the
// ticket number when the folder starts with digits (e.g. "12345-vpn-fix").
export function clientContext(cwd: string, workRoot: string): { client?: string; ticket?: string } {
  if (!isUnder(cwd, workRoot)) return {}
  const parts = cwd.slice(workRoot.replace(/\/+$/, '').length).split('/').filter(Boolean)
  const ticket = /^(\d{4,})/.exec(parts[1] ?? '')?.[1]
  return { client: parts[0], ticket }
}

// A profile is "risky" when it can write (no -ro suffix) or points at prod.
export function isRiskyProfile(profile: string | undefined): boolean {
  if (!profile) return false
  return !/-ro$/.test(profile) || /(^|[-_])(prd|prod)([-_]|$)/.test(profile)
}
