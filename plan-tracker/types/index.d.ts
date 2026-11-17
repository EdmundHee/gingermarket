export type PlanItemStatus = 'open' | 'claimed' | 'verified'

// claim: mark_done's evidence line, read by the audit; note: the audit's reason (or 'by you')
export type PlanItem = { id: number; text: string; status: PlanItemStatus; claim?: string; note?: string; nudges?: number }

export type PlanGroup = {
  id: string
  title: string
  file: string
  hash?: string // of the plan text; the same text approved again keeps this group
  approvedAt: string
  items: PlanItem[]
  note?: string
}

export type Tracker = { nextId: number; plans: PlanGroup[]; busy?: 'extract' | 'verify' }

declare module 'claude-code' {
  interface PluginState {
    'plan-tracker': { tracker: Tracker }
  }
}
