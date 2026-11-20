export type Status = 'pass' | 'fail' | 'skip'

export type TestRow = {
  name: string
  status: Status
  tc?: string // TC id from tests/TEST_CASES.md, when the test maps to exactly one row
  feature?: string // that row's Feature cell
}

export type Run = {
  id: number
  source: 'tool' | 'bash' // run_tests streams live; a Bash run is parsed once it ends
  agent?: string // set when a subagent made the call
  command: string
  startedAt: number
  endedAt?: number
  exit?: number | 'stopped' | 'error' // absent while running
  signal?: string // what ended the child when it had no exit code
  error?: string
  tests: TestRow[]
  counts: Record<Status, number>
  now?: string // the test the runner named before running it
  last?: string // the last test or file it finished
  percent?: number // pytest -q progress
}

export type View = { nextId: number; runs: Run[] }

declare module 'claude-code' {
  interface PluginState {
    'test-tracker': { view: View }
  }
}
