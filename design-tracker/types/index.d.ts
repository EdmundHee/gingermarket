/** What a board's entry in `.claude/design-tracker.json` says; no entry means not started. */
export type BoardEntry = { status: 'started' | 'done'; files?: string[] }

/** `<root>/.claude/design-tracker.json`, committed with the project. */
export type DesignConfig = { canvas: string; boards: Record<string, BoardEntry> }

/** ○ not started, ◐ in progress (or done with every file gone), ✓ done. */
export type Build = 'none' | 'started' | 'done'

export type BoardRow = { file: string; title: string; isDraft: boolean; build: Build }

export type PageRows = { id: string; name: string; boards: BoardRow[] }

export type Ref = { url: string; title: string }

export type DesignView = {
  isLinked: boolean
  canvas?: Ref
  library?: Ref
  pages: PageRows[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'design-tracker': { view: DesignView }
  }
}
