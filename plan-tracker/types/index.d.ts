export type PlanItemStatus = 'open' | 'claimed' | 'verified'

export type PlanItem = { id: number; text: string; status: PlanItemStatus; note?: string; nudges?: number }

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
