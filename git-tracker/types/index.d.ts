export type FileChange = { path: string; added: number; removed: number; isNew: boolean; isBinary: boolean }

export type Pr = { number: number; url: string; state: string; isDraft: boolean }

export type GitView = {
  branch: string
  parent?: string // the branch this one was cut from; none on a trunk
  ahead: number
  behind: number
  graph: string[]
  files: FileChange[]
  pr?: Pr
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'git-tracker': { view: GitView }
  }
}
