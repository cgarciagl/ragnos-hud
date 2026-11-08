export type Bucket = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
  usd: number
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Stats = {
  status: 'loading' | 'ready' | 'error'
  error?: string
  scannedAt: number
  skipped: number
  h5: Bucket
  session: Bucket
  sessionUsd?: number
  limits: Limit[]
  spark: number[]
  lastAt: number
  ttlMs: number
  lastCtx: number
  sessionFound: boolean
  sessionSkipped?: boolean
  hits: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'ragnos-hud': { stats: Shaped<Stats>; tick: number }
  }
}
