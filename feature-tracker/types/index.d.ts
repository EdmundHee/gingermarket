export type Status = 'planned' | 'partial' | 'done' | 'broken'

export type Feature = { name: string; desc: string; status: Status }

/** A `## <name>` block of features.md: its `paths:` globs and its feature lines. */
export type Module = { name: string; paths: string[]; features: Feature[] }

/** An unticked finding of a module's newest review note. */
export type Item = {
  group: 'fixes' | 'ideas' // ideas: under `## Improvement`
  line: string // the note line after `- [ ] `: `sev · file[:line] — title → fix`
  sev: string
  tag: string // product area, one PR per tag; `untagged` for notes written before tags
  title: string
}

/** A module's newest review note. */
export type Latest = {
  file: string // absolute path
  date: string // YYYY-MM-DD, from its file name
  sha: string // the commit it reviewed, `nogit` outside a repo
  items: Item[] // unticked findings, in note order
  stale?: number // files under the module's paths changed since `sha`
  dirty?: number // files under its paths uncommitted when it was reviewed, so `sha` lacks them
}

export type View = {
  project: string
  mode: 'vault' | 'repo'
  root: string // the folder holding features.md and reviews/
  hint?: string
  hasInventory: boolean
  modules: Module[]
  latest: Record<string, Latest> // by module name
  busy: Record<string, 'scanning' | 'reviewing' | 'verifying'> // `scan`, or a module name
  expanded: string[] // module names, `<module>#fixes` / `<module>#ideas` groups, and `<module>#<group>#<tag>` tag rows
  picked: string[] // `<note path>\t<item line>` chosen for Plan N selected
  layout: 1 | 2 | 3 // 1: the module list; 2, 3: PR cards per row
}

declare module 'claude-code' {
  interface PluginState {
    'feature-tracker': { view: View }
  }
}
