/**
 * Overview pane: plan-tracker's, git-tracker's and test-tracker's session state in one tab, a row each, and this
 * project's token count. It reads their state (any plugin reads any value; the owner alone writes it) and Claude Code's
 * transcripts, keeps its token tally in its own store, and runs nothing: no git, no gh, no tests, no model.
 *
 * ponytail: the drawing below copies the trackers' own. Plugins install as separate folders, so there is no shared
 * import, and a `$` noun cannot carry functions. A change to a tracker's look needs the same change here:
 * - plan row: plan-tracker/hooks/register.tsx PLAN_DOC :21, SOURCES/sourceOf :23-24, PHASES :45, isDone :118,
 *   isPlanning :119, add :135, sum :137, fmt :226; in its render verified :802, live :805, phaseRows/group :812-877
 *   (no buttons, no item rows), Planning :879-884, sections :890-905
 * - git row: git-tracker/hooks/register.tsx PR_COLOR :145, stat :186-196, CHANGED/NEW from section :225-232 (totals
 *   only), head :248-265 (no ↻), no changes :269, PR :272-280; no graph
 * - tests row: test-tracker/hooks/register.tsx printable :30, tcResults :327, fmt/took/mark/doing :486-516, card
 *   helpers :528-572, stat :738-747, card :749-828; no run history
 * Nothing checks a copy against its source (a kit test cannot load another plugin's module): keep them in step by hand.
 */
import type { EngineInterface, PluginState, Register, ShapedValue } from 'claude-code'
import { atom, read } from 'claude-code'

type Tracker = PluginState['plan-tracker']['tracker']
type PlanGroup = Tracker['plans'][number]
type PlanItem = PlanGroup['items'][number]
type Times = NonNullable<PlanGroup['time']>
type Phase = keyof Times
type GitView = PluginState['git-tracker']['view']
type View = ShapedValue<PluginState['test-tracker']['view']>
type Run = View['runs'][number]
type TestRow = Run['tests'][number]
type Status = keyof Run['counts']
type Scope = NonNullable<Run['scope']>

const PANE = 'overview'
const DOCK_COLUMNS = 48 // the trackers' dock width
/** Each row's title color: theme keys with no pass/fail meaning, so a title never reads as a status. */
const TITLE = { plan: 'planMode', git: 'claude', tests: 'ide', tokens: 'autoAccept' } as const

/**
 * Each second: a redraw while a plan phase runs (not paused) or a test runs, or when a `… ago` label changes (each
 * second in its first minute, then at each whole minute of its age). A tracker's own write already redraws the pane;
 * this is for the clocks between writes. Overview keeps its
 * own timer because a tracker's `$.ui.invalidate` passes only the hooks of plugins above it, and an installed Overview
 * may load after the trackers (the order is Claude Code's). The same tick drives the token tally: each second while
 * it is behind, else every 30 s.
 */
let before: number | undefined // the previous tick's time: a label's minute is compared with it, not a window a late tick could skip

// ponytail: two state reads a second all session, idle too; start and stop it on tracker writes if that ever shows
async function tick($: EngineInterface) {
  const t = await read($, plan)
  const v = await read($, tests)
  const now = await $.clock.now()
  const was = before
  before = now
  const minute = (at: number, ended: number) => Math.floor((at - ended) / 60_000)
  const running = (t.clock !== undefined && t.clock.phase !== 'waiting') || v.runs.some(r => r.exit === undefined)
  const relabel = Object.values(v.last).some(l => now - l.endedAt <= 60_000 || was === undefined || minute(now, l.endedAt) !== minute(was, l.endedAt))
  // the Tokens row's month label and day chart, against the day last drawn: a draw at 23:59:59 and a first tick at
  // 00:00:00 still turn
  const reday = dayDrawn !== undefined && dayOf(now) !== dayDrawn
  if (reday) dayDrawn = dayOf(now)
  if (running || relabel || reday) $.ui.invalidate('ui.render')
  if (tokens === undefined || (tokens !== 'none' && tokens.isBehind) || now - tallied >= TALLY_EVERY) void tally($)
}

// ---- tokens row (Claude Code's transcripts) -------------------------------------------------------------------------

/**
 * One transcript's tally, kept in the store: where counting stopped, what it found before that (in all, by local month
 * and by local day), and the id hashes of every message it holds. A resumed session's transcript starts with copies of
 * its parent's rows, same ids; it keeps them too, so a session resumed from it after the parent is deleted still skips
 * them. No `days`: kept by 0.2.0, counted again once (see `tally`).
 */
type Counted = { offset: number; first?: number; parts: number[]; months: Record<string, number>; days?: Record<string, number>; ids: number[] }
/**
 * This project's tally. `files` by path, their counts kept for good: a transcript Claude Code deletes later still
 * counts, and only its ids go. `seen`: every kept file's ids. `transcript`: this session's. `isCounted`: every file read
 * to its end once; `isBehind`: the last tally ran out of budget; `isDirty`: changed since the last save.
 */
type Tokens = {
  dir: string
  transcript: string
  files: Record<string, Counted>
  seen: Set<number>
  isCounted: boolean
  isBehind: boolean
  isDirty: boolean
  isUpgrading: boolean
}
/** What the store keeps per project folder. */
type Kept = { files?: Record<string, Counted> }

const READ_MAX = 4 * 1024 * 1024 // the most one $.fs.read gives
const TALLY_BUDGET = 8 * 1024 * 1024 // bytes per tally, well inside a hook's 10 s
const TALLY_EVERY = 30_000
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const NEWLINE = 10

let tokens: Tokens | 'none' | undefined // 'none': this session keeps no transcript
let tallied = 0 // when the last tally started
let tallying = false
let problem: string | undefined // the last tally's read, save or count failure, shown under the counts
let drawn = '' // what the last token redraw showed besides the counts
/** The chart under the counts, kept in the store under `chart`; this module's copy survives /clear. */
let chartView: 'days' | 'months' = 'days'
let dayDrawn: string | undefined // the local day the pane last drew (or was last asked to)
/** Bytes read past a file's offset with no `\n` yet: the next tally goes on after them instead of reading them again. */
const carry = new Map<string, Uint8Array>()
const decoder = new TextDecoder()

const monthOf = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const dayOf = (at: number) => `${monthOf(at)}-${String(new Date(at).getDate()).padStart(2, '0')}`
// the unit after rounding: 999,960 is 1.0M, not 1000.0K
const fmtTokens = (n: number) =>
  n < 1e3 ? `${n}` : n < 999_950 ? `${(n / 1e3).toFixed(1)}K` : n < 999_950_000 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e9).toFixed(2)}B`
// ponytail: a 32-bit FNV-1a hash keeps the store small (~11 bytes a message). A project with 25k messages on disk has
// a ~7% chance that two ids share one, which drops one message (~0.004% of the count); store the ids if that matters
const idHash = (id: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return h >>> 0
}
const why = (err: unknown) => (err instanceof Error ? err.message : String(err))
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * One transcript row: an assistant row's `message.usage` counts input, output, cache write and cache read, once per
 * message id across the project. A message's several rows carry the same usage, and a resumed session repeats them.
 */
function countLine(line: string, c: Counted, seen: Set<number>) {
  if (!line.includes('"usage"')) return
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return
  }
  if (typeof row !== 'object' || row === null) return
  const { type, timestamp, message } = row as { type?: unknown; timestamp?: unknown; message?: { id?: unknown; usage?: unknown } }
  const id = message?.id
  if (type !== 'assistant' || typeof id !== 'string' || typeof message?.usage !== 'object' || message.usage === null) return
  const usage = message.usage as Record<string, unknown>
  const h = idHash(id)
  // a message's rows come one after another: its id once per file
  if (c.ids.at(-1) !== h) c.ids.push(h)
  if (seen.has(h)) return
  seen.add(h)
  // a count that is not a finite, positive number (-5, 1e400) is 0: it would cancel or swamp the rest
  const parts = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(n =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0,
  )
  parts.forEach((n, i) => {
    c.parts[i] = (c.parts[i] ?? 0) + n
  })
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN
  if (Number.isNaN(at)) return
  c.first = Math.min(c.first ?? at, at)
  const n = parts.reduce((a, b) => a + b, 0)
  const month = monthOf(at)
  c.months[month] = (c.months[month] ?? 0) + n
  const days = (c.days ??= {})
  const day = dayOf(at)
  days[day] = (days[day] ?? 0) + n
}

/** Counts every complete line in `bytes`; returns how many bytes that used (up to and with the last `\n`). */
function countLines(bytes: Uint8Array, c: Counted, seen: Set<number>) {
  let start = 0
  for (let nl = bytes.indexOf(NEWLINE); nl >= 0; nl = bytes.indexOf(NEWLINE, start)) {
    countLine(decoder.decode(bytes.subarray(start, nl)), c, seen)
    start = nl + 1
  }
  return start
}

const join = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * The project folder's transcripts: `<id>.jsonl` and each session's `<id>/subagents/*.jsonl` (a link, `other`, left
 * out), oldest write first, so a parent is counted before the session resumed from it and keeps its replies. `error`:
 * a subagents folder that is there but would not list; the rest still counts.
 */
async function transcripts($: EngineInterface, dir: string) {
  const top = await $.fs.list(dir)
  const jsonl = (entries: readonly { name: string; kind: string; size: number; mtimeMs: number }[], at: string) =>
    entries.filter(f => f.kind === 'file' && f.name.endsWith('.jsonl')).map(f => ({ path: `${at}/${f.name}`, size: f.size, mtime: f.mtimeMs }))
  const found = jsonl(top, dir)
  let error: string | undefined
  for (const d of top.filter(f => f.kind === 'dir')) {
    const at = `${dir}/${d.name}/subagents`
    try {
      found.push(...jsonl(await $.fs.list(at), at))
    } catch (err) {
      // most session folders have no subagents/
      if (await $.fs.exists(at).catch(() => true)) error = `Can't read a subagents folder: ${why(err)}`
    }
  }
  // ponytail: a parent resumed again after its child writes later than it; the child then gets the copies on a first count
  return { found: found.sort((a, b) => a.mtime - b.mtime), error }
}

/**
 * Reads what the transcripts gained since the last tally, at most TALLY_BUDGET bytes, and keeps the counts in the
 * store. A partial last line waits in `carry` for its end. One at a time: a tick that finds one running skips.
 */
async function tally($: EngineInterface) {
  if (tallying) return
  tallying = true
  try {
    tallied = await $.clock.now()
    // read every time: /clear starts a new transcript with no session.start
    const { transcriptPath } = await $.session.info()
    if (transcriptPath === '') {
      if (tokens !== 'none') $.ui.invalidate('ui.render')
      tokens = 'none'
      problem = undefined
      return
    }
    const dir = transcriptPath.slice(0, transcriptPath.lastIndexOf('/'))
    if (tokens === undefined || tokens === 'none' || tokens.dir !== dir) {
      const raw = await $.store.get(`tokens:${dir}`)
      const files: Record<string, Counted> = (typeof raw === 'object' && raw !== null ? (raw as Kept).files : undefined) ?? {}
      for (const c of Object.values(files)) c.ids ??= []
      const seen = new Set(Object.values(files).flatMap(c => c.ids))
      tokens = { dir, transcript: transcriptPath, files, seen, isCounted: false, isBehind: true, isDirty: false, isUpgrading: false }
      carry.clear()
    }
    const t = tokens
    t.transcript = transcriptPath
    let budget = TALLY_BUDGET
    let moved = false
    let isBehind = false
    let error: string | undefined
    let found: Awaited<ReturnType<typeof transcripts>>['found'] = []
    try {
      ;({ found, error } = await transcripts($, dir))
    } catch (err) {
      // the first session in a new project: Claude Code makes the folder with the first reply
      error = (await $.fs.exists(dir).catch(() => true)) ? `Can't read ${dir}: ${why(err)}` : undefined
    }
    // 0.2.0 kept no days. On a whole listing, a file still there is counted again from its start, every count of it
    // emptied and its ids out of `seen`, so nothing counts twice; a gone one keeps its counts with no days (Claude Code
    // deletes transcripts past cleanupPeriodDays, 30 by default, outside the day chart). Till the listing is whole, these
    // files are not read: a copy in a folder that won't list would hold ids its original needs. Nothing is saved till
    // the recount ends, so the 0.2.0 tally stays in the store through a quit or a read error.
    // ponytail: a reply copied from a parent 0.2.0 saw deleted (its ids dropped) into a file counted again counts once
    // more. No such parent in the stores at release (0 of 386 records gone); keep 0.2.0's ids of gone files if one shows
    const listed = new Set(found.map(f => f.path))
    const old = error === undefined ? Object.entries(t.files).filter(([, c]) => c.days === undefined) : []
    for (const [path, c] of old) {
      if (listed.has(path)) t.files[path] = { offset: 0, parts: [0, 0, 0, 0], months: {}, days: {}, ids: [] }
      else c.days = {}
      carry.delete(path)
      t.isDirty = true
    }
    if (old.some(([path]) => listed.has(path))) {
      t.seen = new Set(Object.values(t.files).flatMap(c => c.ids))
      t.isUpgrading = true
      t.isCounted = false
    }
    for (const { path, size } of found) {
      const c = t.files[path] ?? { offset: 0, parts: [0, 0, 0, 0], months: {}, days: {}, ids: [] }
      if (c.days === undefined) continue // 0.2.0's, waiting for a whole listing
      let pending = carry.get(path) ?? new Uint8Array(0)
      // a file shorter than what was read was rewritten: read again from its start, its counts kept; its ids skip the
      // rows already counted, so only new ones add
      if (size < c.offset + pending.length) {
        c.offset = 0
        c.ids = []
        pending = new Uint8Array(0)
      }
      let at = c.offset + pending.length
      while (at < size && budget > 0) {
        let chunk: Uint8Array
        try {
          const { base64 } = await $.fs.read(path, { as: 'bytes', offset: at, length: Math.min(READ_MAX, size - at, budget) })
          chunk = Uint8Array.fromBase64(base64)
        } catch (err) {
          error = `Can't read ${fileName(path)}: ${why(err)}`
          break
        }
        if (chunk.length === 0) break
        at += chunk.length
        budget -= chunk.length
        pending = join(pending, chunk)
        const used = countLines(pending, c, t.seen)
        if (used > 0) {
          c.offset += used
          pending = pending.slice(used)
          moved = true
        }
      }
      if (at < size && budget <= 0) isBehind = true
      t.files[path] = c
      if (pending.length > 0) carry.set(path, pending)
      else carry.delete(path)
    }
    // a deleted transcript keeps its counts, and its ids go, so the store holds only the ids on disk. Only after every
    // file is listed and read to its end: a copy that lands with its parent's deletion has its ids by then
    if (error === undefined && !isBehind) {
      const gone = Object.entries(t.files).filter(([path, c]) => !listed.has(path) && c.ids.length > 0)
      for (const [, c] of gone) c.ids = []
      if (gone.length > 0) {
        t.seen = new Set(Object.values(t.files).flatMap(c => c.ids))
        t.isDirty = true
      }
    }
    t.isBehind = isBehind
    if (t.isUpgrading && error === undefined && !isBehind) t.isUpgrading = false
    t.isCounted = t.isCounted || (!isBehind && !t.isUpgrading)
    t.isDirty = t.isDirty || moved
    if (t.isDirty && !t.isUpgrading) {
      // a failed save keeps the counts here and tries again next tally
      try {
        await $.store.set(`tokens:${dir}`, { files: t.files } satisfies Kept)
        t.isDirty = false
      } catch (err) {
        error ??= `Can't save tokens: ${why(err)}`
      }
    }
    problem = error
    const shown = `${t.transcript}|${t.isCounted}|${problem}`
    if (moved || shown !== drawn) $.ui.invalidate('ui.render')
    drawn = shown
  } catch (err) {
    // session.info or the store failed: the next tick tries again
    const shown = `Can't count tokens: ${why(err)}`
    if (shown !== problem) $.ui.invalidate('ui.render')
    problem = shown
  } finally {
    tallying = false
  }
}

/** This session's (its transcript and its subagents'), this month's and every kept file's tokens; each day's and month's. */
function tokenTotals(t: Tokens, now: number) {
  const files = Object.entries(t.files)
  const own = `${t.transcript.slice(0, -'.jsonl'.length)}/`
  const all = (c: Counted) => c.parts.reduce((a, b) => a + b, 0)
  const month = monthOf(now)
  const first = Math.min(...files.map(([, c]) => c.first ?? Number.POSITIVE_INFINITY))
  const sum = (by: (c: Counted) => Record<string, number> | undefined) => {
    const out: Record<string, number> = {}
    for (const [, c] of files) for (const [k, n] of Object.entries(by(c) ?? {})) out[k] = (out[k] ?? 0) + n
    return out
  }
  return {
    days: sum(c => c.days),
    months: sum(c => c.months),
    session: files.filter(([p]) => p === t.transcript || p.startsWith(own)).reduce((n, [, c]) => n + all(c), 0),
    month: files.reduce((n, [, c]) => n + (c.months[month] ?? 0), 0),
    total: files.reduce((n, [, c]) => n + all(c), 0),
    parts: [0, 1, 2, 3].map(i => files.reduce((n, [, c]) => n + (c.parts[i] ?? 0), 0)),
    first: Number.isFinite(first) ? first : undefined,
  }
}

const BLOCKS = ' ▁▂▃▄▅▆▇█'
const CHART_DAYS = 30
const CHART_MONTHS = 12

/**
 * The chart's 5 bar rows, top first: each value `round(value / max × 40)` eighths, one with any tokens at least `▁`,
 * `width` columns a bar and `gap` blank after it. `undefined` when every value is 0.
 */
function barRows(values: number[], width: number, gap: number) {
  const max = Math.max(...values)
  if (!(max > 0)) return undefined
  const eighths = values.map(v => (v > 0 ? Math.max(1, Math.round((v / max) * 40)) : 0))
  const rows = [4, 3, 2, 1, 0].map(r => eighths.map(e => (BLOCKS[Math.min(8, Math.max(0, e - r * 8))] ?? ' ').repeat(width) + ' '.repeat(gap)).join(''))
  return { rows, max }
}

/** The `n` local days (or months) ending on `now`'s, oldest first. */
const lastDays = (now: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(now)
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - (n - 1) + i)
    return d.getTime()
  })
const lastMonths = (now: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(now)
    d.setHours(12, 0, 0, 0)
    d.setDate(1)
    d.setMonth(d.getMonth() - (n - 1) + i)
    return d.getTime()
  })
const dayLabel = (at: number) => `${new Date(at).getDate()} ${MONTHS[new Date(at).getMonth()]?.slice(0, 3)}`

async function setChart($: EngineInterface, view: typeof chartView) {
  chartView = view
  $.ui.invalidate('ui.render')
  // a failed save still switches: this session keeps the choice
  await $.store.set('chart', view).catch(err => $.ui.log(`overview: chart choice not saved: ${why(err)}`, { to: 'debug' }))
}

const plan = atom({ plugin: 'plan-tracker', key: 'tracker' } as const, { nextId: 1, plans: [] } as Tracker)
const git = atom({ plugin: 'git-tracker', key: 'view' } as const, { branch: '', ahead: 0, behind: 0, graph: [], files: [] } as GitView)
// test-tracker keeps its view under shape 2; another shape reads as empty until this copy follows
const tests = atom({ plugin: 'test-tracker', key: 'view' } as const, { nextId: 1, runs: [], tcSeen: {}, last: {} } as View, { shape: '2' })

// ---- shared by two trackers -----------------------------------------------------------------------------------------

/** `45s`, `3m 05s`, `1h 02m`; never negative. */
function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  return s < 3600 ? `${Math.floor(s / 60)}m ${two(s % 60)}s` : `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`
}

const BAR = 10
const bar = (filled: number) => `${'▰'.repeat(filled)}${'▱'.repeat(BAR - filled)}`
/** A control character in a Text gets the whole pane refused. */
const printable = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

// ---- plan row (plan-tracker) ----------------------------------------------------------------------------------------

const PLAN_DOC = /\/docs\/superpowers\/plans\/[^/]+\.md$/
const SOURCES = [['docs', 'PLAN DOCS'], ['mode', 'PLAN MODE'], ['tasks', 'TASKS']] as const
const sourceOf = (p: PlanGroup) => (p.file === '' ? 'tasks' : PLAN_DOC.test(p.file) ? 'docs' : 'mode')
const PHASES: ReadonlyArray<readonly [Phase, string]> = [
  ['plan', 'Plan'], ['review', 'Codex review'], ['dev', 'Dev'], ['fixes', 'Review fixes'],
  ['test', 'Test'], ['verify', 'Codex verify'],
]
const isDone = (p: PlanGroup) => p.items.length > 0 && p.items.every(i => i.status === 'verified')
const isPlanning = (t: Tracker) => t.clock !== undefined && t.clock.group === undefined
const add = (times: Times | undefined, phase: Phase, ms: number): Times => ({ ...times, [phase]: (times?.[phase] ?? 0) + ms })
const sum = (times: Times) => PHASES.reduce((a, [p]) => a + (times[p] ?? 0), 0)
const verified = (items: PlanItem[]) => items.filter(i => i.status === 'verified').length

// ---- tests row (test-tracker) ---------------------------------------------------------------------------------------

const SCOPE_LABEL: Record<Scope, string> = { focused: 'Focused test', branch: 'Branch tests', full: 'Full suite' }
const LAST_ORDER: readonly Scope[] = ['full', 'branch', 'focused']
const TC_LINES = 8
const total = (c: Record<Status, number>) => c.pass + c.fail + c.skip
const took = (ms: number) => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : fmt(ms))

/** `45s`, `12m`, `3h`, `2d`: how long ago, at a glance. */
function ago(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}

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

/** How many tests the run should reach: the newest earlier finished run of the same command. */
function expectedOf(v: View, r: Run) {
  const prior = v.runs.find(o => o.id < r.id && typeof o.exit === 'number' && o.command === r.command)
  if (prior !== undefined) return total(prior.counts)
  const last = r.scope === undefined ? undefined : v.last[r.scope]
  return last !== undefined && last.id < r.id && typeof last.exit === 'number' && last.command === r.command ? total(last.counts) : undefined
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

/** Each TC's result in a run's rows: a TC fails when any of its rows fails. */
function tcResults(rows: TestRow[]) {
  const out: Record<string, Status> = {}
  for (const t of rows) {
    if (t.tc === undefined) continue
    const was = out[t.tc]
    out[t.tc] = was === 'fail' || t.status === 'fail' ? 'fail' : was === 'pass' || t.status === 'pass' ? 'pass' : 'skip'
  }
  return out
}

/** Each TC's newest result: the finished runs' kept results, the running runs' rows on top. */
function tcStatus(v: View) {
  const out: Record<string, Status> = {}
  for (const [tc, seen] of Object.entries(v.tcSeen)) out[tc] = seen.status
  for (const r of [...v.runs].reverse()) {
    if (r.exit !== undefined) continue
    for (const [tc, st] of Object.entries(tcResults(r.tests))) if (r.startedAt >= (v.tcSeen[tc]?.at ?? -Infinity)) out[tc] = st
  }
  return out
}

// ---- git row (git-tracker) ------------------------------------------------------------------------------------------

const PR_COLOR: Record<string, string> = { open: 'success', draft: 'inactive', merged: 'merged', closed: 'error' }

const OPEN = { id: PANE, title: 'Overview', columns: DOCK_COLUMNS } as const
// `focus` is the only open that raises a pane: one without it leaves the tab behind the last one opened (Features opens
// after every plugin below it has started). It also takes the keyboard at an empty prompt: letters still land there,
// but the first Up, Shift+Tab or Esc goes to the pane.
const RAISE = { ...OPEN, focus: true } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PANE, description: 'Open the Overview pane: plan, git and tests in one tab' })
    // a reload finds its pane still up (the engine's record): leave the tab the person is on
    // a failed lookup reads as not up: opening in front beats not opening
    const isUp = (await $.ui.panes().catch(() => [])).some(p => p.id === PANE)
    void $.ui.open(isUp ? OPEN : RAISE)
    void tally($)
    // a reload stops the old timer and runs this again; /clear keeps it
    $.clock.every(1_000, () => tick($))
    const saved = await $.store.get('chart').catch(() => undefined)
    if ((saved === 'days' || saved === 'months') && saved !== chartView) {
      chartView = saved
      $.ui.invalidate('ui.render') // the pane may have drawn Days already
    }
    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    const opened = await $.ui.open(RAISE)
    return { text: opened.isPlaced ? 'Overview pane opened.' : `Overview pane waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const t = await read($, plan)
    const g = await read($, git)
    const v = await read($, tests)
    const now = await $.clock.now()
    dayDrawn = dayOf(now)

    // ---- plan ----

    /** `times` with the running clock's live part added when `key` is the one it times. */
    const live = (key: string, times: Times | undefined): Times | undefined => {
      const c = t.clock
      const runs = c !== undefined && (c.group ?? 'pending') === key
      return runs ? add(times, c.phase, Math.max(0, now - c.since)) : times
    }

    /** One row per phase with time (`●` on the running one) and Total; nothing for a group never timed. */
    const phaseRows = (key: string, times: Times | undefined) => {
      const all = live(key, times)
      const running = t.clock !== undefined && (t.clock.group ?? 'pending') === key ? t.clock.phase : undefined
      if (!all || (sum(all) === 0 && running === undefined)) return null
      const rows = PHASES.filter(([p]) => (all[p] ?? 0) > 0 || p === running)
      return (
        <Box flexDirection="column" marginLeft={2}>
          {rows.map(([p, label]) => (
            <Box key={`plan:time:${key}:${p}`} flexDirection="row" gap={1}>
              <Box flexGrow={1}>
                <Text dimColor={p !== running} wrap="truncate">{label}</Text>
              </Box>
              {p === running && <Text color="success">●</Text>}
              <Text dimColor={p !== running}>{fmt(all[p] ?? 0)}</Text>
            </Box>
          ))}
          <Box key={`plan:time:${key}:total`} flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text bold>Total</Text>
            </Box>
            <Text bold>{fmt(sum(all))}</Text>
          </Box>
        </Box>
      )
    }

    const group = (p: PlanGroup, n: number) => {
      const ok = verified(p.items)
      const spent = sum(live(p.id, p.time) ?? {})
      if (isDone(p)) {
        return (
          <Box key={`plan:head:${p.id}`} flexDirection="row" gap={1} marginLeft={2} marginTop={n > 0 ? 1 : 0}>
            <Box flexGrow={1}>
              <Text dimColor wrap="truncate">{`✓ ${printable(p.title)}`}</Text>
            </Box>
            {/* never squeezed onto a second line by a long title */}
            <Box flexShrink={0}>
              <Text dimColor>{`${ok}/${p.items.length}${spent > 0 ? ` ${fmt(spent)}` : ''}`}</Text>
            </Box>
          </Box>
        )
      }
      const filled = p.items.length ? Math.round((ok / p.items.length) * BAR) : 0
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={n > 0 ? 1 : 0}>
          <Box key={`plan:head:${p.id}`} flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text bold wrap="truncate">{printable(p.title)}</Text>
            </Box>
            <Text dimColor>{`${bar(filled)} ${ok}/${p.items.length}`}</Text>
          </Box>
          {phaseRows(p.id, p.time)}
          {p.note !== undefined && (
            <Box key={`plan:note:${p.id}`}>
              <Text dimColor wrap="truncate">{printable(p.note)}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const planRow = (
      <Box key="plan" flexDirection="column" gap={1}>
        {t.plans.length === 0 && (
          <Box key="plan:title">
            <Text bold color={TITLE.plan}>PLAN</Text>
          </Box>
        )}
        {isPlanning(t) && (
          <Box key="plan:pending" flexDirection="column">
            <Text bold>Planning (not approved yet)</Text>
            {phaseRows('pending', t.pending)}
          </Box>
        )}
        {t.plans.length === 0 && (
          <Box key="plan:empty">
            <Text dimColor>No plan tracked yet.</Text>
          </Box>
        )}
        {SOURCES.map(([source, label]) => {
          // the latest group only: plan-tracker puts a new one first, but the same plan approved again keeps its old
          // place and the clock runs on it, so the clock's group wins
          const all = t.plans.filter(p => sourceOf(p) === source)
          const shown = all.find(p => p.id === t.clock?.group) ?? all[0]
          if (shown === undefined) return null
          const plans = [shown]
          const items = plans.flatMap(p => p.items)
          return (
            <Box flexDirection="column">
              <Box key={`plan:section:${source}`} flexDirection="row" gap={1} marginBottom={1}>
                <Box flexGrow={1}>
                  <Text bold color={TITLE.plan}>{label}</Text>
                </Box>
                <Text dimColor>{`${verified(items)}/${items.length}`}</Text>
              </Box>
              {plans.map(group)}
            </Box>
          )
        })}
      </Box>
    )

    // ---- git ----

    // `+40 −12`, `+3`, `bin`: one Text, its parts colored
    const stat = (f: { added: number; removed: number; isBinary?: boolean }) =>
      f.isBinary ? (
        <Text dimColor>bin</Text>
      ) : (
        <Text>
          {(f.added > 0 || f.removed === 0) && <Text color="success">{`+${f.added}`}</Text>}
          {f.added > 0 && f.removed > 0 && ' '}
          {f.removed > 0 && <Text color="error">{`−${f.removed}`}</Text>}
        </Text>
      )

    /** `CHANGED 2  +20 −3`: the count and the line totals, no file rows. */
    const totals = (id: string, label: string, color: string, files: GitView['files']) =>
      files.length > 0 && (
        <Box key={`git:${id}`} flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Text bold color={color}>{`${label} ${files.length}`}</Text>
          </Box>
          {stat({ added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) })}
        </Box>
      )

    const prState = g.pr === undefined ? '' : g.pr.isDraft ? 'draft' : g.pr.state.toLowerCase()
    const gitBody =
      g.error !== undefined || g.branch === '' ? (
        <Box key="git:empty">
          <Text dimColor>{g.error ?? 'Reading git…'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box key="git:head">
            <Text bold wrap="truncate">
              <Text color="suggestion">{g.branch}</Text>
              {g.parent !== undefined && (
                <Text>
                  <Text dimColor>{' ← '}</Text>
                  <Text color="merged">{g.parent}</Text>
                  {'  '}
                  <Text color="success" dimColor={g.ahead === 0}>{`${g.ahead}↑`}</Text>
                  {' '}
                  <Text color="warning" dimColor={g.behind === 0}>{`${g.behind}↓`}</Text>
                </Text>
              )}
            </Text>
          </Box>
          {g.pr !== undefined && (
            <Box key="git:pr" flexDirection="column">
              <Text bold>
                {`PR #${g.pr.number} `}
                <Text color={PR_COLOR[prState] ?? 'text'}>{prState}</Text>
              </Text>
              <Link href={g.pr.url} />
            </Box>
          )}
          {g.files.length === 0 && (
            <Box key="git:none">
              <Text dimColor>{`No changes since ${g.parent ?? 'HEAD'}.`}</Text>
            </Box>
          )}
          {totals('changed', 'CHANGED', 'warning', g.files.filter(f => !f.isNew))}
          {totals('new', 'NEW', 'success', g.files.filter(f => f.isNew))}
        </Box>
      )

    const gitRow = (
      <Box key="git" flexDirection="column">
        <Box key="git:title" marginBottom={1}>
          <Text bold color={TITLE.git}>GIT</Text>
        </Box>
        {gitBody}
      </Box>
    )

    // ---- tests ----

    const tcs = v.branch?.tcs ?? []
    const testsTitle = (
      <Box key="tests:title" marginBottom={1}>
        <Text bold color={TITLE.tests}>TESTS</Text>
      </Box>
    )

    const testsRow = (() => {
      if (v.runs.length === 0 && tcs.length === 0) {
        return (
          <Box key="tests" flexDirection="column">
            {testsTitle}
            <Box key="tests:empty">
              <Text dimColor>No test runs yet.</Text>
            </Box>
          </Box>
        )
      }

      /** `✓ n  ✗ m  ○ k   what it is doing`, the card's run line. */
      const runStat = (r: Run) => (
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
      for (const tc of tcs) {
        const st = status[tc.id]
        if (st !== undefined) tally[st] += 1
      }
      const notRun = tcs.length - total(tally)
      const tcLines = [
        ...tcs.filter(tc => status[tc.id] === 'fail').map(tc => ({ id: tc.id, text: `✗ ${tc.id} ${tc.feature}`, isFail: true })),
        ...tcs.filter(tc => status[tc.id] === undefined).map(tc => ({ id: tc.id, text: `· ${tc.id} ${tc.feature}${tc.isManual ? ' (manual)' : ''}`, isFail: false })),
      ]
      const lasts = LAST_ORDER.flatMap(sc => {
        const l = v.last[sc]
        return l === undefined ? [] : [{ sc, l }]
      })

      return (
        <Box key="tests" flexDirection="column">
          {testsTitle}
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
              {cr !== undefined && <Box key="card:stat">{runStat(cr)}</Box>}
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
                        <Text dimColor>
                          {` ${l.counts.pass}/${l.counts.pass + l.counts.fail}${l.counts.skip > 0 ? `  ○ ${l.counts.skip}` : ''}   ${ago(now - l.endedAt)} ago`}
                        </Text>
                      </Text>
                    </Box>
                  )
                })}
              </Box>
            )}
          </Box>
        </Box>
      )
    })()

    /** A dim rule the pane's full width, between two rows, a blank line each side. */
    const divider = (id: string) => (
      <Box key={`divider:${id}`} marginY={1}>
        <Text dimColor>{'─'.repeat(e.props.bodyColumns)}</Text>
      </Box>
    )

    // ---- tokens ----

    const tokenLine = (key: string, label: string, value: string) => (
      <Box key={`tokens:${key}`} flexDirection="row" gap={1}>
        <Box flexGrow={1}>
          <Text wrap="truncate">{label}</Text>
        </Box>
        <Text>{value}</Text>
      </Box>
    )
    const tokenCounts = () => {
      if (tokens === 'none' || tokens === undefined || !tokens.isCounted) {
        return (
          <Box key="tokens:empty">
            <Text dimColor>{tokens === 'none' ? 'No transcript to count.' : 'Counting tokens…'}</Text>
          </Box>
        )
      }
      const n = tokenTotals(tokens, now)
      const since = n.first === undefined ? 'Total' : `Since ${dayLabel(n.first)}`
      const [, out = 0, write = 0, cached = 0] = n.parts
      return (
        <Box flexDirection="column">
          {tokenLine('session', 'This session', fmtTokens(n.session))}
          {tokenLine('month', MONTHS[new Date(now).getMonth()] ?? 'This month', fmtTokens(n.month))}
          {tokenLine('since', since, fmtTokens(n.total))}
          <Box key="tokens:parts">
            <Text dimColor wrap="truncate">{`out ${fmtTokens(out)} · cache ${fmtTokens(write)} write + ${fmtTokens(cached)} read`}</Text>
          </Box>
          {chart(n)}
        </Box>
      )
    }
    /**
     * Days: the last 30 days, one column each; Months: the last 12, 2 columns and a gap each. Fewer in a narrow pane,
     * every row inside it (the widest axis label is 6); none under 20 columns.
     */
    const chart = (n: ReturnType<typeof tokenTotals>) => {
      const cols = e.props.bodyColumns
      if (cols < 20) return null
      const isDays = chartView === 'days'
      const fit = (count: number) => {
        const slots = isDays ? lastDays(now, count) : lastMonths(now, count)
        const bars = isDays ? barRows(slots.map(at => n.days[dayOf(at)] ?? 0), 1, 0) : barRows(slots.map(at => n.months[monthOf(at)] ?? 0), 2, 1)
        return { count, slots, bars, over: bars === undefined ? 0 : count * (isDays ? 1 : 3) + 2 + fmtTokens(bars.max).length - cols }
      }
      // 8 columns kept for the axis: 2 + the widest label under 100B (6). A bigger peak gives up the columns it needs
      // once: the smaller window's peak is no higher, so its label is no wider
      let drawn = fit(isDays ? Math.min(CHART_DAYS, cols - 8) : Math.min(CHART_MONTHS, Math.floor((cols - 8) / 3)))
      if (drawn.over > 0) drawn = fit(drawn.count - (isDays ? drawn.over : Math.ceil(drawn.over / 3)))
      const { count, slots, bars } = drawn
      const first = dayLabel(slots[0] ?? now)
      const today = dayLabel(now)
      const labels = !isDays
        ? slots.map(at => MONTHS[new Date(at).getMonth()]?.[0] ?? '').join('  ')
        : count < 13
          ? today.padStart(count)
          : `${first}${' '.repeat(count - first.length - today.length)}${today}`
      return (
        <Box key="tokens:chart" flexDirection="column" marginTop={1}>
          <Box key="tokens:view" flexDirection="row" gap={2}>
            {(['days', 'months'] as const).map(view => (
              <Button key={`tokens:view:${view}`} plain dimColor={chartView !== view} onPress={() => setChart($, view)}>
                <Text bold={chartView === view} color={chartView === view ? TITLE.tokens : undefined}>
                  {view === 'days' ? 'Days' : 'Months'}
                </Text>
              </Button>
            ))}
          </Box>
          {bars === undefined ? (
            <Box key="tokens:chart:empty">
              <Text dimColor wrap="truncate">{`No tokens in the last ${count} ${isDays ? 'days' : 'months'}.`}</Text>
            </Box>
          ) : (
            [
              ...bars.rows.map((row, i) => (
                <Box key={`tokens:chart:${i + 1}`} flexDirection="row">
                  <Text color={TITLE.tokens}>{row}</Text>
                  {i === 0 && <Text dimColor>{`  ${fmtTokens(bars.max)}`}</Text>}
                  {i === 4 && <Text dimColor>{'  0'}</Text>}
                </Box>
              )),
              <Box key="tokens:chart:labels">
                <Text dimColor>{labels}</Text>
              </Box>,
            ]
          )}
        </Box>
      )
    }
    const tokensRow = (
      <Box key="tokens" flexDirection="column">
        <Box key="tokens:title" marginBottom={1}>
          <Text bold color={TITLE.tokens}>TOKENS</Text>
        </Box>
        {tokenCounts()}
        {problem !== undefined && (
          <Box key="tokens:error">
            <Text dimColor wrap="truncate">{printable(problem)}</Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {planRow}
        {divider('git')}
        {gitRow}
        {divider('tests')}
        {testsRow}
        {divider('tokens')}
        {tokensRow}
      </Box>
    )
  })
}
