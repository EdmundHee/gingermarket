import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PluginState, ShapedValue } from 'claude-code'

type Tracker = PluginState['plan-tracker']['tracker']
type PlanItem = Tracker['plans'][number]['items'][number]
type GitView = PluginState['git-tracker']['view']
type TestView = ShapedValue<PluginState['test-tracker']['view']>
type Run = TestView['runs'][number]

const CWD = '/repo'
const T = Date.UTC(2026, 10, 23, 10, 0, 0)
const PANE = {
  title: 'Overview', isFocused: false, bodyColumns: 48, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 80 }, view: {},
}
const PLAN_FILE = '/home/u/.claude/plans/overview.md'
const NOTE = '#298 #304 need you; press ▶ or ✓'
const COMMAND = 'claude plugin test overview'

/**
 * What each tracker holds, read at call time so a test may swap it; a missing one was never written. `transcript`:
 * `$.session.info().transcriptPath` (empty: none kept). `files`: the transcripts on disk by absolute path, read at
 * call time so a test may grow one; `deny`: paths whose read or listing fails; `links`: paths listed as symbolic links;
 * `mtimes`: a file's last write (else 0). `store`: overview's store at start; `storeFails`: which store call fails, read
 * at call time. `panes`: the ids `$.ui.panes()` lists.
 */
type Seed = {
  tracker?: Tracker
  git?: GitView
  tests?: { shape: string; value: TestView }
  transcript?: string
  files?: Record<string, string>
  deny?: string[]
  links?: string[]
  mtimes?: Record<string, number>
  store?: Record<string, unknown>
  storeFails?: 'get' | 'set'
  panes?: string[]
}

const items = (n: number, verified: number): PlanItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `item ${i + 1}`, status: i < verified ? 'verified' : 'open' }))

/** One plan-mode group `p1` whose clock runs `dev` since `since`, with the screenshot's phase times. */
const planning = (since: number, extra: Partial<Tracker> = {}): Tracker => ({
  nextId: 45,
  plans: [{
    // a control character in a Text gets the whole pane refused: a typed title can hold one, a sonnet note too
    id: 'p1', title: 'plan-tracker 0.4.9: fewer rounds\u0007 to get items verified', file: PLAN_FILE, approvedAt: '2026-11-22',
    items: items(44, 42), note: `${NOTE}\u001b`,
    time: { plan: 580_000, review: 44_000, dev: 112_000, test: 406_000, verify: 533_000 },
  }],
  clock: { group: 'p1', phase: 'dev', since, session: 's1' },
  ...extra,
})

const changed = (path: string, added: number, removed: number) => ({ path, added, removed, isNew: false, isBinary: false })
const added = (path: string, n: number) => ({ path, added: n, removed: 0, isNew: true, isBinary: false })

const GIT: GitView = {
  branch: 'feat/x', parent: 'main', ahead: 2, behind: 1,
  graph: ['* 3e1c2aa (HEAD -> feat/x) feat: pane'],
  files: [changed('src/a.ts', 12, 3), changed('src/b.ts', 8, 0), added('src/c.ts', 400), added('src/d.ts', 12), added('src/e.ts', 0)],
  pr: { number: 21, url: 'https://github.com/o/r/pull/21', state: 'OPEN', isDraft: false },
}

const counts = (pass: number, fail: number, skip = 0) => ({ pass, fail, skip })
const rows = (pass: number, fail: number) => [
  ...Array.from({ length: pass }, (_, i) => ({ name: `ok_${i}`, status: 'pass' as const })),
  ...Array.from({ length: fail }, (_, i) => ({ name: `bad_${i}`, status: 'fail' as const })),
]
const tcs = ['TC-401', 'TC-402', 'TC-403', 'TC-404', 'TC-405', 'TC-406'].map(id => ({ id, feature: `f ${id}`, isManual: false }))

/** A branch run running for 8 s (11 pass, 1 fail), after a finished run of the same command with 14 tests. */
const TESTS: TestView = {
  nextId: 3,
  runs: [
    // its failing row is TC-404's: newer than TC-404's stored pass, so it wins
    { id: 2, source: 'tool', command: COMMAND, scope: 'branch', startedAt: T - 8_000, tests: [...rows(11, 0), { name: 'bad_404', status: 'fail', tc: 'TC-404' }], counts: counts(11, 1), now: 'overview pane renders' },
    { id: 1, source: 'tool', command: COMMAND, scope: 'branch', startedAt: T - 3_700_000, endedAt: T - 3_600_000, exit: 0, tests: rows(14, 0), counts: counts(14, 0) },
  ],
  branch: { name: 'feat/x', tcs },
  tcSeen: {
    'TC-401': { status: 'pass', at: T - 3_700_000 }, 'TC-402': { status: 'pass', at: T - 3_700_000 },
    'TC-403': { status: 'pass', at: T - 3_700_000 }, 'TC-404': { status: 'pass', at: T - 3_700_000 },
    'TC-405': { status: 'fail', at: T - 3_700_000 },
  },
  last: {
    full: { id: 0, command: 'run line', counts: counts(118, 0), exit: 0, endedAt: T - 3_600_000 },
    branch: { id: 1, command: COMMAND, counts: counts(52, 1), exit: 1, endedAt: T - 120_000 },
  },
}

const shaped = (value: TestView, shape = '2') => ({ shape, value })

const MiB = 1024 * 1024
// s1's row at noon UTC is 8 October in most zones, the 7th or 9th in a few: the runtime's own day
const S1_DAY = new Date('2026-10-08T12:00:00Z').getDate()
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad2 = (n: number) => String(n).padStart(2, '0')
/** The runtime's local day of `at`, as the store keys it. */
const dayKey = (at: string | number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
/** The `n` local days ending on `now`'s, oldest first, each at noon. */
const lastDays = (now: number, n = 30) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(now)
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - (n - 1) + i)
    return d
  })
/** The column of `at`'s local day in the day chart ending on `now`'s day; -1 outside it. */
const colOf = (now: number, at: string | number, n = 30) => lastDays(now, n).findIndex(d => dayKey(d.getTime()) === dayKey(at))
/** A day `back` days before T's, at local noon, as a transcript timestamp. */
const daysBack = (back: number) => lastDays(T, back + 1)[0]?.toISOString() ?? ''
const dayLabel = (d: Date) => `${d.getDate()} ${MON[d.getMonth()]}`
/** The mod's 32-bit FNV-1a hash of a message id, as it stores them (to seed a 0.2.0 tally with real ids). */
const idHash = (id: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return h >>> 0
}
/** One chart row: `cells` (column → character) over `width` blank columns. */
const bars = (width: number, cells: Record<number, string>) => Array.from({ length: width }, (_, i) => cells[i] ?? ' ').join('')
/** One assistant row of a transcript, `[input, output, cache write, cache read]` tokens. */
const usage = (id: string, at: string, [i, o, w, r]: [number, number, number, number], text = 'ok') =>
  JSON.stringify({
    type: 'assistant', timestamp: at,
    message: { id, content: [{ type: 'text', text }], usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: w, cache_read_input_tokens: r } },
  })
// s2: a user row, b twice (one message, two rows), a broken line, an assistant row with null usage, c with multi-byte
// text, then d with no end yet
const S2_DONE = [
  JSON.stringify({ type: 'user', timestamp: '2026-11-20T11:00:00Z', message: { content: 'hi' } }),
  usage('b', '2026-11-20T12:00:00Z', [2, 20, 200, 2000]),
  usage('b', '2026-11-20T12:00:00Z', [2, 20, 200, 2000]),
  'not json {',
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-20T12:01:00Z', message: { id: 'n', content: [], usage: null } }),
  usage('c', '2026-11-20T12:05:00Z', [3, 30, 300, 3000], 'café ✓ 日本'),
].map(l => `${l}\n`).join('')
const S2_CUT = usage('d', '2026-11-20T12:10:00Z', [4, 40, 400, 4000])
/** A project folder `/p`: s1 (October), s2 (this session, November) and s2's subagent a1. */
const TRANSCRIPTS = (): Seed => ({
  transcript: '/p/s2.jsonl',
  files: {
    '/p/s1.jsonl': `${usage('a', '2026-10-08T12:00:00Z', [1, 10, 100, 1000])}\n`,
    '/p/s2.jsonl': S2_DONE + S2_CUT,
    '/p/s2/subagents/a1.jsonl': `${usage('e', '2026-11-21T12:00:00Z', [5, 50, 500, 5000])}\n`,
  },
})

type KeptFiles = {
  files: Record<string, { parts: number[]; ids: number[]; months?: Record<string, number>; days?: Record<string, number>; monthParts?: Record<string, number[]> }>
}

function setup(on: On, seed: Seed) {
  const clock = mock.clock(on)
  const seen = {
    clock, opened: [] as { id: string; title?: string; columns?: number; focus?: true }[], commands: [] as string[],
    sets: [] as string[], invalidates: 0, reads: [] as { path: string; offset: number; length?: number }[],
    stores: [] as { key: string; value: KeptFiles }[],
  }
  // overview's store, each write recorded as written (a copy), and failed when the seed says so
  const store = new Map(Object.entries(seed.store ?? {}))
  on('store.get', (_$, e) => (seed.storeFails === 'get' ? { deny: 'EIO: store unreadable' } : { value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.stores.push({ key: e.key, value: JSON.parse(JSON.stringify(e.value)) })
    if (seed.storeFails === 'set') return { deny: 'EDQUOT: store full' }
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: (seed.panes ?? []).map(id => ({ id, title: id, isShown: false, isFocused: false, isPlaced: true })) }))
  on('session.info', () => ({
    value: { transcriptPath: seed.transcript ?? '', sysname: 'Darwin', release: '25', machine: 'arm64', packageManagers: [], runtimes: [] },
  }))
  // a byte-true disk: sizes in UTF-8 bytes, reads cut to their range, folders listed as `dir`, entries by name
  const bytes = (path: string) => new TextEncoder().encode(seed.files?.[path] ?? '')
  on('fs.exists', (_$, e) => ({ value: Object.keys(seed.files ?? {}).some(k => k === e.path || k.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$, e) => {
    if (seed.deny?.includes(e.path)) return { deny: `EACCES: ${e.path}` }
    const pre = `${e.path}/`
    const entries = new Map<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const path of Object.keys(seed.files ?? {}).filter(k => k.startsWith(pre))) {
      const [name, ...rest] = path.slice(pre.length).split('/')
      entries.set(
        name,
        rest.length ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        : seed.links?.includes(path) ? { name, kind: 'other', size: 0, mtimeMs: 0, isLink: true }
        : { name, kind: 'file', size: bytes(path).length, mtimeMs: seed.mtimes?.[path] ?? 0, isLink: false },
      )
    }
    const listed = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return listed.length ? { value: listed } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_$, e) => {
    seen.reads.push({ path: e.path, offset: e.offset ?? 0, length: e.length })
    if (seed.files?.[e.path] === undefined || seed.deny?.includes(e.path)) return { deny: `EACCES: ${e.path}` }
    const from = e.offset ?? 0
    const part = bytes(e.path).subarray(from, e.length === undefined ? undefined : from + e.length)
    return { value: e.as === 'bytes' ? { base64: part.toBase64() } : new TextDecoder().decode(part) }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e)
    return { value: { isPlaced: true as const } }
  })
  // counts, then passes on: the kit's own bottom is what draws a mounted pane again
  on('ui.invalidate', (_$, e, next) => {
    seen.invalidates += 1
    return next(e)
  })
  on('state.set', (_$, e, next) => {
    seen.sets.push(`${e.plugin}.${e.key}`)
    return next(e)
  })
  on('state.get', (_$, e, next) => {
    const value =
      e.plugin === 'plan-tracker' && e.key === 'tracker' ? seed.tracker
      : e.plugin === 'git-tracker' && e.key === 'view' ? seed.git
      : e.plugin === 'test-tracker' && e.key === 'view' ? seed.tests
      : undefined
    return value === undefined ? next(e) : { value: { value, version: 1 } }
  })
  return seen
}

async function start($: Engine, on: On, seed: Seed = {}) {
  const seen = setup(on, seed)
  await seen.clock.set(T)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  return seen
}

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'overview', surface: 'terminal', component: 'Pane', requestId: 'overview', props: PANE })

type Pane = Awaited<ReturnType<typeof mount>>
const textOf = async (pane: Pane, key: string) => (await pane.find({ key }))?.text ?? ''
/** A count row's label and total, as the narrow pane's lines read: `This session11.1K`. */
const line = async (pane: Pane, row: string) =>
  `${(await textOf(pane, `tokens:${row}:label`)).trim()}${(await textOf(pane, `tokens:${row}:total`)).trim()}`
/** A table row's in, out, cache and total cells as drawn (padded). */
const cells = (pane: Pane, row: string) => Promise.all(['in', 'out', 'cache', 'total'].map(c => textOf(pane, `tokens:${row}:${c}`)))
/** The chart's 8 bar rows, top first, each with its axis label. */
const chartRows = (pane: Pane) => Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(r => textOf(pane, `tokens:chart:${r}`)))
/**
 * The chart's bars in a `cols`-wide pane, as the plan lays them out: `count` bars spread over `cols − 8`, bar `i` from
 * column `floor(i × width / count)`, one column short of its share (days at least 1 wide, months 2).
 */
const layout = (cols: number, isDays = true) => {
  const width = cols - 8
  const count = isDays ? Math.min(30, Math.floor(width / 2)) : Math.min(12, Math.floor(width / 3))
  const bar = Math.max(isDays ? 1 : 2, Math.floor(width / count) - 1)
  return { width, count, bar, start: (i: number) => Math.floor((i * width) / count) }
}
/** One chart row in a `cols`-wide pane: slot → its character, the bar's width each. */
const chartRow = (cols: number, slots: Record<number, string>, isDays = true) => {
  const { width, bar, start } = layout(cols, isDays)
  const cells: Record<number, string> = {}
  for (const [slot, ch] of Object.entries(slots)) for (let x = 0; x < bar; x++) cells[start(Number(slot)) + x] = ch
  return bars(width, cells)
}
/** One day chart row in a `cols`-wide pane ending on `now`'s day: each timestamp's day drawn as its character. */
const dayRow = (cols: number, now: number, days: [string, string][]) =>
  chartRow(cols, Object.fromEntries(days.map(([at, ch]) => [colOf(now, at, layout(cols).count), ch])))
/** The month chart's names for the months ending `now`'s: 3 letters under each bar when every slot has 4 columns. */
const monthLabels = (now: number, cols = 48) => {
  const { width, count, start } = layout(cols, false)
  const line = Array.from({ length: width }, () => ' ')
  for (let i = 0; i < count; i++) {
    const d = new Date(now)
    d.setDate(1)
    d.setMonth(d.getMonth() - (count - 1) + i)
    const name = MON[d.getMonth()] ?? ''
    ;[...(Math.floor(width / count) >= 4 ? name : name.slice(0, 1))].forEach((ch, j) => {
      line[start(i) + j] = ch
    })
  }
  return line.join('').trimEnd()
}
/** The day labels in a `cols`-wide pane ending on `now`'s day: the first day, and today ending under the last bar. */
const dayLabels = (cols: number, now: number) => {
  const { count, bar, start } = layout(cols)
  const end = start(count - 1) + bar
  const first = dayLabel(lastDays(now, count)[0] as Date)
  const today = dayLabel(new Date(now))
  return first.length + 1 + today.length > end ? today.padStart(end) : `${first}${' '.repeat(end - first.length - today.length)}${today}`
}
/** Each run of drawn columns in a chart row: where it starts and how wide it is. */
const runs = (row: string) => [...row.matchAll(/[^ ]+/g)].map(m => ({ at: m.index ?? 0, width: m[0].length }))
const keys = async (pane: Pane) => (await pane.findAll({ type: 'Box' })).map(b => b.key ?? '')
const color = async (pane: Pane, text: RegExp) => (await pane.find({ type: 'Text', text }))?.props.color

describe('overview', () => {
  test('session_start_opens_overview_tab', async ($, on) => {
    const seen = await start($, on)

    expect(seen.opened).toHaveLength(1)
    expect(seen.opened[0]).toMatchObject({ id: 'overview', title: 'Overview', columns: 48, focus: true })
    expect(seen.commands).toContain('overview')
  })

  test('reload_opens_without_focus', async ($, on) => {
    const seen = await start($, on, { panes: ['overview'] })

    expect(seen.opened).toHaveLength(1)
    expect(seen.opened[0]).toMatchObject({ id: 'overview', title: 'Overview', columns: 48 })
    expect(seen.opened[0]?.focus).toBeUndefined()
  })

  test('command_reopens_overview_tab', async ($, on) => {
    const seen = await start($, on, { panes: ['overview'] })
    seen.opened.length = 0

    const ran = await $.command.run({
      command: 'overview', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 },
    })

    expect(seen.opened).toHaveLength(1)
    expect(seen.opened[0]).toMatchObject({ id: 'overview', title: 'Overview', columns: 48, focus: true })
    expect(ran).toMatchObject({ text: 'Overview pane opened.' })
  })

  test('empty_trackers_show_empty_lines', async ($, on) => {
    await start($, on)

    const pane = await mount($)

    const titles = (await keys(pane)).filter(k => k.endsWith(':title'))
    expect(titles).toEqual(['plan:title', 'git:title', 'tests:title', 'tokens:title'])
    expect(await textOf(pane, 'plan:title')).toBe('PLAN')
    expect(await textOf(pane, 'plan:empty')).toBe('No plan tracked yet.')
    expect(await textOf(pane, 'git:title')).toBe('GIT')
    expect(await textOf(pane, 'git:empty')).toBe('Reading git…')
    expect(await textOf(pane, 'tests:title')).toBe('TESTS')
    expect(await textOf(pane, 'tests:empty')).toBe('No test runs yet.')
    expect(await textOf(pane, 'tokens:title')).toBe('TOKENS')
    expect(await textOf(pane, 'tokens:empty')).toBe('No transcript to count.')
    expect(await pane.find({ key: 'tokens:session' })).toBeUndefined()
    expect(await pane.find({ key: 'tokens:since' })).toBeUndefined()
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test('plan_row_matches_plan_tracker_collapsed_group', async ($, on) => {
    const seen = await start($, on, { tracker: planning(T - 30_000) })

    const pane = await mount($)

    expect(await textOf(pane, 'plan:section:mode')).toContain('PLAN MODE')
    expect(await textOf(pane, 'plan:section:mode')).toContain('42/44')
    expect(await textOf(pane, 'plan:head:p1')).toContain('plan-tracker 0.4.9: fewer rounds to get items verified')
    expect(await textOf(pane, 'plan:head:p1')).toContain('▰▰▰▰▰▰▰▰▰▰ 42/44')
    const phases = (await keys(pane)).filter(k => k.startsWith('plan:time:p1:'))
    expect(phases).toEqual(['plan:time:p1:plan', 'plan:time:p1:review', 'plan:time:p1:dev', 'plan:time:p1:test', 'plan:time:p1:verify', 'plan:time:p1:total'])
    expect(await textOf(pane, 'plan:time:p1:plan')).toBe('Plan9m 40s')
    expect(await textOf(pane, 'plan:time:p1:review')).toBe('Codex review44s')
    expect(await textOf(pane, 'plan:time:p1:dev')).toBe('Dev●2m 22s') // 1m 52s + the live 30 s
    expect(await textOf(pane, 'plan:time:p1:test')).toBe('Test6m 46s')
    expect(await textOf(pane, 'plan:time:p1:verify')).toBe('Codex verify8m 53s')
    expect(await textOf(pane, 'plan:time:p1:total')).toContain('28m 25s')
    expect(await textOf(pane, 'plan:note:p1')).toBe(NOTE)
    expect(await pane.find({ type: 'Text', text: /item 1\b/ })).toBeUndefined()
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(0)
    expect(seen.sets).toEqual([])
  })

  test('plan_row_done_group_and_pending_planning', async ($, on) => {
    const tracker: Tracker = {
      nextId: 9,
      plans: [{ id: 'p2', title: 'Shipped thing', file: PLAN_FILE, approvedAt: '2026-11-20', items: items(8, 8), time: { dev: 1_677_000 } }],
      pending: { plan: 60_000 },
      clock: { phase: 'plan', since: T - 5_000, session: 's1' },
    }
    await start($, on, { tracker })

    const pane = await mount($)

    expect(await textOf(pane, 'plan:head:p2')).toContain('✓ Shipped thing')
    expect(await textOf(pane, 'plan:head:p2')).toContain('8/8 27m 57s')
    expect(await textOf(pane, 'plan:pending')).toContain('Planning (not approved yet)')
    expect(await textOf(pane, 'plan:time:pending:plan')).toBe('Plan●1m 05s') // 60 s stored + the live 5 s
  })

  test('git_row_branch_pr_and_totals', async ($, on) => {
    await start($, on, { git: GIT })

    const pane = await mount($)

    expect(await textOf(pane, 'git:title')).toBe('GIT')
    expect(await textOf(pane, 'git:head')).toBe('feat/x ← main  2↑ 1↓')
    expect(await textOf(pane, 'git:pr')).toContain('PR #21 open')
    expect((await pane.find({ type: 'Link' }))?.props.href).toBe(GIT.pr?.url)
    expect(await textOf(pane, 'git:changed')).toContain('CHANGED 2')
    expect(await textOf(pane, 'git:changed')).toContain('+20 −3')
    expect(await textOf(pane, 'git:new')).toContain('NEW 3')
    expect(await textOf(pane, 'git:new')).toContain('+412')
    expect(await color(pane, /^open$/)).toBe('success')
    expect(await pane.find({ type: 'Text', text: /src\// })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /3e1c2aa/ })).toBeUndefined()
  })

  test('git_row_error_no_changes_and_draft_pr', async ($, on) => {
    const seed: Seed = { git: { ...GIT, error: 'not a git repository' } }
    await start($, on, seed)
    const pane = await mount($)
    const error = await textOf(pane, 'git:empty')

    seed.git = { ...GIT, files: [] }
    await pane.redraw()
    const none = await textOf(pane, 'git:none')
    const openPr = await textOf(pane, 'git:pr')
    seed.git = { ...GIT, pr: { number: 21, url: 'https://github.com/o/r/pull/21', state: 'OPEN', isDraft: true } }
    await pane.redraw()

    expect(error).toBe('not a git repository')
    expect(none).toBe('No changes since main.')
    expect(openPr).toContain('PR #21 open')
    expect(await textOf(pane, 'git:pr')).toContain('PR #21 draft')
    expect(await textOf(pane, 'git:changed')).toContain('CHANGED 2')
  })

  test('tests_row_is_test_tracker_card', async ($, on) => {
    await start($, on, { tests: shaped(TESTS) })

    const pane = await mount($)

    expect(await textOf(pane, 'tests:title')).toBe('TESTS')
    expect(await textOf(pane, 'card:head')).toBe('feat/x · Branch tests')
    expect(await textOf(pane, 'card:bar')).toBe('▰▰▰▰▰▰▰▰▰▱ 12/14 · 8s')
    expect(await textOf(pane, 'card:stat')).toContain('✓ 11')
    expect(await textOf(pane, 'card:stat')).toContain('✗ 1')
    expect(await textOf(pane, 'card:stat')).toContain('now: overview pane renders')
    expect(await textOf(pane, 'card:tcs')).toBe('Branch TCs 6   ✓ 3  ✗ 2  · 1 not run')
    expect(await textOf(pane, 'card:tc:TC-404')).toBe('✗ TC-404 f TC-404')
    expect(await textOf(pane, 'card:tc:TC-405')).toBe('✗ TC-405 f TC-405')
    expect(await pane.find({ key: 'card:tc:TC-401' })).toBeUndefined()
    expect(await textOf(pane, 'card:tc:TC-406')).toBe('· TC-406 f TC-406')
    expect(await textOf(pane, 'card:last:full')).toContain('Last full')
    expect(await textOf(pane, 'card:last:full')).toContain('✓ 118/118')
    expect(await textOf(pane, 'card:last:full')).toContain('1h ago')
    expect(await textOf(pane, 'card:last:branch')).toContain('52/53')
    expect(await textOf(pane, 'card:last:branch')).toContain('2m ago')
    expect(await pane.find({ type: 'Text', text: new RegExp(COMMAND) })).toBeUndefined()
  })

  test('tests_row_other_shape_reads_empty', async ($, on) => {
    await start($, on, { tests: shaped(TESTS, '1') })

    const pane = await mount($)

    expect(await textOf(pane, 'tests:empty')).toBe('No test runs yet.')
  })

  test('tests_row_failed_stopped_and_errored_runs', async ($, on) => {
    const ended = (over: Partial<Run>): TestView => ({
      ...TESTS,
      last: { ...TESTS.last, branch: { id: 3, command: COMMAND, counts: counts(10, 2), exit: over.exit, endedAt: T - 1_000 } },
      runs: [{ id: 3, source: 'tool', command: COMMAND, scope: 'branch', startedAt: T - 9_000, endedAt: T - 1_000, tests: rows(10, 2), counts: counts(10, 2), ...over }],
    })
    const seed: Seed = { tests: shaped(ended({ exit: 1 })) }
    await start($, on, seed)
    const pane = await mount($)
    const failColor = await color(pane, /^✗ 2$/)
    const lastBranch = await textOf(pane, 'card:last:branch')

    seed.tests = shaped(ended({ exit: 'stopped' }))
    await pane.redraw()
    const stopped = await textOf(pane, 'card:stat')
    const lastStopped = await textOf(pane, 'card:last:branch')
    seed.tests = shaped(ended({ exit: 'error', error: 'spawn failed' }))
    await pane.redraw()
    const errored = await textOf(pane, 'card:stat')

    expect(failColor).toBe('error')
    expect(lastBranch).toContain('✗')
    expect(stopped).toContain('■ stopped')
    expect(lastStopped).toContain('■')
    expect(errored).toContain('! error: spawn failed')
    expect(await textOf(pane, 'card:last:branch')).toContain('!')
  })

  // Overview's own timer: an installed Overview loads after the trackers, so their redraws never pass its hooks.
  test('plan_total_advances_on_screen_and_stops_when_waiting', async ($, on) => {
    const seed: Seed = { tracker: planning(T - 2_000) }
    const seen = await start($, on, seed)
    const pane = await mount($)
    const before = await textOf(pane, 'plan:time:p1:total')

    await seen.clock.advance(1_000)
    const ticked = await textOf(pane, 'plan:time:p1:total')
    const base = planning(T)
    seed.tracker = {
      ...base,
      plans: base.plans.map(p => ({ ...p, time: { ...p.time, dev: 115_000 } })), // the 3 s ran so far, flushed
      clock: { group: 'p1', phase: 'waiting', since: T + 1_000, resume: 'dev', session: 's1' },
    }
    await pane.redraw() // plan-tracker's write of the paused clock redraws Overview (TC-321)
    await seen.clock.advance(2_000)
    await pane.redraw() // drawn 2 s into the pause: the paused time must not count
    const waited = await textOf(pane, 'plan:time:p1:total')

    expect(before).toContain('27m 57s')
    expect(ticked).toContain('27m 58s')
    expect(waited).toContain('27m 58s')
  })

  test('test_time_advances_on_screen', async ($, on) => {
    const seed: Seed = { tests: shaped(TESTS) }
    const seen = await start($, on, seed)
    const pane = await mount($)

    await seen.clock.advance(1_000)
    const running = await textOf(pane, 'card:bar')
    const [live, prior] = TESTS.runs
    seed.tests = shaped({
      ...TESTS,
      runs: [{ ...live!, exit: 0, endedAt: T + 1_500 }, prior!],
      last: { ...TESTS.last, branch: { id: 2, command: COMMAND, counts: counts(12, 0), exit: 0, endedAt: T + 1_500 } },
    })
    await seen.clock.advance(30_000)
    const half = await textOf(pane, 'card:last:branch')
    await seen.clock.advance(30_000)
    const minute = await textOf(pane, 'card:last:branch')
    await seen.clock.advance(61_000) // ended 1.5 s after the timer started, between its ticks

    expect(running).toContain('· 9s')
    expect(half).toContain('29s ago')
    expect(minute).toContain('59s ago') // 59.5 s: still seconds
    expect(await textOf(pane, 'card:last:branch')).toContain('2m ago')
  })

  test('timer_redraws_only_while_something_runs', async ($, on) => {
    const seed: Seed = {}
    const seen = await start($, on, seed)
    await mount($)
    seen.invalidates = 0

    await seen.clock.advance(5_000)
    const idle = seen.invalidates
    seed.tracker = { ...planning(T), clock: { group: 'p1', phase: 'waiting', since: T, resume: 'dev', session: 's1' } }
    await seen.clock.advance(5_000)
    const waiting = seen.invalidates
    seed.tracker = planning(T)
    await seen.clock.advance(1_000)
    const first = seen.invalidates
    await seen.clock.advance(1_000)
    const second = seen.invalidates
    seed.tracker = { ...planning(T), clock: { group: 'p1', phase: 'waiting', since: T, resume: 'dev', session: 's1' } }
    await seen.clock.advance(3_000)

    const paused = seen.invalidates
    // an idle Last line 2m 30.5s old: nothing until its age reaches 3m
    seed.tests = shaped({ ...TESTS, runs: [], branch: undefined, last: { full: { id: 0, command: 'run line', counts: counts(1, 0), exit: 0, endedAt: T + 15_000 - 150_500 } } })
    await seen.clock.advance(5_000)
    const quiet = seen.invalidates
    await seen.clock.advance(25_000)

    expect(idle).toBe(0)
    expect(waiting).toBe(0)
    expect(first - waiting).toBe(1)
    expect(second - first).toBe(1)
    expect(paused).toBe(second) // paused again: no more
    expect(quiet).toBe(paused) // a tracker's write draws a new line; the timer waits for its next minute
    expect(seen.invalidates).toBe(quiet + 1) // once, at 3m
  })

  test('plan_row_latest_group_per_section', async ($, on) => {
    const group = (id: string, file: string, n: number, ok: number) => ({ id, title: `plan ${id}`, file, approvedAt: '2026-11-23', items: items(n, ok) })
    const tracker: Tracker = {
      nextId: 60,
      // the newest is the smaller one, and every section has an older group
      plans: [
        group('t1', '', 1, 0), group('m1', PLAN_FILE, 2, 1), group('d1', '/repo/docs/superpowers/plans/x.md', 2, 1),
        group('m2', PLAN_FILE, 44, 42), group('d0', '/repo/docs/superpowers/plans/w.md', 5, 5), group('t0', '', 3, 3),
      ],
    }
    await start($, on, { tracker })

    const pane = await mount($)

    const sections = (await keys(pane)).filter(k => k.startsWith('plan:section:'))
    expect(sections).toEqual(['plan:section:docs', 'plan:section:mode', 'plan:section:tasks'])
    expect(await textOf(pane, 'plan:section:docs')).toBe('PLAN DOCS1/2')
    expect(await textOf(pane, 'plan:section:mode')).toBe('PLAN MODE1/2')
    expect(await textOf(pane, 'plan:section:tasks')).toBe('TASKS0/1')
    expect(await textOf(pane, 'plan:head:m1')).toContain('1/2')
    for (const old of ['m2', 'd0', 't0']) expect(await pane.find({ key: `plan:head:${old}` })).toBeUndefined()
    expect(await textOf(pane, 'plan:head:d1')).toContain('▰▰▰▰▰▱▱▱▱▱ 1/2')
  })

  test('plan_section_shows_the_clocks_group', async ($, on) => {
    const group = (id: string, n: number, ok: number) => ({ id, title: `plan ${id}`, file: PLAN_FILE, approvedAt: '2026-11-23', items: items(n, ok), time: { dev: 60_000 } })
    const tracker: Tracker = { nextId: 60, plans: [group('m1', 5, 3), group('m2', 2, 1)], clock: { group: 'm2', phase: 'dev', since: T - 30_000, session: 's1' } }
    await start($, on, { tracker })

    const pane = await mount($)

    expect(await textOf(pane, 'plan:section:mode')).toBe('PLAN MODE1/2')
    expect(await textOf(pane, 'plan:head:m2')).toContain('1/2')
    expect(await textOf(pane, 'plan:time:m2:dev')).toBe('Dev●1m 30s')
    expect(await pane.find({ key: 'plan:head:m1' })).toBeUndefined()
  })

  test(
    'tracker_write_redraws_overview',
    {
      plugins: [{
        name: 'git-tracker',
        register(on) {
          on('session.start', ($, e, next) => {
            $.clock.after(1_000, () => $.state.set({ plugin: 'git-tracker', key: 'view' }, { branch: 'feat/y', ahead: 0, behind: 0, graph: [], files: [] }))
            return next(e)
          })
        },
      }],
    },
    async ($, on) => {
      const seen = await start($, on)
      const pane = await mount($)
      const before = await textOf(pane, 'git:empty')

      await seen.clock.advance(1_000)

      expect(before).toBe('Reading git…')
      expect(await textOf(pane, 'git:head')).toBe('feat/y')
    },
  )

  test('rows_split_by_dividers_with_title_colors_and_spacing', async ($, on) => {
    const seen = await start($, on, { tracker: planning(T), git: GIT, tests: shaped(TESTS), ...TRANSCRIPTS() })
    await seen.clock.advance(1_000)

    const pane = await mount($)
    const wide = await textOf(pane, 'divider:git')
    await pane.redraw({ ...PANE, bodyColumns: 30 })
    const narrow = await textOf(pane, 'divider:tests')

    const order = await keys(pane)
    const at = (key: string) => order.indexOf(key)
    expect(at('plan:note:p1')).toBeGreaterThan(-1)
    expect(at('divider:git')).toBeGreaterThan(at('plan:note:p1'))
    expect(at('git:title')).toBeGreaterThan(at('divider:git'))
    expect(at('git:new')).toBeGreaterThan(at('git:title'))
    expect(at('divider:tests')).toBeGreaterThan(at('git:new'))
    expect(at('card:head')).toBeGreaterThan(at('divider:tests'))
    expect(at('divider:tokens')).toBeGreaterThan(at('card:last:branch'))
    expect(at('tokens:title')).toBeGreaterThan(at('divider:tokens'))
    expect(at('tokens:since')).toBeGreaterThan(at('tokens:title'))
    expect(wide).toBe('─'.repeat(48))
    expect(narrow).toBe('─'.repeat(30))
    expect((await pane.find({ type: 'Text', text: /^─+$/ }))?.props.dimColor).toBe(true)
    expect((await pane.find({ key: 'divider:git' }))?.props.marginY).toBe(1)
    expect((await pane.findAll({ type: 'Box' }))[0]?.props.gap).toBeUndefined() // the rules' margins are the only space between rows
    expect((await pane.find({ key: 'plan:section:mode' }))?.props.marginBottom).toBe(1)
    expect((await pane.find({ key: 'git:title' }))?.props.marginBottom).toBe(1)
    expect((await pane.find({ key: 'tests:title' }))?.props.marginBottom).toBe(1)
    expect((await pane.find({ key: 'tokens:title' }))?.props.marginBottom).toBe(1)
    expect((await pane.find({ key: 'divider:tokens' }))?.props.marginY).toBe(1)
    expect(await color(pane, /^TOKENS$/)).toBe('autoAccept')
    expect(await color(pane, /^PLAN MODE$/)).toBe('planMode')
    expect(await color(pane, /^GIT$/)).toBe('claude')
    expect(await color(pane, /^TESTS$/)).toBe('ide')
  })

  test('empty_plan_title_has_plan_color', async ($, on) => {
    await start($, on)

    const pane = await mount($)

    expect(await color(pane, /^PLAN$/)).toBe('planMode')
    expect((await pane.find({ key: 'plan:title' }))?.props.marginBottom).toBeUndefined() // the plan row's gap is its blank line
    expect((await pane.find({ key: 'plan' }))?.props.gap).toBe(1)
    expect(await textOf(pane, 'divider:git')).toBe('─'.repeat(48))
    expect(await textOf(pane, 'divider:tests')).toBe('─'.repeat(48))
    expect(await textOf(pane, 'divider:tokens')).toBe('─'.repeat(48))
  })

  test('tokens_tally_session_month_and_since', async ($, on) => {
    const seen = await start($, on, TRANSCRIPTS())
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // s2 + its subagent: b once (its repeated row skipped), c, e; d's line has no end yet
    expect(await line(pane, 'session')).toBe('This session11.1K')
    expect(await line(pane, 'month')).toBe('November11.1K')
    expect(await line(pane, 'since')).toBe(`Since ${S1_DAY} Oct12.2K`)
    expect(await textOf(pane, 'tokens:parts')).toBe('cache = 1.1K write + 11.0K read')
    expect(await pane.find({ key: 'tokens:error' })).toBeUndefined()
    // every part exactly: the screen's rounding hides a missing input count
    const kept = seen.stores.at(-1)?.value.files ?? {}
    expect(kept['/p/s1.jsonl']?.parts).toEqual([1, 10, 100, 1000])
    expect(kept['/p/s2.jsonl']?.parts).toEqual([5, 50, 500, 5000])
    expect(kept['/p/s2/subagents/a1.jsonl']?.parts).toEqual([5, 50, 500, 5000])
    // each local day's total beside the month's
    expect(kept['/p/s1.jsonl']?.days).toEqual({ [dayKey('2026-10-08T12:00:00Z')]: 1111 })
    expect(kept['/p/s2.jsonl']?.days).toEqual({ [dayKey('2026-11-20T12:00:00Z')]: 5555 })
    expect(kept['/p/s2/subagents/a1.jsonl']?.days).toEqual({ [dayKey('2026-11-21T12:00:00Z')]: 5555 })
  })

  test('tokens_add_only_new_bytes', async ($, on) => {
    const seed = TRANSCRIPTS()
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)
    const pane = await mount($) // open before the rows land: this pane redraws
    const counted = new TextEncoder().encode(S2_DONE).length
    const files = seed.files ?? {}
    files['/p/s2.jsonl'] = `${files['/p/s2.jsonl']}\n${usage('f', '2026-11-22T12:00:00Z', [6, 60, 600, 6000])}\n`
    seen.reads.length = 0

    await seen.clock.advance(30_000)

    // d (4444) and f (6666) on top of 11110
    expect(await line(pane, 'session')).toBe('This session22.2K')
    expect(await line(pane, 'since')).toBe(`Since ${S1_DAY} Oct23.3K`)
    const s2 = seen.reads.filter(r => r.path === '/p/s2.jsonl')
    expect(s2[0]?.offset).toBe(counted + new TextEncoder().encode(S2_CUT).length)
    expect(seen.reads.filter(r => r.path === '/p/s1.jsonl')).toHaveLength(0)
    expect(seen.reads.filter(r => r.path === '/p/s2/subagents/a1.jsonl')).toHaveLength(0)
  })

  test('tokens_kept_across_sessions_and_read_errors_shown', async ($, on) => {
    const seed = TRANSCRIPTS()
    const s1 = new TextEncoder().encode(seed.files?.['/p/s1.jsonl'] ?? '').length
    const first = Date.parse('2026-10-01T12:00:00Z')
    seed.store = {
      'tokens:/p': {
        files: {
          '/p/s0.jsonl': {
            offset: 500, first, parts: [0, 0, 0, 1_000_000], months: { '2026-10': 1_000_000 }, days: { [dayKey(first)]: 1_000_000 },
            monthParts: { '2026-10': [0, 0, 0, 1_000_000] }, ids: [41, 42],
          },
          '/p/s1.jsonl': {
            offset: s1, first: Date.parse('2026-10-08T12:00:00Z'), parts: [1, 10, 100, 1000], months: { '2026-10': 1111 },
            days: { [dayKey('2026-10-08T12:00:00Z')]: 1111 }, monthParts: { '2026-10': [1, 10, 100, 1000] },
          },
        },
      },
    }
    seed.deny = ['/p/s2.jsonl']
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // s0 (gone from disk) 1M + s1 1111 + a1 5555; s2 unreadable
    expect(await line(pane, 'since')).toBe(`Since ${new Date(first).getDate()} Oct1.0M`)
    expect(await line(pane, 'session')).toBe('This session5.6K')
    expect(await textOf(pane, 'tokens:error')).toContain("Can't read s2.jsonl")
    expect((await pane.find({ type: 'Text', text: /^Can't read/ }))?.props.dimColor).toBe(true)
    expect(seen.reads.filter(r => r.path === '/p/s1.jsonl')).toHaveLength(0)
    // s0 is gone from disk: its counts stay. Its ids stay too while s2 can't be read: s2 may hold copies of them
    expect(seen.stores.at(-1)?.value.files['/p/s0.jsonl']).toMatchObject({ parts: [0, 0, 0, 1_000_000], ids: [41, 42] })
    expect(seen.stores.at(-1)?.value.files['/p/s0.jsonl']?.days).toEqual({ [dayKey(first)]: 1_000_000 })
  })

  test('tokens_copied_rows_count_once', async ($, on) => {
    const seed = TRANSCRIPTS()
    const files = seed.files ?? {}
    // this session, resumed from s2: it starts with the rows it carried over, the same message ids as s2's. Its name
    // lists first; it was written last
    files['/p/a3.jsonl'] = `${usage('b', '2026-11-20T12:00:00Z', [2, 20, 200, 2000])}\n${usage('h', '2026-11-22T12:00:00Z', [8, 80, 800, 8000])}\n`
    // and links the subagent file it carried over instead of copying it
    files['/p/a3/subagents/a1.jsonl'] = files['/p/s2/subagents/a1.jsonl'] ?? ''
    seed.links = ['/p/a3/subagents/a1.jsonl']
    seed.mtimes = { '/p/a3.jsonl': 2 }
    seed.transcript = '/p/a3.jsonl'
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // 12221 + h's 8888; b stays s2's
    expect(await line(pane, 'since')).toBe(`Since ${S1_DAY} Oct21.1K`)
    expect(await line(pane, 'session')).toBe('This session8.9K')
    expect(seen.reads.filter(r => r.path === '/p/a3/subagents/a1.jsonl')).toHaveLength(0)
  })

  test('tokens_deleted_parent_copies_count_once', async ($, on) => {
    const seed = TRANSCRIPTS()
    const files = seed.files ?? {}
    // a3 resumed from s2 (copies b); counted; then s2 is deleted and d4 is resumed from a3 (copies b and h)
    files['/p/a3.jsonl'] = `${usage('b', '2026-11-20T12:00:00Z', [2, 20, 200, 2000])}\n${usage('h', '2026-11-22T12:00:00Z', [8, 80, 800, 8000])}\n`
    seed.mtimes = { '/p/a3.jsonl': 2 }
    const seen = await start($, on, seed)
    delete files['/p/s2.jsonl']
    await seen.clock.advance(30_000)
    files['/p/d4.jsonl'] = `${files['/p/a3.jsonl']}${usage('j', '2026-11-24T08:00:00Z', [1, 1, 1, 1])}\n`
    seed.mtimes['/p/d4.jsonl'] = 3

    await seen.clock.advance(30_000)
    const pane = await mount($)

    // 12221 + h's 8888 + j's 4; s2's counts kept, b and h not again
    expect(await line(pane, 'since')).toBe(`Since ${S1_DAY} Oct21.1K`)
    const kept = seen.stores.at(-1)?.value.files ?? {}
    expect(kept['/p/s2.jsonl']).toMatchObject({ parts: [5, 50, 500, 5000], ids: [] })
    expect(kept['/p/d4.jsonl']?.parts).toEqual([1, 1, 1, 1])
  })

  test('tokens_parent_deleted_as_its_copy_lands', async ($, on) => {
    const seed = TRANSCRIPTS()
    const files = seed.files ?? {}
    const seen = await start($, on, seed)
    // between two tallies: a3 is resumed from s2 (copies b, adds h), and s2 is deleted
    files['/p/a3.jsonl'] = `${usage('b', '2026-11-20T12:00:00Z', [2, 20, 200, 2000])}\n${usage('h', '2026-11-22T12:00:00Z', [8, 80, 800, 8000])}\n`
    delete files['/p/s2.jsonl']

    await seen.clock.advance(30_000)
    const pane = await mount($)

    // 12221 + h's 8888; b not again
    expect(await line(pane, 'since')).toBe(`Since ${S1_DAY} Oct21.1K`)
    expect(seen.stores.at(-1)?.value.files['/p/s2.jsonl']?.ids).toEqual([])
  })

  test('tokens_unreadable_subagents_folder_shown', async ($, on) => {
    const seed = TRANSCRIPTS()
    seed.deny = ['/p/s2/subagents']
    seed.store = { 'tokens:/p': { files: { '/p/s0.jsonl': { offset: 500, parts: [0, 0, 0, 7], months: {}, days: {}, monthParts: {}, ids: [41] } } } }
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // s2's own 5555, a1 left out; the listing was not whole, so nothing is taken as deleted
    expect(await line(pane, 'session')).toBe('This session5.6K')
    const error = await textOf(pane, 'tokens:error')
    expect(error.startsWith("Can't read a subagents folder: ")).toBe(true)
    expect(error).toContain('EACCES: /p/s2/subagents') // the reason, after the kit's own `overview: $.fs.list:`
    expect(seen.stores.at(-1)?.value.files['/p/s0.jsonl']?.ids).toEqual([41])
  })

  test('tokens_line_longer_than_one_read', async ($, on) => {
    const seed = TRANSCRIPTS()
    // s1 takes 5 MiB of the first tally's 8; s2's one reply is 9 MiB long, split across reads and tallies
    const other = `${JSON.stringify({ type: 'user', message: { content: 'y'.repeat(5 * MiB) } })}\n${usage('a', '2026-10-08T12:00:00Z', [1, 10, 100, 1000])}\n`
    const big = `${usage('g', '2026-11-23T12:00:00Z', [7, 70, 700, 7000], 'x'.repeat(9 * MiB))}\n`
    seed.files = { '/p/s1.jsonl': other, '/p/s2.jsonl': big }
    const read = () => seen.reads.splice(0).reduce((n, r) => n + (r.length ?? 0), 0)
    const seen = await start($, on, seed)
    const tallies = [read()]

    await seen.clock.advance(1_000)
    tallies.push(read())
    const pane = await mount($)

    expect(Math.max(...tallies)).toBeLessThanOrEqual(8 * MiB)
    expect(await line(pane, 'session')).toBe('This session7.8K')
    expect(await line(pane, 'since')).toBe(`Since ${S1_DAY} Oct8.9K`)
    const size = (text: string) => new TextEncoder().encode(text).length
    expect(tallies[0] + tallies[1]).toBe(size(other) + size(big))
  })

  test('tokens_every_30s_and_after_clear', async ($, on) => {
    const seed = TRANSCRIPTS()
    const seen = await start($, on, seed)
    const files = seed.files ?? {}
    files['/p/s2.jsonl'] = `${files['/p/s2.jsonl']}\n` // d's line ends
    seen.reads.length = 0

    await seen.clock.advance(29_000)
    const quiet = seen.reads.length
    await seen.clock.advance(1_000)
    const pane = await mount($)
    const counted = await line(pane, 'session')
    seed.transcript = '/p/s1.jsonl' // /clear: a new transcript, and no session.start
    await seen.clock.advance(30_000)

    expect(quiet).toBe(0)
    expect(counted).toBe('This session15.6K') // 11110 + d's 4444
    expect(await line(pane, 'session')).toBe('This session1.1K')
  })

  test('tokens_rewritten_transcript_keeps_counts', async ($, on) => {
    const seed = TRANSCRIPTS()
    const seen = await start($, on, seed)
    const files = seed.files ?? {}
    files['/p/s2.jsonl'] = `${usage('b', '2026-11-20T12:00:00Z', [2, 20, 200, 2000])}\n${usage('i', '2026-11-22T13:00:00Z', [9, 90, 900, 9000])}\n`
    seen.reads.length = 0

    await seen.clock.advance(30_000)
    const pane = await mount($)

    // 12221 + i's 9999; b and c kept, b not again
    expect(await line(pane, 'since')).toBe(`Since ${S1_DAY} Oct22.2K`)
    expect(seen.reads.find(r => r.path === '/p/s2.jsonl')?.offset).toBe(0)
  })

  test('tokens_new_project_folder_reads_zero', async ($, on) => {
    const seen = await start($, on, { transcript: '/new/s.jsonl' })
    await seen.clock.advance(1_000)

    const pane = await mount($)

    expect(await line(pane, 'session')).toBe('This session0')
    expect(await line(pane, 'since')).toBe('Total0')
    expect(await pane.find({ key: 'tokens:error' })).toBeUndefined()
  })

  test('tokens_save_failure_shown_and_retried', async ($, on) => {
    const seed: Seed = { ...TRANSCRIPTS(), storeFails: 'set' }
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)
    const pane = await mount($)
    const failed = await textOf(pane, 'tokens:error')
    const tries = seen.stores.length
    delete seed.storeFails

    await seen.clock.advance(30_000)

    expect(failed).toContain("Can't save tokens: ")
    expect(await line(pane, 'session')).toBe('This session11.1K')
    expect(seen.stores).toHaveLength(tries + 1) // saved again with nothing new read
    expect(await pane.find({ key: 'tokens:error' })).toBeUndefined()
  })

  test('tokens_store_unreadable_shown', async ($, on) => {
    const seen = await start($, on, { ...TRANSCRIPTS(), storeFails: 'get' })
    await seen.clock.advance(1_000)

    const pane = await mount($)

    expect(await textOf(pane, 'tokens:empty')).toBe('Counting tokens…')
    expect(await textOf(pane, 'tokens:error')).toContain("Can't count tokens: ")
    expect(seen.stores).toHaveLength(0) // nothing written over the kept tally
  })

  test('tokens_units_round_up', async ($, on) => {
    const seen = await start($, on, {
      transcript: '/p/s2.jsonl',
      files: { '/p/s1.jsonl': `${usage('x', '', [0, 0, 0, 999_000_000])}\n`, '/p/s2.jsonl': `${usage('y', '', [0, 0, 0, 999_960])}\n` },
    })
    await seen.clock.advance(1_000)

    const pane = await mount($)

    expect(await line(pane, 'session')).toBe('This session1.0M')
    expect(await line(pane, 'since')).toBe('Total1.00B')
    expect(await textOf(pane, 'tokens:parts')).toBe('cache = 0 write + 1.00B read')
  })

  test('tokens_day_chart', async ($, on) => {
    const seen = await start($, on, TRANSCRIPTS())
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // b+c's day and e's day, 5,555 each, the max; 8 Oct is outside the 20 days 48 columns hold
    const full = dayRow(48, T, [['2026-11-20T12:00:00Z', '█'], ['2026-11-21T12:00:00Z', '█']])
    expect(await chartRows(pane)).toEqual([`${full}  5.6K`, full, full, full, `${full}  2.8K`, full, full, `${full}  0`])
    expect(await textOf(pane, 'tokens:chart:labels')).toBe(dayLabels(48, T))
    expect((await pane.find({ type: 'Text', text: /^Days$/ }))?.props.bold).toBe(true)
    expect((await pane.find({ type: 'Text', text: /^Months$/ }))?.props.bold).toBe(false)
    expect((await pane.find({ key: 'tokens:view:months' }))?.props.dimColor).toBe(true)
    expect((await pane.find({ key: 'tokens:view:days' }))?.props.dimColor).toBe(false)
  })

  test('tokens_month_chart_toggle_remembered', async ($, on) => {
    const seen = await start($, on, TRANSCRIPTS())
    await seen.clock.advance(1_000)
    const pane = await mount($)
    const saved = () => seen.stores.filter(x => x.key === 'chart').map(x => x.value as unknown)

    const days = { rows: await chartRows(pane), labels: await textOf(pane, 'tokens:chart:labels') }
    await pane.press({ key: 'tokens:view:months' })
    const months = await chartRows(pane)
    const initials = await textOf(pane, 'tokens:chart:labels')
    const afterMonths = saved()
    const look = async () => [
      (await pane.find({ type: 'Text', text: /^Days$/ }))?.props.bold, (await pane.find({ key: 'tokens:view:days' }))?.props.dimColor,
      (await pane.find({ type: 'Text', text: /^Months$/ }))?.props.bold, (await pane.find({ key: 'tokens:view:months' }))?.props.dimColor,
    ]
    const monthsLook = await look()
    await pane.press({ key: 'tokens:view:days' })

    // the 12 months ending T's: Oct (1,111: 6.4 of 64 eighths, 6) the 11th slot, Nov (11,110, the max) the 12th
    const nov = chartRow(48, { 11: '█' }, false)
    expect(months).toEqual([
      `${nov}  11.1K`, nov, nov, nov, `${nov}  5.6K`, nov, nov, `${chartRow(48, { 10: '▆', 11: '█' }, false)}  0`,
    ])
    expect(initials).toBe(monthLabels(T))
    expect(afterMonths).toEqual(['months'])
    expect(saved()).toEqual(['months', 'days'])
    expect(monthsLook).toEqual([false, true, true, false])
    // the day chart as it was
    expect({ rows: await chartRows(pane), labels: await textOf(pane, 'tokens:chart:labels') }).toEqual(days)
  })

  test('tokens_chart_choice_kept', async ($, on) => {
    const seen = await start($, on, { ...TRANSCRIPTS(), store: { chart: 'months' } })
    await seen.clock.advance(1_000)

    const pane = await mount($)

    expect(await textOf(pane, 'tokens:chart:labels')).toBe(monthLabels(T))
    expect((await pane.find({ type: 'Text', text: /^Months$/ }))?.props.bold).toBe(true)
  })

  test('tokens_bar_heights', async ($, on) => {
    // all four days inside the 20 days 48 columns hold
    const at = [daysBack(1), daysBack(2), daysBack(15)] as const
    const rows = [usage('a', at[0], [0, 0, 0, 64_000]), usage('b', at[1], [0, 0, 0, 11_600]), usage('c', at[2], [0, 1, 0, 0])]
    const seen = await start($, on, { transcript: '/p/s2.jsonl', files: { '/p/s2.jsonl': rows.map(l => `${l}\n`).join('') } })
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // 64,000 is the max: 64 eighths, all 8 rows; 11,600 is 11.6, rounded to 12: the bottom row and ▄ (▃ if floored);
    // 1 rounds to 0 and shows ▁; 3 days back has none
    expect(colOf(T, at[2], 20)).toBe(4)
    const tall = dayRow(48, T, [[at[0], '█']])
    expect(await chartRows(pane)).toEqual([
      `${tall}  64.0K`, tall, tall, tall, `${tall}  32.0K`, tall,
      dayRow(48, T, [[at[0], '█'], [at[1], '▄']]),
      `${dayRow(48, T, [[at[0], '█'], [at[1], '█'], [at[2], '▁']])}  0`,
    ])
  })

  test('tokens_upgrade_from_0_2_0_store', async ($, on) => {
    const seed = TRANSCRIPTS()
    const size = (path: string) => new TextEncoder().encode(seed.files?.[path] ?? '').length
    const at = (iso: string) => Date.parse(iso)
    // 0.2.0's shape: months and ids, no days; offsets where 0.2.0 stopped
    seed.store = {
      'tokens:/p': {
        files: {
          '/p/s0.jsonl': { offset: 500, first: at('2026-10-01T12:00:00Z'), parts: [0, 0, 0, 1_000_000], months: { '2026-10': 1_000_000 }, ids: [] },
          '/p/s1.jsonl': { offset: size('/p/s1.jsonl'), first: at('2026-10-08T12:00:00Z'), parts: [1, 10, 100, 1000], months: { '2026-10': 1111 }, ids: [idHash('a')] },
          '/p/s2.jsonl': {
            offset: new TextEncoder().encode(S2_DONE).length, first: at('2026-11-20T12:00:00Z'), parts: [5, 50, 500, 5000], months: { '2026-11': 5555 },
            ids: [idHash('b'), idHash('c')],
          },
          '/p/s2/subagents/a1.jsonl': { offset: size('/p/s2/subagents/a1.jsonl'), first: at('2026-11-21T12:00:00Z'), parts: [5, 50, 500, 5000], months: { '2026-11': 5555 }, ids: [idHash('e')] },
        },
      },
    }
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)

    const pane = await mount($)

    for (const path of ['/p/s1.jsonl', '/p/s2.jsonl', '/p/s2/subagents/a1.jsonl']) expect(seen.reads.find(r => r.path === path)?.offset).toBe(0)
    const kept = seen.stores.filter(x => x.key === 'tokens:/p').at(-1)?.value.files ?? {}
    expect(kept['/p/s1.jsonl']?.parts).toEqual([1, 10, 100, 1000])
    expect(kept['/p/s2.jsonl']?.parts).toEqual([5, 50, 500, 5000])
    expect(kept['/p/s2/subagents/a1.jsonl']?.parts).toEqual([5, 50, 500, 5000])
    expect(kept['/p/s0.jsonl']).toMatchObject({ parts: [0, 0, 0, 1_000_000], months: { '2026-10': 1_000_000 } })
    expect(kept['/p/s0.jsonl']?.days).toEqual({})
    expect(kept['/p/s0.jsonl']?.monthParts).toEqual({})
    expect(await line(pane, 'session')).toBe('This session11.1K')
    expect(await line(pane, 'month')).toBe('November11.1K')
    const full = dayRow(48, T, [['2026-11-20T12:00:00Z', '█'], ['2026-11-21T12:00:00Z', '█']])
    expect((await chartRows(pane))[0]).toBe(`${full}  5.6K`)
  })

  test('tokens_upgrade_waits_for_a_whole_listing', async ($, on) => {
    const seed = TRANSCRIPTS()
    const files = seed.files ?? {}
    // a1 starts with a copy of s2's c (a resumed session's rows); 0.2.0 counted c in s2
    files['/p/s2/subagents/a1.jsonl'] = `${usage('c', '2026-11-20T12:05:00Z', [3, 30, 300, 3000], 'café ✓ 日本')}\n${files['/p/s2/subagents/a1.jsonl']}`
    const end = (path: string) => new TextEncoder().encode(path === '/p/s2.jsonl' ? S2_DONE : (files[path] ?? '')).length
    seed.deny = ['/p/s2/subagents']
    // 0.2.0's shape: s2 listed, a1 in the folder that won't list, s0 gone; no days
    seed.store = {
      'tokens:/p': {
        files: {
          '/p/s0.jsonl': { offset: 500, parts: [0, 0, 0, 7], months: { '2026-10': 7 }, ids: [] },
          '/p/s2.jsonl': { offset: end('/p/s2.jsonl'), parts: [5, 50, 500, 5000], months: { '2026-11': 5555 }, ids: [idHash('b'), idHash('c')] },
          '/p/s2/subagents/a1.jsonl': { offset: end('/p/s2/subagents/a1.jsonl'), parts: [5, 50, 500, 5000], months: { '2026-11': 5555 }, ids: [idHash('c'), idHash('e')] },
        },
      },
    }
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)
    const kept = () => seen.stores.filter(x => x.key === 'tokens:/p').at(-1)?.value.files ?? {}
    const denied = { s0: kept()['/p/s0.jsonl'], s2: kept()['/p/s2.jsonl'], a1: kept()['/p/s2/subagents/a1.jsonl'] }
    const s2Read = seen.reads.some(r => r.path === '/p/s2.jsonl')

    seed.deny = []
    await seen.clock.advance(30_000)
    const pane = await mount($)

    // not whole: none taken as gone, none counted again (s2 not even read), all kept as they were
    expect(s2Read).toBe(false)
    expect(denied.s0).toEqual({ offset: 500, parts: [0, 0, 0, 7], months: { '2026-10': 7 }, ids: [] })
    expect(denied.s2?.days).toBeUndefined()
    expect(denied.a1?.days).toBeUndefined()
    expect(denied.a1).toMatchObject({ parts: [5, 50, 500, 5000], ids: [idHash('c'), idHash('e')] })
    // whole: s2 and a1 read again from their starts; c counts once, in s2, which is read first
    for (const path of ['/p/s2.jsonl', '/p/s2/subagents/a1.jsonl']) expect(seen.reads.find(r => r.path === path)?.offset).toBe(0)
    expect(kept()['/p/s2.jsonl']).toMatchObject({ parts: [5, 50, 500, 5000], days: { [dayKey('2026-11-20T12:00:00Z')]: 5555 } })
    expect(kept()['/p/s2/subagents/a1.jsonl']).toMatchObject({ parts: [5, 50, 500, 5000], days: { [dayKey('2026-11-21T12:00:00Z')]: 5555 } })
    expect(kept()['/p/s0.jsonl']?.days).toEqual({})
    expect(await line(pane, 'session')).toBe('This session11.1K')
  })

  test('tokens_upgrade_saves_only_when_done', async ($, on) => {
    const seed = TRANSCRIPTS()
    const end = (path: string) => new TextEncoder().encode(path === '/p/s2.jsonl' ? S2_DONE : (seed.files?.[path] ?? '')).length
    const legacy = (path: string, parts: number[], months: Record<string, number>, ids: string[]) =>
      ({ offset: end(path), parts, months, ids: ids.map(idHash) })
    seed.store = {
      'tokens:/p': {
        files: {
          '/p/s1.jsonl': legacy('/p/s1.jsonl', [1, 10, 100, 1000], { '2026-10': 1111 }, ['a']),
          '/p/s2.jsonl': legacy('/p/s2.jsonl', [5, 50, 500, 5000], { '2026-11': 5555 }, ['b', 'c']),
          '/p/s2/subagents/a1.jsonl': legacy('/p/s2/subagents/a1.jsonl', [5, 50, 500, 5000], { '2026-11': 5555 }, ['e']),
        },
      },
    }
    seed.deny = ['/p/s2.jsonl']
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)
    const pane = await mount($)
    const writes = () => seen.stores.filter(x => x.key === 'tokens:/p')
    const during = { writes: writes().length, counts: await textOf(pane, 'tokens:empty'), error: await textOf(pane, 'tokens:error') }

    seed.deny = []
    await seen.clock.advance(30_000)

    // s2's read failed mid-recount: nothing saved (the store keeps 0.2.0's tally), still counting, the error shown
    expect(during.writes).toBe(0)
    expect(during.counts).toBe('Counting tokens…')
    expect(during.error).toContain("Can't read s2.jsonl")
    // read on the next tally: one save, every file once
    expect(writes()).toHaveLength(1)
    expect(writes()[0]?.value.files['/p/s2.jsonl']?.parts).toEqual([5, 50, 500, 5000])
    expect(await line(pane, 'session')).toBe('This session11.1K')
    expect(await line(pane, 'month')).toBe('November11.1K')
  })

  test('tokens_chart_fits_a_narrow_pane', async ($, on) => {
    const seen = await start($, on, TRANSCRIPTS())
    await seen.clock.advance(1_000)
    const pane = await mount($)
    const widest = async () =>
      Math.max(...(await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 'labels'].map(r => textOf(pane, `tokens:chart:${r}`)))).map(t => t.length))
    const day = (cols: number) => dayRow(cols, T, [['2026-11-20T12:00:00Z', '█'], ['2026-11-21T12:00:00Z', '█']])

    await pane.redraw({ ...PANE, bodyColumns: 30 })
    const at30 = { bottom: (await chartRows(pane))[7], labels: await textOf(pane, 'tokens:chart:labels'), widest: await widest() }
    await pane.press({ key: 'tokens:view:months' })
    const months30 = { bottom: (await chartRows(pane))[7], widest: await widest() }
    await pane.redraw({ ...PANE, bodyColumns: 20 })
    await pane.press({ key: 'tokens:view:days' })
    const at20 = { bottom: (await chartRows(pane))[7], labels: await textOf(pane, 'tokens:chart:labels'), widest: await widest() }
    await pane.redraw({ ...PANE, bodyColumns: 18 })

    // 30 columns: 11 days, 2 columns each; 7 months (Oct the 6th slot, Nov the 7th); 20 columns: 6 days, today only
    expect(layout(30).count).toBe(11)
    expect(at30).toEqual({ bottom: `${day(30)}  0`, labels: dayLabels(30, T), widest: 28 })
    expect(months30).toEqual({ bottom: `${chartRow(30, { 5: '▆', 6: '█' }, false)}  0`, widest: 29 }) // 22 + `  11.1K`
    expect(at20).toEqual({ bottom: `${day(20)}  0`, labels: dayLabel(new Date(T)).padStart(11), widest: 18 })
    expect(await pane.find({ key: 'tokens:chart' })).toBeUndefined()
    expect(await pane.find({ key: 'tokens:view:days' })).toBeUndefined()
    expect(await line(pane, 'session')).toBe('This session11.1K')
  })

  test('tokens_chart_big_peak_fits', async ($, on) => {
    const at = daysBack(1)
    const seen = await start($, on, { transcript: '/p/s2.jsonl', files: { '/p/s2.jsonl': `${usage('a', at, [0, 0, 0, 150_000_000_000])}\n` } })
    await seen.clock.advance(1_000)
    const pane = await mount($)
    const rows = async () => [...(await chartRows(pane)), await textOf(pane, 'tokens:chart:labels')]

    await pane.redraw({ ...PANE, bodyColumns: 30 })
    const days = await rows()
    await pane.press({ key: 'tokens:view:months' })
    const months = await rows()

    // `150.00B` is 7 wide, one more than the 8 columns kept for the axis: the chart gives up a column (21 wide, not 22):
    // 10 days, the day before T's the 9th; 7 months, Nov the 7th at 18
    expect(days[0]).toBe(`${bars(21, { [Math.floor((colOf(T, at, 10) * 21) / 10)]: '█' })}  150.00B`)
    expect(months[0]).toBe(`${bars(21, { 18: '█', 19: '█' })}  150.00B`)
    expect(Math.max(...[...days, ...months].map(r => r.length))).toBe(30)
  })

  test('tokens_day_chart_turns_at_midnight', async ($, on) => {
    const seen = setup(on, TRANSCRIPTS())
    const midnight = new Date(2026, 10, 24).getTime() // the runtime's own
    await seen.clock.set(midnight - 2_000)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await seen.clock.settle()
    const pane = await mount($)
    const before = (await chartRows(pane))[7]

    await seen.clock.advance(3_000)

    const bottom = (now: number) => `${dayRow(48, now, [['2026-11-20T12:00:00Z', '█'], ['2026-11-21T12:00:00Z', '█']])}  0`
    expect(before).toBe(bottom(midnight - 2_000))
    expect((await chartRows(pane))[7]).toBe(bottom(midnight + 1_000))
    expect((await textOf(pane, 'tokens:chart:labels')).endsWith(` ${dayLabel(new Date(midnight))}`)).toBe(true)
  })

  test('tokens_day_chart_first_tick_after_midnight', async ($, on) => {
    const seen = setup(on, TRANSCRIPTS())
    const midnight = new Date(2026, 10, 24).getTime() // the runtime's own
    await seen.clock.set(midnight - 500)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await seen.clock.settle()
    const pane = await mount($)
    const before = await textOf(pane, 'tokens:chart:labels')

    await seen.clock.advance(1_000) // the timer's first tick, half a second past midnight

    expect(before.endsWith(` ${dayLabel(new Date(midnight - 500))}`)).toBe(true)
    expect((await textOf(pane, 'tokens:chart:labels')).endsWith(` ${dayLabel(new Date(midnight))}`)).toBe(true)
  })

  test('tokens_bad_usage_numbers_count_zero', async ($, on) => {
    const at = daysBack(1)
    const bad = `{"type":"assistant","timestamp":"${at}","message":{"id":"x","usage":{"input_tokens":-5,"output_tokens":1e400,"cache_creation_input_tokens":3,"cache_read_input_tokens":"7"}}}`
    const seen = await start($, on, { transcript: '/p/s2.jsonl', files: { '/p/s2.jsonl': `${bad}\n` } })
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // -5, 1e400 (Infinity) and "7" are 0; only the 3 counts
    expect(seen.stores.filter(x => x.key === 'tokens:/p').at(-1)?.value.files['/p/s2.jsonl']?.parts).toEqual([0, 0, 3, 0])
    expect(await line(pane, 'session')).toBe('This session3')
    const bar = dayRow(48, T, [[at, '█']])
    expect(await chartRows(pane)).toEqual([`${bar}  3`, bar, bar, bar, `${bar}  2`, bar, bar, `${bar}  0`])
  })

  test('tokens_chart_grows_live', async ($, on) => {
    const seed = TRANSCRIPTS()
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)
    const pane = await mount($)
    const files = seed.files ?? {}
    files['/p/s2/subagents/a1.jsonl'] = `${files['/p/s2/subagents/a1.jsonl']}${usage('k', new Date(T).toISOString(), [0, 0, 0, 20_000])}\n`

    await seen.clock.advance(30_000)

    // today 20,000, the max; 5,555 is 17.8 of 64 eighths, 18: two full rows and ▂
    const today = new Date(T).toISOString()
    const [bc, e] = ['2026-11-20T12:00:00Z', '2026-11-21T12:00:00Z']
    const top = dayRow(48, T, [[today, '█']])
    const low = dayRow(48, T, [[today, '█'], [bc, '█'], [e, '█']])
    expect(await chartRows(pane)).toEqual([
      `${top}  20.0K`, top, top, top, `${top}  10.0K`, dayRow(48, T, [[today, '█'], [bc, '▂'], [e, '▂']]), low, `${low}  0`,
    ])
  })

  test('tokens_chart_empty_window', async ($, on) => {
    const seen = setup(on, TRANSCRIPTS())
    await seen.clock.set(new Date(2027, 0, 1, 12).getTime())
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await seen.clock.settle()
    const pane = await mount($)
    const empty = await pane.find({ type: 'Text', text: /^No tokens in the last 20 days\.$/ })
    const noBars = [...(await chartRows(pane)), await textOf(pane, 'tokens:chart:labels')]

    await pane.press({ key: 'tokens:view:months' })

    expect(empty?.props.dimColor).toBe(true)
    expect(noBars).toEqual(['', '', '', '', '', '', '', '', ''])
    // the 12 months ending January 2027: Oct the 9th slot, Nov the 10th
    expect((await chartRows(pane))[7]).toBe(`${chartRow(48, { 8: '▆', 9: '█' }, false)}  0`)
  })

  test('tokens_no_chart_while_counting', async ($, on) => {
    const seen = await start($, on, { ...TRANSCRIPTS(), storeFails: 'get' })
    await seen.clock.advance(1_000)

    const pane = await mount($)

    expect(await textOf(pane, 'tokens:empty')).toBe('Counting tokens…')
    expect(await pane.find({ key: 'tokens:chart:1' })).toBeUndefined()
    expect(await pane.find({ key: 'tokens:view:days' })).toBeUndefined()
  })

  test('tokens_chart_choice_save_fails', async ($, on) => {
    const seed: Seed = TRANSCRIPTS()
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)
    const pane = await mount($)
    seed.storeFails = 'set'

    await pane.press({ key: 'tokens:view:months' })

    expect(await textOf(pane, 'tokens:chart:labels')).toBe(monthLabels(T))
    expect((await chartRows(pane))[7]).toBe(`${chartRow(48, { 10: '▆', 11: '█' }, false)}  0`)
    expect(seen.stores.filter(x => x.key === 'chart')).toHaveLength(1) // tried, and refused
  })

  test('tokens_month_label_turns_at_midnight', async ($, on) => {
    const seen = setup(on, TRANSCRIPTS())
    await seen.clock.set(new Date(2026, 11, 1).getTime() - 2_000) // the runtime's own midnight
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await seen.clock.settle()
    const pane = await mount($)
    const before = await line(pane, 'month')

    await seen.clock.advance(3_000)

    expect(before).toBe('November11.1K')
    expect(await line(pane, 'month')).toBe('December0')
  })

  test('tokens_table_split', async ($, on) => {
    const seen = await start($, on, TRANSCRIPTS())
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // session and November: s2 + a1 = [10, 100, 1000, 10000]; since: + s1 [1, 10, 100, 1000]; cache = write + read
    expect(await cells(pane, 'head')).toEqual(['      in', '     out', '   cache', '   total'])
    expect(await cells(pane, 'session')).toEqual(['      10', '     100', '   11.0K', '   11.1K'])
    expect(await cells(pane, 'month')).toEqual(['      10', '     100', '   11.0K', '   11.1K'])
    expect(await cells(pane, 'since')).toEqual(['      11', '     110', '   12.1K', '   12.2K'])
    expect(await textOf(pane, 'tokens:session:label')).toBe('This session')
    expect(await textOf(pane, 'tokens:month:label')).toBe('November')
    expect(await textOf(pane, 'tokens:since:label')).toBe(`Since ${S1_DAY} Oct`)
    expect((await pane.find({ type: 'Text', text: /^ +in$/ }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: /^ +11\.1K$/ }))?.props.dimColor).toBe(false)
    expect(await textOf(pane, 'tokens:parts')).toBe('cache = 1.1K write + 11.0K read')
    expect((await pane.find({ type: 'Text', text: /^cache = / }))?.props.dimColor).toBe(true)
    expect(await pane.find({ key: 'tokens:unsplit' })).toBeUndefined()
  })

  test('tokens_table_narrow_pane_falls_back', async ($, on) => {
    const seen = await start($, on, TRANSCRIPTS())
    await seen.clock.advance(1_000)
    const pane = await mount($)

    await pane.redraw({ ...PANE, bodyColumns: 40 })
    const at40 = { head: await pane.find({ key: 'tokens:head' }), in: await pane.find({ key: 'tokens:session:in' }), session: await line(pane, 'session') }
    const parts40 = await textOf(pane, 'tokens:parts')
    await pane.redraw({ ...PANE, bodyColumns: 20 })

    // 4 columns of 8 leave 8 for the label at 40: the 0.3.0 lines
    expect(at40).toEqual({ head: undefined, in: undefined, session: 'This session11.1K' })
    expect(parts40).toBe('out 110 · cache 1.1K write + 11.0K read')
    expect(await pane.find({ key: 'tokens:head' })).toBeUndefined()
    expect(await line(pane, 'since')).toBe(`Since ${S1_DAY} Oct12.2K`)
    expect(await textOf(pane, 'tokens:parts')).toBe('out 110 · cache 1.1K write + 11.0K read')
  })

  test('tokens_month_split_kept', async ($, on) => {
    const seen = await start($, on, TRANSCRIPTS())
    await seen.clock.advance(1_000)

    const kept = seen.stores.filter(x => x.key === 'tokens:/p').at(-1)?.value.files ?? {}

    expect(kept['/p/s1.jsonl']?.monthParts).toEqual({ '2026-10': [1, 10, 100, 1000] })
    expect(kept['/p/s2.jsonl']?.monthParts).toEqual({ '2026-11': [5, 50, 500, 5000] })
    expect(kept['/p/s2/subagents/a1.jsonl']?.monthParts).toEqual({ '2026-11': [5, 50, 500, 5000] })
    expect(kept['/p/s2.jsonl']?.months).toEqual({ '2026-11': 5555 })
    expect(kept['/p/s2.jsonl']?.days).toEqual({ [dayKey('2026-11-20T12:00:00Z')]: 5555 })
  })

  test('tokens_upgrade_from_0_3_0_store', async ($, on) => {
    const seed = TRANSCRIPTS()
    const size = (path: string) => new TextEncoder().encode(seed.files?.[path] ?? '').length
    const at = (iso: string) => Date.parse(iso)
    const s0Days = { [dayKey('2026-10-01T12:00:00Z')]: 1_000_000 }
    // 0.3.0's shape: months, days and ids, no month split; offsets where 0.3.0 stopped
    seed.store = {
      'tokens:/p': {
        files: {
          '/p/s0.jsonl': { offset: 500, first: at('2026-10-01T12:00:00Z'), parts: [0, 0, 0, 1_000_000], months: { '2026-10': 1_000_000 }, days: s0Days, ids: [] },
          '/p/s1.jsonl': {
            offset: size('/p/s1.jsonl'), first: at('2026-10-08T12:00:00Z'), parts: [1, 10, 100, 1000], months: { '2026-10': 1111 },
            days: { [dayKey('2026-10-08T12:00:00Z')]: 1111 }, ids: [idHash('a')],
          },
          '/p/s2.jsonl': {
            offset: new TextEncoder().encode(S2_DONE).length, first: at('2026-11-20T12:00:00Z'), parts: [5, 50, 500, 5000], months: { '2026-11': 5555 },
            days: { [dayKey('2026-11-20T12:00:00Z')]: 5555 }, ids: [idHash('b'), idHash('c')],
          },
          '/p/s2/subagents/a1.jsonl': {
            offset: size('/p/s2/subagents/a1.jsonl'), first: at('2026-11-21T12:00:00Z'), parts: [5, 50, 500, 5000], months: { '2026-11': 5555 },
            days: { [dayKey('2026-11-21T12:00:00Z')]: 5555 }, ids: [idHash('e')],
          },
        },
      },
    }
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)

    const pane = await mount($)

    for (const path of ['/p/s1.jsonl', '/p/s2.jsonl', '/p/s2/subagents/a1.jsonl']) expect(seen.reads.find(r => r.path === path)?.offset).toBe(0)
    const writes = seen.stores.filter(x => x.key === 'tokens:/p')
    expect(writes).toHaveLength(1) // once, when the recount ended
    const kept = writes[0]?.value.files ?? {}
    expect(kept['/p/s1.jsonl']?.parts).toEqual([1, 10, 100, 1000])
    expect(kept['/p/s2.jsonl']?.parts).toEqual([5, 50, 500, 5000])
    expect(kept['/p/s2.jsonl']?.monthParts).toEqual({ '2026-11': [5, 50, 500, 5000] })
    expect(kept['/p/s2/subagents/a1.jsonl']?.parts).toEqual([5, 50, 500, 5000])
    expect(kept['/p/s0.jsonl']).toMatchObject({ parts: [0, 0, 0, 1_000_000], months: { '2026-10': 1_000_000 }, days: s0Days, monthParts: {} })
    expect(await cells(pane, 'session')).toEqual(['      10', '     100', '   11.0K', '   11.1K'])
    expect(await cells(pane, 'month')).toEqual(['      10', '     100', '   11.0K', '   11.1K'])
  })

  test('tokens_upgrade_from_0_3_0_waits_for_a_whole_listing', async ($, on) => {
    const seed = TRANSCRIPTS()
    const end = (path: string) => new TextEncoder().encode(path === '/p/s2.jsonl' ? S2_DONE : (seed.files?.[path] ?? '')).length
    seed.deny = ['/p/s2/subagents']
    // 0.3.0's shape: s2 listed, a1 in the folder that won't list; no month split
    seed.store = {
      'tokens:/p': {
        files: {
          '/p/s2.jsonl': { offset: end('/p/s2.jsonl'), parts: [5, 50, 500, 5000], months: { '2026-11': 5555 }, days: {}, ids: [idHash('b'), idHash('c')] },
          '/p/s2/subagents/a1.jsonl': { offset: end('/p/s2/subagents/a1.jsonl'), parts: [5, 50, 500, 5000], months: { '2026-11': 5555 }, days: {}, ids: [idHash('e')] },
        },
      },
    }
    const seen = await start($, on, seed)

    await seen.clock.advance(1_000)

    // not whole: none counted again (s2 not even read), none given a split
    expect(seen.reads.some(r => r.path === '/p/s2.jsonl')).toBe(false)
    const kept = seen.stores.filter(x => x.key === 'tokens:/p').at(-1)?.value.files
    expect(kept?.['/p/s2.jsonl']?.monthParts).toBeUndefined()
    expect(kept?.['/p/s2/subagents/a1.jsonl']?.monthParts).toBeUndefined()
  })

  test('tokens_month_with_an_unsplit_part', async ($, on) => {
    const seed = TRANSCRIPTS()
    const first = Date.parse('2026-11-02T12:00:00Z')
    // gone from disk, kept by 0.3.0 with 1,000 tokens this month and no split
    seed.store = {
      'tokens:/p': {
        files: { '/p/s0.jsonl': { offset: 500, first, parts: [0, 0, 0, 1000], months: { [`2026-11`]: 1000 }, days: { [dayKey(first)]: 1000 }, ids: [] } },
      },
    }
    const seen = await start($, on, seed)
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // November: 11,110 split + s0's 1,000 unsplit
    expect(await cells(pane, 'month')).toEqual(['      10', '     100', '   11.0K', '   12.1K'])
    expect(await textOf(pane, 'tokens:unsplit')).toBe('1.0K of November not split (transcripts deleted)')
    expect((await pane.find({ type: 'Text', text: /not split/ }))?.props.dimColor).toBe(true)
  })

  test('tokens_chart_fills_the_width', async ($, on) => {
    // a reply on each of the last 30 days and on the 15th of each of the last 12 months: every slot drawn
    const replies = [
      ...Array.from({ length: 30 }, (_, i) => usage(`d${i}`, daysBack(i), [0, 0, 0, 100 + i])),
      ...Array.from({ length: 12 }, (_, i) => usage(`m${i}`, new Date(2026, 10 - i, 15, 12).toISOString(), [0, 0, 0, 1000])),
    ]
    const seen = await start($, on, { transcript: '/p/s2.jsonl', files: { '/p/s2.jsonl': replies.map(l => `${l}\n`).join('') } })
    await seen.clock.advance(1_000)
    const pane = await mount($)
    const bottom = async () => ((await chartRows(pane))[7] ?? '').replace(/ {2}0$/, '')

    const at48 = runs(await bottom())
    await pane.redraw({ ...PANE, bodyColumns: 100 })
    const at100 = runs(await bottom())
    await pane.redraw({ ...PANE, bodyColumns: 60 })
    await pane.press({ key: 'tokens:view:months' })
    const months60 = runs(await bottom())
    const labels60 = await textOf(pane, 'tokens:chart:labels')
    const widest = Math.max(...(await chartRows(pane)).map(r => r.length))

    // bars of one width, every gap 1 or 2, the space after the last bar no wider than a gap
    const spread = (r: { at: number; width: number }[], width: number) => {
      const gaps = r.slice(1).map((x, i) => x.at - ((r[i]?.at ?? 0) + (r[i]?.width ?? 0)))
      const last = r.at(-1) ?? { at: 0, width: 0 }
      return { bars: r.length, widths: [...new Set(r.map(x => x.width))], first: r[0]?.at, gaps: [...new Set(gaps)].sort(), tail: width - last.at - last.width <= Math.max(...gaps) }
    }
    expect(spread(at48, 40)).toEqual({ bars: 20, widths: [1], first: 0, gaps: [1], tail: true })
    expect(spread(at100, 92)).toEqual({ bars: 30, widths: [2], first: 0, gaps: [1, 2], tail: true })
    expect(spread(months60, 52)).toEqual({ bars: 12, widths: [3], first: 0, gaps: [1, 2], tail: true })
    // each month's 3 letters under its bar, December 2025 to November 2026
    const names = months60.map(x => labels60.slice(x.at, x.at + 3))
    expect(names).toEqual(['Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'])
    expect(widest).toBeLessThanOrEqual(60)
  })

  test('tokens_chart_in_between_width', async ($, on) => {
    const replies = Array.from({ length: 30 }, (_, i) => usage(`d${i}`, daysBack(i), [0, 0, 0, 100]))
    const seen = await start($, on, { transcript: '/p/s2.jsonl', files: { '/p/s2.jsonl': replies.map(l => `${l}\n`).join('') } })
    await seen.clock.advance(1_000)
    const pane = await mount($)

    await pane.redraw({ ...PANE, bodyColumns: 97 })

    const r = runs(((await chartRows(pane))[7] ?? '').replace(/ {2}0$/, ''))
    const gaps = new Set(r.slice(1).map((x, i) => x.at - ((r[i]?.at ?? 0) + (r[i]?.width ?? 0))))
    expect(r).toHaveLength(30)
    expect(new Set(r.map(x => x.width))).toEqual(new Set([1]))
    expect(gaps).toEqual(new Set([1, 2]))
    expect(r[0]?.at).toBe(0)
    expect(r.at(-1)?.at).toBeGreaterThanOrEqual(86)
  })

  test('tokens_chart_y_axis', async ($, on) => {
    const seen = await start($, on, TRANSCRIPTS())
    await seen.clock.advance(1_000)

    const pane = await mount($)

    // 5,555 the max; half of it rounded, 2,778, on row 5; 0 on row 8; no label on the others
    const axis = (await chartRows(pane)).map(r => r.slice(40))
    expect(axis).toEqual(['  5.6K', '', '', '', '  2.8K', '', '', '  0'])
  })
})
