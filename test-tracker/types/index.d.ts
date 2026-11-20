export type Status = 'pass' | 'fail' | 'skip'

/** What a run covers: one test or TC being worked on, this branch's tests, or the whole `run:` line. */
export type Scope = 'focused' | 'branch' | 'full'

export type TestRow = {
  name: string
  status: Status
  prefix?: string // the part before the name: a pytest file or class, a bun describe
  tc?: string // TC id from tests/TEST_CASES.md, when the test maps to exactly one row
  feature?: string // that row's Feature cell
}

export type Run = {
  id: number
  source: 'tool' | 'bash' // run_tests streams live; a Bash run is parsed once it ends
  agent?: string // set when a subagent made the call
  command: string
  scope?: Scope
  scopeNote?: string // Claude said full, but the command is not the run: line
  startedAt: number
  endedAt?: number
  exit?: number | 'stopped' | 'error' // absent while running
  error?: string
  tests: TestRow[]
  counts: Record<Status, number>
  now?: string // the test the runner named before running it
  last?: string // the last test or file it finished
  percent?: number // pytest -q progress
}

/** A TC row this branch added or changed in tests/TEST_CASES.md. */
export type BranchTc = { id: string; feature: string; isManual: boolean }

/** The newest finished run of one scope, kept past the history cap. */
export type LastRun = { id: number; command: string; counts: Record<Status, number>; exit: Run['exit']; endedAt: number }

export type View = {
  nextId: number
  runs: Run[]
  branch?: { name: string; tcs: BranchTc[] }
  tcSeen: Record<string, { status: Status; at: number }> // each TC's result in the newest run (by start, `at`) that had it
  last: Partial<Record<Scope, LastRun>>
}

declare module 'claude-code' {
  interface PluginState {
    'test-tracker': { view: Shaped<View> }
  }
}
