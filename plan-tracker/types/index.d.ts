export type PlanItemStatus = 'open' | 'claimed' | 'verified'

// claim: mark_done's evidence line, read by the audit; note: the audit's reason (or 'by you')
export type PlanItem = { id: number; text: string; status: PlanItemStatus; claim?: string; note?: string; nudges?: number }

/** A phase of the work, as the tool calls show it. `waiting`: paused while the user has the floor, never counted. */
export type Phase = 'plan' | 'review' | 'dev' | 'fixes' | 'test' | 'verify' | 'waiting'

/** Milliseconds spent in each phase. */
export type Times = Partial<Record<Phase, number>>

export type PlanGroup = {
  id: string
  title: string
  file: string
  hash?: string // of the plan text; the same text approved again keeps this group
  approvedAt: string
  items: PlanItem[]
  note?: string
  time?: Times
}

/**
 * The running clock: `phase` since `since` (ms epoch), for `group`, or for `Tracker.pending` while a plan-mode run
 * is not approved yet. `resume`: the phase to go back to after a pause. `bg`: a background Codex run is in flight.
 * `session`: the session it last ran in; a new one does not count the gap.
 */
export type Clock = { group?: string; phase: Phase; since: number; resume?: Phase; bg?: true; session?: string }

export type Tracker = { nextId: number; plans: PlanGroup[]; busy?: 'extract' | 'verify'; pending?: Times; clock?: Clock }

declare module 'claude-code' {
  interface PluginState {
    'plan-tracker': { tracker: Tracker; expanded: string[] }
  }
}
