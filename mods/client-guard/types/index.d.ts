// The values client-guard keeps in the session's state ($.state), so the
// band above the prompt redraws whenever they change.

// The AWS profile and region the session's most recent `aws` call used.
export type AwsContext = {
  profile?: string
  region?: string
}

declare module 'claude-code' {
  interface PluginState {
    'client-guard': { lastAws: AwsContext | null }
  }
}
