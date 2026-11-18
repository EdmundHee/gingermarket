export type PlanItemStatus = 'open' | 'claimed' | 'verified'

// claim: mark_done's evidence line, read by the audit; note: the audit's reason (or 'by you')
// doneAt: ms epoch of the first mark or verification, never moved after
export type PlanItem = { id: number; text: string; status: PlanItemStatus; claim?: string; note?: string; nudges?: number; doneAt?: number }

export type PlanGroup = {
  id: string
  title: string
  file: string
  hash?: string // of the plan text; the same text approved again keeps this group
  approvedAt: string
  items: PlanItem[]
  note?: string
}

/** One timed run, ms epoch: the first plan-mode prompt, the plan's approval (group `plan`), its last item verified. */
export type Timing = { startedAt: number; planAt?: number; plan?: string; endedAt?: number }

export type Tracker = { nextId: number; plans: PlanGroup[]; busy?: 'extract' | 'verify'; timing?: Timing }

declare module 'claude-code' {
  interface PluginState {
    'plan-tracker': { tracker: Tracker }
  }
}
