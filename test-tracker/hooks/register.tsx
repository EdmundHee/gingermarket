import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BranchTc, Run, Scope, Status, TestRow, View } from '../types'

const PANE = 'test-tracker'
const TITLE = 'Tests'
const DOCK_COLUMNS = 48 // plan-tracker's dock width, so the tabs match
/** A pattern, not the name: the laid tool-name union holds a plugin tool only once the plugin has loaded. */
const RUN = /^mcp__test-tracker__run_tests$/
const CASES = 'tests/TEST_CASES.md'
const KEEP = 5 // finished runs kept; a running run is never dropped
const PASSES_SHOWN = 8 // an open run lists every failure, then its last 8 other rows
const RESULT_MAX = 30_000 // Bash's own output cap
/** plan-tracker's TEST_CMD without its `tmux` and `claude plugin validate` arms. */
const TEST_CMD = /\bclaude plugin test\b|\b(npm|pnpm|yarn|bun)( run)? test\b|\b(pytest|vitest|jest)\b|\b(go|cargo) test\b|tests\/screen\//
/** pytest writes per test only unbuffered; colour codes would split the markers the parsers read. */
const ENV = { PYTHONUNBUFFERED: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
/** Trunks a branch is cut from (git-tracker's); on one, there are no branch TCs. */
const TRUNKS = ['dev', 'develop', 'main', 'master']
const SCOPES: readonly Scope[] = ['focused', 'branch', 'full']
const EMPTY: View = { nextId: 1, runs: [], tcSeen: {}, last: {} }
// shape 2: the card's fields; a stored 0.1.0 value (runs only) reads as absent
const view = atom({ plugin: 'test-tracker', key: 'view' } as const, EMPTY, { shape: '2' })

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
/** A control character in a Text gets the whole pane refused; output is full of them. */
const printable = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
/** A line as a parser reads it: no colour, no control characters, no trailing space. */
const shown = (line: string) => printable(line.replace(ANSI, '')).trimEnd()

// ---- parsing ------------------------------------------------------------------------------------------------------

/** What one line says: a finished test (`status`), a test about to run (`now`), a finished file (`last`), pytest -q dots. */
type Hit = {
  status?: Status
  name?: string
  prefix?: string
  isSummary?: boolean // pytest's short summary names a failure its dots or verbose line already counted
  now?: string
  last?: string
  dots?: string
  percent?: number
}

const BUN = /^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/
const SCREEN = /^(TC-\d+): (PASS|FAIL)$/
const SCREEN_NOW = /^=== (.+)$/
const PY_V = /^(\S+::\S+)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/
const PY_NOW = /^(\S+::\S+)$/
const PY_SUMMARY = /^(?:FAILED|ERROR) (\S+::\S+)/
const PY_DOTS = /^([.FEsxX]+)\s*(?:\[\s*(\d+)%\])?$/
const JEST_FILE = /^(?:PASS|FAIL)\s+(\S+)/
const JS = /^\s*([✓✔√✗×✕↓])\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*m?s)?$/
const JS_FILE = /\s*\(\d+ tests?\)$/ // vitest's default reporter: one line per file
const BUN_STATUS: Record<string, Status> = { pass: 'pass', fail: 'fail', skip: 'skip', todo: 'skip' }
const PY_STATUS: Record<string, Status> = { PASSED: 'pass', XPASS: 'pass', FAILED: 'fail', ERROR: 'fail', SKIPPED: 'skip', XFAIL: 'skip' }
const DOT: Record<string, Status> = { '.': 'pass', X: 'pass', F: 'fail', E: 'fail', s: 'skip', x: 'skip' }
const JS_STATUS: Record<string, Status> = { '✓': 'pass', '✔': 'pass', '√': 'pass', '✗': 'fail', '×': 'fail', '✕': 'fail', '↓': 'skip' }

/** `prefix > name` (bun, vitest) or `path::name` (pytest): the name after the last separator, the rest its prefix. */
function split(full: string): { name: string; prefix?: string } {
  const gt = full.lastIndexOf(' > ')
  if (gt >= 0) return { prefix: full.slice(0, gt), name: full.slice(gt + 3) }
  const cc = full.lastIndexOf('::')
  return cc >= 0 ? { prefix: full.slice(0, cc), name: full.slice(cc + 2) } : { name: full }
}

// ponytail: one regex per runner, first match wins; a runner whose lines look like another's needs its own guard
function parseLine(line: string, isPytest: boolean): Hit | undefined {
  let m: RegExpExecArray | null
  if ((m = BUN.exec(line))) return { status: BUN_STATUS[m[1] ?? ''], ...split(m[2] ?? '') }
  if ((m = SCREEN.exec(line))) return { status: m[2] === 'PASS' ? 'pass' : 'fail', name: m[1] }
  if ((m = SCREEN_NOW.exec(line))) return { now: m[1] }
  if ((m = PY_V.exec(line))) return { status: PY_STATUS[m[2] ?? ''], ...split(m[1] ?? '') }
  if ((m = PY_SUMMARY.exec(line))) return { status: 'fail', isSummary: true, ...split(m[1] ?? '') }
  if (isPytest && (m = PY_DOTS.exec(line))) return { dots: m[1], ...(m[2] === undefined ? {} : { percent: Number(m[2]) }) }
  if ((m = JEST_FILE.exec(line))) return { last: m[1] }
  if ((m = JS.exec(line))) {
    const text = m[2] ?? ''
    return JS_FILE.test(text) ? { last: text.replace(JS_FILE, '') } : { status: JS_STATUS[m[1] ?? ''], ...split(text) }
  }
  return undefined
}

// ---- TC mapping ---------------------------------------------------------------------------------------------------

type Tc = { id: string; feature: string; path: string; name: string }

/** Each `| TC-n | Feature | … | Code test | Status |` row, its code test split into path and test name. */
function tcIndex(md: string): Tc[] {
  return md.split('\n').flatMap(line => {
    const cells = line.split('|').map(c => c.trim())
    const id = cells[1] ?? ''
    // counted from the end: a Steps or Expected cell may hold a `|` of its own
    const code = (cells.at(-3) ?? '').replaceAll('`', '')
    if (!/^TC-\d+$/.test(id) || cells.length < 5 || code === '' || code === 'manual') return []
    const { prefix, name } = split(code)
    return [{ id, feature: cells[2] ?? '', path: prefix ?? '', name }]
  })
}

/** A test name without its parameter: `x (case 1)` → `x`, `test_a[2]` → `test_a`. */
const bare = (name: string) => name.replace(/\s*(?:\([^)]*\)|\[[^\]]*\])$/, '')

/** `/a/b/c/` of `a/b > c` or `a::b`, so whole segments compare and `e` never matches inside `test`. */
const segs = (s: string) => `/${s.split(/\/| > |::/).filter(Boolean).join('/')}/`
/** One holds the other as a run of whole segments: describe `b` in `b/x.ts`, `tests/unit` in `tests/unit/a.ts`, file `a.ts` in vitest's `a.ts > suite`. */
const within = (a: string, b: string) => segs(a).includes(segs(b)) || segs(b).includes(segs(a))

/** The one row a test maps to: by name, then by its prefix naming the row's file or folder; ambiguous → none. */
function tcOf(index: Tc[], name: string, prefix?: string) {
  if (/^TC-\d+$/.test(name)) return index.find(t => t.id === name)
  const hits = index.filter(t => t.name === bare(name))
  if (hits.length <= 1) return hits[0]
  const near = prefix === undefined ? [] : hits.filter(t => t.path !== '' && within(t.path, prefix))
  return near.length === 1 ? near[0] : undefined
}

// ---- a run's output -----------------------------------------------------------------------------------------------

/** What a run keeps outside the store: the line cut at a piece's end, the TC rows, the output Claude gets back. */
type Live = { carry: string; isPytest: boolean; index: Tc[]; runLines: string[]; kept: string[]; size: number }

let cwd = '' // the session's; a relative fs path resolves against the host process's, which may differ

const readCases = ($: EngineInterface) => $.fs.read(`${cwd}/${CASES}`).then(String).catch(() => '')

/** The commands of the `run:` header line: each backticked span (`pytest -q` | `npm test` gives two). */
function runLinesOf(md: string) {
  const line = md.split('\n').find(l => l.startsWith('run: ')) ?? ''
  return [...line.matchAll(/`([^`]+)`/g)].map(m => m[1] ?? '')
}

async function liveFor($: EngineInterface, command: string): Promise<Live> {
  const md = await readCases($)
  return { carry: '', isPytest: /\bpytest\b/.test(command), index: tcIndex(md), runLines: runLinesOf(md), kept: [], size: 0 }
}

// ---- scope ----------------------------------------------------------------------------------------------------------

const norm = (s: string) => s.trim().replace(/\s+/g, ' ')

/** Full: one of the run: line's commands. Focused: exactly one pytest node or one TC id. Branch: anything else. */
// ponytail: -k / -t / --grep may pick many tests, so they guess branch; Claude's scope says focused for those
function guess(command: string, runLines: string[]): Scope {
  if (runLines.some(r => norm(r) === norm(command))) return 'full'
  const nodes = command.match(/\S+::\S+/g) ?? []
  const tcs = new Set(command.match(/TC-\d+/g) ?? [])
  return nodes.length === 1 || (nodes.length === 0 && tcs.size === 1) ? 'focused' : 'branch'
}

/** Claude's scope when it is one of the three, else the guess; a said `full` that is not a run: command is flagged. */
function scopeOf(said: unknown, command: string, runLines: string[]): Pick<Run, 'scope' | 'scopeNote'> {
  const guessed = guess(command, runLines)
  const scope = SCOPES.find(s => s === said) ?? guessed
  return scope === 'full' && guessed !== 'full' && runLines.length > 0 ? { scope, scopeNote: 'not the run: line' } : { scope }
}

/** Keeps a line for the result; passing-test lines are the bulk of a log and tell Claude nothing. */
function keep(live: Live, line: string) {
  live.kept.push(line)
  live.size += line.length + 1
  while (live.size > RESULT_MAX * 2 && live.kept.length > 1) live.size -= (live.kept.shift() ?? '').length + 1
}

/** The hits of one piece: whole lines now, the cut one when its rest comes; pytest -v names a test before it runs. */
function piece(live: Live, text: string): Hit[] {
  const lines = (live.carry + text).split('\n')
  live.carry = lines.pop() ?? ''
  const hits: Hit[] = []
  for (const raw of lines) {
    const plain = raw.replace(ANSI, '').replace(/\r$/, '')
    const hit = parseLine(shown(plain), live.isPytest)
    if (hit?.status !== 'pass' || hit.isSummary) keep(live, plain)
    if (hit) hits.push(hit)
  }
  const pending = live.isPytest ? PY_NOW.exec(shown(live.carry)) : null
  if (pending) hits.push({ now: split(pending[1] ?? '').name })
  return hits
}

/** One hit on a run: counts, a row with its TC id, and what it is doing now. */
function apply(run: Run, hit: Hit, index: Tc[]): Run {
  if (hit.dots !== undefined) {
    const counts = { ...run.counts }
    for (const ch of hit.dots) {
      const s = DOT[ch]
      if (s) counts[s] += 1
    }
    return { ...run, counts, ...(hit.percent === undefined ? {} : { percent: hit.percent }) }
  }
  if (hit.now !== undefined) return { ...run, now: hit.now }
  if (hit.last !== undefined) return { ...run, last: hit.last }
  if (hit.status === undefined || hit.name === undefined) return run
  const name = hit.name
  if (hit.isSummary && run.tests.some(t => t.name === name)) return run
  const tc = tcOf(index, name, hit.prefix)
  const row: TestRow = { name, status: hit.status, ...(tc ? { tc: tc.id, feature: tc.feature } : {}) }
  const counts = hit.isSummary ? run.counts : { ...run.counts, [hit.status]: run.counts[hit.status] + 1 }
  const { now: _now, ...rest } = run
  return { ...rest, tests: [...run.tests, row], counts, last: name }
}

// ---- the store ----------------------------------------------------------------------------------------------------

/** Newest first: every running run, then the 5 newest finished ones. */
function trim(runs: Run[]) {
  let finished = 0
  return runs.filter(r => r.exit === undefined || ++finished <= KEEP)
}

let ticking: ReturnType<EngineInterface['clock']['every']> | undefined
let tickMs = 0

/** A 1 s redraw while a run runs (elapsed time), a 60 s one while the card shows a `… ago` line, none otherwise. */
async function tick($: EngineInterface) {
  const v = await read($, view)
  const ms = v.runs.some(r => r.exit === undefined) ? 1000 : Object.keys(v.last).length > 0 ? 60_000 : 0
  if (ms === tickMs) return
  ticking?.cancel()
  ticking = undefined
  tickMs = ms
  if (ms > 0) ticking = $.clock.every(ms, () => $.ui.invalidate('ui.render'))
}

type Init = Pick<Run, 'source' | 'command' | 'scope' | 'scopeNote'> & { agent?: string }

async function begin($: EngineInterface, init: Init): Promise<number> {
  const startedAt = await $.clock.now()
  let id = 0
  await update($, view, v => {
    id = v.nextId
    const run: Run = { id, ...init, startedAt, tests: [], counts: { pass: 0, fail: 0, skip: 0 } }
    return { ...v, nextId: v.nextId + 1, runs: trim([run, ...v.runs]) }
  })
  await tick($)
  void refreshBranch($) // a commit or a new row since the last run changes the branch's TCs
  return id
}

const patch = ($: EngineInterface, id: number, fn: (r: Run) => Run) =>
  update($, view, v => ({ ...v, runs: v.runs.map(r => (r.id === id ? fn(r) : r)) }))

const hitAll = (hits: Hit[], index: Tc[]) => (r: Run) => hits.reduce((acc, h) => apply(acc, h, index), r)

/** Each TC's result in one run: fail if any of its rows failed, else pass if any passed, else skip. */
function tcResults(tests: TestRow[]) {
  const out: Record<string, Status> = {}
  for (const t of tests) {
    if (t.tc === undefined) continue
    const was = out[t.tc]
    out[t.tc] = was === 'fail' || t.status === 'fail' ? 'fail' : was === 'pass' || t.status === 'pass' ? 'pass' : 'skip'
  }
  return out
}

/** Ends the run; its TC results and its scope's last result are kept past the history cap. */
async function finish($: EngineInterface, id: number, end: Pick<Run, 'exit'> & Partial<Pick<Run, 'error'>>) {
  const endedAt = await $.clock.now()
  await update($, view, v => {
    const old = v.runs.find(r => r.id === id)
    if (old === undefined) return v
    const { now: _now, ...rest } = old
    const done: Run = { ...rest, ...end, endedAt }
    const tcSeen = { ...v.tcSeen }
    for (const [tc, status] of Object.entries(tcResults(done.tests))) tcSeen[tc] = { status, at: endedAt }
    const last = done.scope === undefined
      ? v.last
      : { ...v.last, [done.scope]: { id: done.id, command: done.command, counts: done.counts, exit: done.exit, endedAt } }
    return { ...v, runs: trim(v.runs.map(r => (r.id === id ? done : r))), tcSeen, last }
  })
  await tick($)
  void refreshBranch($)
}

// ---- the branch's TCs -----------------------------------------------------------------------------------------------

/** feature-tracker's: a git that cannot start reads as a failed command, never a rejection. */
async function git($: EngineInterface, argv: string[]) {
  const r = await $.process.run(argv, { cwd: cwd || undefined }).catch(() => undefined)
  return { ok: r?.exitCode === 0, out: r?.stdout ?? '' }
}

/** `| TC-n | Feature | … | Code test | Status |` → its id, feature, and whether its code test is `manual`. */
function caseRow(line: string): BranchTc | undefined {
  const cells = line.split('|').map(c => c.trim())
  const id = cells[1] ?? ''
  if (!/^TC-\d+$/.test(id) || cells.length < 5) return undefined
  return { id, feature: cells[2] ?? '', isManual: (cells.at(-3) ?? '').replaceAll('`', '') === 'manual' }
}

/** The fork point of the nearest trunk: the one whose merge-base is fewest commits behind HEAD. */
async function nearestFork($: EngineInterface) {
  let best: { sha: string; behind: number } | undefined
  for (const trunk of TRUNKS) {
    const mb = await git($, ['git', 'merge-base', 'HEAD', trunk])
    if (!mb.ok) continue
    const sha = mb.out.trim()
    const n = await git($, ['git', 'rev-list', '--count', `${sha}..HEAD`])
    const behind = Number(n.out.trim())
    if (n.ok && Number.isFinite(behind) && (best === undefined || behind < best.behind)) best = { sha, behind }
  }
  return best?.sha
}

/** The branch and the TC rows it added or changed since its fork; a trunk has none; outside git, none at all. */
// ponytail: trunks only; a branch cut from another feature branch also lists the parent's new rows. Copy
// git-tracker's fewest-ahead parent if that matters.
async function readBranch($: EngineInterface): Promise<View['branch']> {
  const head = await git($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  const name = head.out.trim()
  if (!head.ok || name === '') return undefined
  if (TRUNKS.includes(name)) return { name, tcs: [] }
  const fork = await nearestFork($)
  if (fork === undefined) return { name, tcs: [] }
  const tracked = await git($, ['git', 'ls-files', '--error-unmatch', CASES])
  // working tree against the fork: rows written before the code count; an untracked file is new on this branch
  const lines = tracked.ok
    ? (await git($, ['git', 'diff', '--unified=0', fork, '--', CASES])).out.split('\n').filter(l => l.startsWith('+|')).map(l => l.slice(1))
    : (await readCases($)).split('\n')
  const tcs = new Map<string, BranchTc>()
  for (const line of lines) {
    const row = caseRow(line)
    if (row !== undefined && !tcs.has(row.id)) tcs.set(row.id, row)
  }
  return { name, tcs: [...tcs.values()] }
}

let reading: Promise<void> | undefined
let readAgain = false // a call that came mid-read: one more read covers every such call

/** git-tracker's single flight: a call during a read waits for it plus one more, so an old read never lands last. */
function refreshBranch($: EngineInterface): Promise<void> {
  if (reading !== undefined) {
    readAgain = true
    return reading
  }
  reading = (async () => {
    do {
      readAgain = false
      try {
        const branch = await readBranch($)
        await update($, view, v => ({ ...v, branch }))
      } catch (err) {
        $.ui.log(`test-tracker: branch read failed: ${String(err)}`, { to: 'debug' })
      }
    } while (readAgain)
  })().finally(() => {
    reading = undefined
  })
  return reading
}

/** The error without the engine's `<plugin>: $.process.spawn: ` lead. */
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^.*?\$\.process\.spawn: /, '')

/** What Claude reads back: exit, counts, the failures by name, then the output without its passing-test lines. */
function report(run: Run | undefined, live: Live) {
  if (run === undefined) return 'run_tests: the run was dropped'
  const c = run.counts
  const secs = (((run.endedAt ?? run.startedAt) - run.startedAt) / 1000).toFixed(1)
  const head = run.exit === 'error' ? `run_tests: ${run.error ?? 'failed'}` : run.exit === 'stopped' ? 'stopped' : `exit ${run.exit}`
  const fails = run.tests.filter(t => t.status === 'fail').map(label)
  const out = live.kept.join('\n')
  const tail = out.length > RESULT_MAX ? `… ${out.length - RESULT_MAX} earlier characters cut\n${out.slice(-RESULT_MAX)}` : out
  return [
    `${head} · ✓ ${c.pass} ✗ ${c.fail}${c.skip > 0 ? ` ○ ${c.skip}` : ''} · ${secs}s`,
    ...(fails.length > 0 ? [`failed: ${fails.join(', ')}`] : []),
    tail,
  ].join('\n')
}

/** Bash's output as the model read it; a hook's own answer has no `text`, so its record or error string. */
function outputOf(r: { text?: string; result?: unknown }) {
  if (r.text !== undefined) return r.text
  if (typeof r.result === 'string') return r.result
  const rec = (r.result ?? {}) as { stdout?: unknown; stderr?: unknown }
  return [rec.stdout, rec.stderr].filter((s): s is string => typeof s === 'string' && s !== '').join('\n')
}

// ---- drawing ------------------------------------------------------------------------------------------------------

/** `45s`, `3m 05s`, `1h 02m` (plan-tracker's); never negative. */
function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  return s < 3600 ? `${Math.floor(s / 60)}m ${two(s % 60)}s` : `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`
}

/** A finished run's time: tenths under 10 s, where a quick suite lives. */
const took = (ms: number) => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : fmt(ms))

const ICON: Record<Status, string> = { pass: '✓', fail: '✗', skip: '○' }
const ICON_COLOR: Record<Status, string> = { pass: 'success', fail: 'error', skip: 'inactive' }

/** A run's mark by how it ended: never `✓` for a run that did not pass. */
function mark(exit: Run['exit']): [string, string] {
  if (exit === undefined) return ['▶', 'suggestion']
  if (exit === 'stopped') return ['■', 'inactive']
  if (exit === 'error') return ['!', 'warning']
  return exit === 0 ? ['✓', 'success'] : ['✗', 'error']
}

/** What the run is doing, or how it ended when that is not a plain exit. */
function doing(r: Run) {
  if (r.exit === 'stopped') return '■ stopped'
  if (r.exit === 'error') return `! error: ${r.error ?? 'failed'}`
  if (r.exit === undefined && r.source === 'bash') return '(bash: results at the end)'
  if (r.exit === undefined && r.now !== undefined) return `now: ${r.now}`
  if (r.exit === undefined && r.percent !== undefined) return `${r.percent}%`
  return r.last === undefined ? '' : `last: ${r.last}`
}

/** Every failure, then the last 8 other rows; indexes into `tests`, so each row keeps its key. */
function shownRows(r: Run) {
  const fails = r.tests.flatMap((t, i) => (t.status === 'fail' ? [i] : []))
  const rest = r.tests.flatMap((t, i) => (t.status === 'fail' ? [] : [i])).slice(-PASSES_SHOWN)
  return [...fails, ...rest]
}

const label = (t: TestRow) => (t.tc === undefined ? t.name : `${t.tc} ${t.name === t.tc ? (t.feature ?? '') : t.name}`)

// ---- the card -------------------------------------------------------------------------------------------------------

const SCOPE_LABEL: Record<Scope, string> = { focused: 'Focused test', branch: 'Branch tests', full: 'Full suite' }
const LAST_ORDER: readonly Scope[] = ['full', 'branch', 'focused']
const BAR = 10 // plan-tracker's bar width
const TC_LINES = 8 // failing then not-run branch TCs listed, the rest as `+k more`
const bar = (filled: number) => `${'▰'.repeat(filled)}${'▱'.repeat(BAR - filled)}`
const total = (c: Record<Status, number>) => c.pass + c.fail + c.skip

/** `45s`, `12m`, `3h`, `2d`: how long ago, at a glance. */
function ago(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}

/** How many tests the run should reach: the newest earlier finished run of the same command. */
function expectedOf(v: View, r: Run) {
  const prior = v.runs.find(o => o.id < r.id && o.exit !== undefined && o.command === r.command)
  if (prior !== undefined) return total(prior.counts)
  const last = r.scope === undefined ? undefined : v.last[r.scope]
  return last !== undefined && last.id < r.id && last.command === r.command ? total(last.counts) : undefined
}

/** `▰▰▰▰▰▱▱▱▱▱ n/N · time`; pytest -q's percent; or the count alone with nothing to measure against. */
function barLine(v: View, r: Run, now: number) {
  const n = total(r.counts)
  const time = r.exit === undefined ? fmt(now - r.startedAt) : took((r.endedAt ?? r.startedAt) - r.startedAt)
  if (r.percent !== undefined) return `${bar(Math.min(BAR, Math.round(r.percent / 10)))} ${r.percent}% · ${time}`
  const want = expectedOf(v, r)
  if (want === undefined || want === 0) return `${n} · ${time}`
  return `${bar(Math.min(BAR, Math.round((n / want) * BAR)))} ${n}/${want} · ${time}`
}

/** Each TC's newest result: the finished runs' kept results, the running runs' rows on top. */
function tcStatus(v: View) {
  const out: Record<string, Status> = {}
  for (const [tc, seen] of Object.entries(v.tcSeen)) out[tc] = seen.status
  for (const r of [...v.runs].reverse()) if (r.exit === undefined) Object.assign(out, tcResults(r.tests))
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.tool.register({
      name: 'run_tests',
      description:
        'Run a test command with live progress in the Tests tab: each test ticks pass or fail as it finishes, with ' +
        'its TC id from tests/TEST_CASES.md. Runs the command with /bin/sh in the session directory, as Bash does. ' +
        'Use it for every test run (pytest, npm test, claude plugin test, screen scripts) instead of Bash. Returns ' +
        'the exit code, the counts, the failing tests and the output without its passing-test lines.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the test command, as you would give it to Bash' },
          scope: {
            type: 'string',
            enum: ['focused', 'branch', 'full'],
            description:
              'focused: one test or TC you are working on; branch: this branch\'s tests (the plan\'s new and changed ' +
              'rows, the areas the diff touches); full: the whole suite, the run: line of tests/TEST_CASES.md',
          },
        },
        required: ['command'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: PANE, description: 'Open the Tests pane: test runs live, each test pass or fail, the last five runs' })
    // a reload lost the child that fed a running run: it can only read as stopped now
    await update($, view, v => ({ ...v, runs: trim(v.runs.map(r => (r.exit === undefined ? { ...r, exit: 'stopped' as const } : r))) }))
    void $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
    void refreshBranch($) // the first prompt never waits on git; the card fills in when it lands
    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
    return { text: opened.isPlaced ? 'Tests pane opened.' : `Tests pane waits: ${opened.reason}` }
  })

  // Served at tool.run, after the permission check: the person allows each command as a Bash call, and every
  // plugin's tool.call hook (plan-tracker's Test phase) has seen the call by then.
  on('tool.run', { tool: RUN }, async ($, e, next) => {
    const command = String((e as { command?: unknown }).command ?? '').trim()
    if (command === '') return { result: 'run_tests: command is empty' }
    // read before the run starts: its run: line decides the scope the run is born with
    const live = await liveFor($, command)
    const scope = scopeOf((e as { scope?: unknown }).scope, command, live.runLines)
    const id = await begin($, { source: 'tool', command, ...scope, ...(e.agentId === undefined ? {} : { agent: e.agentId }) })
    // ponytail: /bin/sh, not the person's zsh; switch if a run line ever needs zsh syntax
    // ponytail: no timeout of its own; Esc stops it. Add timeoutMs if a hung run without Esc ever happens.
    const stop = new Promise<'stop'>(resolve => {
      if (next.signal.aborted) resolve('stop')
      else next.signal.addEventListener('abort', () => resolve('stop'), { once: true })
    })
    let end: Pick<Run, 'exit'> & Partial<Pick<Run, 'error'>> = { exit: 'error', error: 'ended without an exit code' }
    try {
      const child = $.process.spawn({ argv: ['/bin/sh', '-c', command], env: ENV })
      for (;;) {
        const pull = child.next()
        pull.catch(() => undefined) // a pull left behind by Esc may reject later
        const step = await Promise.race([pull, stop])
        if (step === 'stop') {
          // leaving the stream kills the child
          void child.return({ code: null, signal: null }).catch(() => undefined)
          end = { exit: 'stopped' }
          break
        }
        if (step.done) {
          const tailHits = live.carry === '' ? [] : piece(live, '\n')
          if (tailHits.length > 0) await patch($, id, hitAll(tailHits, live.index))
          end = step.value.code === null ? { exit: 'error', error: `ended by ${step.value.signal ?? 'a signal'}` } : { exit: step.value.code }
          break
        }
        const hits = piece(live, step.value.text)
        if (hits.length > 0) await patch($, id, hitAll(hits, live.index))
      }
    } catch (err) {
      end = next.signal.aborted ? { exit: 'stopped' } : { exit: 'error', error: message(err) }
    } finally {
      await finish($, id, end)
    }
    return { result: report((await read($, view)).runs.find(r => r.id === id), live) }
  })

  // A test command run through Bash: shown as running, its rows parsed from what Bash returned.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const input = e as { command?: unknown; run_in_background?: unknown }
    const command = String(input.command ?? '')
    // ponytail: background Bash untracked; its output lands in a file later and no event says when it ends
    if (input.run_in_background === true || !TEST_CMD.test(command)) return next(e)
    const live = await liveFor($, command)
    const id = await begin($, {
      source: 'bash', command, ...scopeOf(undefined, command, live.runLines), ...(e.agentId === undefined ? {} : { agent: e.agentId }),
    })
    let end: Pick<Run, 'exit'> & Partial<Pick<Run, 'error'>> = { exit: 'error', error: 'the Bash call failed' }
    try {
      const r = await next(e)
      if (r.deny !== undefined) {
        end = { exit: 'stopped' } // refused: it never ran
        return r
      }
      const hits = piece(live, `${outputOf(r)}\n`)
      if (hits.length > 0) await patch($, id, hitAll(hits, live.index))
      end = { exit: r.isError ? 1 : 0 }
      return r
    } finally {
      await finish($, id, end)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const tcs = v.branch?.tcs ?? []
    if (v.runs.length === 0 && tcs.length === 0) {
      return (
        <Box flexDirection="column">
          <Box key="empty">
            <Text dimColor>No test runs yet.</Text>
          </Box>
        </Box>
      )
    }
    const now = await $.clock.now()
    const newestDone = v.runs.find(r => r.exit !== undefined)?.id

    /** `✓ n  ✗ m  ○ k   what it is doing`, a run's own line and the card's. */
    const stat = (r: Run) => (
      <Text wrap="truncate">
        {'  '}
        <Text color="success">{`✓ ${r.counts.pass}`}</Text>
        {'  '}
        <Text color={r.counts.fail > 0 ? 'error' : 'inactive'}>{`✗ ${r.counts.fail}`}</Text>
        {r.counts.skip > 0 && <Text color="inactive">{`  ○ ${r.counts.skip}`}</Text>}
        <Text dimColor>{`   ${printable(doing(r))}`}</Text>
      </Text>
    )

    // the card's run: the one running now, else the newest
    const cr = v.runs.find(r => r.exit === undefined) ?? v.runs[0]
    const head = [v.branch?.name, cr?.scope === undefined ? undefined : SCOPE_LABEL[cr.scope]].filter(Boolean).join(' · ')
    const status = tcStatus(v)
    const tally = { pass: 0, fail: 0, skip: 0 }
    for (const t of tcs) {
      const st = status[t.id]
      if (st !== undefined) tally[st] += 1
    }
    const notRun = tcs.length - total(tally)
    const tcLines = [
      ...tcs.filter(t => status[t.id] === 'fail').map(t => ({ id: t.id, text: `✗ ${t.id} ${t.feature}`, isFail: true })),
      ...tcs.filter(t => status[t.id] === undefined).map(t => ({ id: t.id, text: `· ${t.id} ${t.feature}${t.isManual ? ' (manual)' : ''}`, isFail: false })),
    ]
    const lasts = LAST_ORDER.flatMap(sc => {
      const l = v.last[sc]
      return l === undefined ? [] : [{ sc, l }]
    })

    const card = (
      <Box key="card" flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {head !== '' && (
            <Box key="card:head" flexDirection="row" gap={1}>
              <Box flexGrow={1}>
                <Text bold wrap="truncate">{printable(head)}</Text>
              </Box>
              {cr?.scopeNote !== undefined && (
                <Box flexShrink={0}>
                  <Text color="warning">{cr.scopeNote}</Text>
                </Box>
              )}
            </Box>
          )}
          {cr !== undefined && (
            <Box key="card:bar">
              <Text dimColor wrap="truncate">{barLine(v, cr, now)}</Text>
            </Box>
          )}
          {cr !== undefined && <Box key="card:stat">{stat(cr)}</Box>}
        </Box>
        {tcs.length > 0 && (
          <Box flexDirection="column">
            <Box key="card:tcs">
              <Text wrap="truncate">
                {`Branch TCs ${tcs.length}   ✓ ${tally.pass}  ✗ ${tally.fail}${tally.skip > 0 ? `  ○ ${tally.skip}` : ''}  · ${notRun} not run`}
              </Text>
            </Box>
            {tcLines.slice(0, TC_LINES).map(l => (
              <Box key={`card:tc:${l.id}`} marginLeft={2}>
                {l.isFail ? <Text color="error" wrap="truncate">{printable(l.text)}</Text> : <Text dimColor wrap="truncate">{printable(l.text)}</Text>}
              </Box>
            ))}
            {tcLines.length > TC_LINES && (
              <Box key="card:tc:more" marginLeft={2}>
                <Text dimColor>{`+${tcLines.length - TC_LINES} more`}</Text>
              </Box>
            )}
          </Box>
        )}
        {lasts.length > 0 && (
          <Box flexDirection="column">
            {lasts.map(({ sc, l }) => {
              const [icon, color] = mark(l.exit)
              return (
                <Box key={`card:last:${sc}`}>
                  <Text wrap="truncate">
                    {`Last ${sc.padEnd(8)} `}
                    <Text color={color}>{icon}</Text>
                    <Text dimColor>{` ${l.counts.pass}/${l.counts.pass + l.counts.fail}   ${ago(now - l.endedAt)} ago`}</Text>
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {card}
        {v.runs.map(r => {
          const isOpen = r.exit === undefined || r.id === newestDone
          const [icon, color] = mark(r.exit)
          const c = r.counts
          const time = r.exit === undefined ? fmt(now - r.startedAt) : took((r.endedAt ?? r.startedAt) - r.startedAt)
          const tally = r.exit === undefined ? time : `${c.pass}/${c.pass + c.fail}  ${time}`
          return (
            <Box key={`run:${r.id}`} flexDirection="column">
              <Box key={`head:${r.id}`} flexDirection="row" gap={1}>
                <Box flexGrow={1}>
                  <Text bold={isOpen} wrap="truncate">
                    <Text color={color}>{icon}</Text>
                    {r.agent !== undefined && <Text color="claude">{' sub'}</Text>}
                    {` ${printable(r.command)}`}
                  </Text>
                </Box>
                {/* the command truncates, never the tally: a long command wrapped it onto a second line */}
                <Box flexShrink={0}>
                  <Text dimColor>{tally}</Text>
                </Box>
              </Box>
              {isOpen && <Box key={`stat:${r.id}`}>{stat(r)}</Box>}
              {isOpen && shownRows(r).map(i => {
                const t = r.tests[i]
                return t === undefined ? null : (
                  <Box key={`row:${r.id}:${i}`}>
                    <Text wrap="truncate">
                      {'  '}
                      <Text color={ICON_COLOR[t.status]}>{ICON[t.status]}</Text>
                      {` ${printable(label(t))}`}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          )
        })}
      </Box>
    )
  })
}
