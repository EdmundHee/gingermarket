export type Status = 'planned' | 'partial' | 'done' | 'broken'

export type Feature = { name: string; desc: string; status: Status }

/** A `## <name>` block of features.md: its `paths:` globs and its feature lines. */
export type Module = { name: string; paths: string[]; features: Feature[] }

/** A module's newest review note. */
export type Latest = {
  file: string // absolute path
  sha: string // the commit it reviewed, `nogit` outside a repo
  open: number // unticked findings
  stale?: number // files under the module's paths changed since `sha`
}

export type View = {
  project: string
  mode: 'vault' | 'repo'
  root: string // the folder holding features.md and reviews/
  hint?: string
  hasInventory: boolean
  modules: Module[]
  latest: Record<string, Latest> // by module name
  busy: Record<string, 'scanning' | 'reviewing'> // `scan`, or a module name
  expanded: string[] // module names
}

declare module 'claude-code' {
  interface PluginState {
    'feature-tracker': { view: View }
  }
}
