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

/** What each tracker holds, read at call time so a test may swap it; a missing one was never written. */
type Seed = { tracker?: Tracker; git?: GitView; tests?: { shape: string; value: TestView } }

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

function setup(on: On, seed: Seed) {
  const clock = mock.clock(on)
  const seen = { clock, opened: [] as { id: string; title?: string; columns?: number }[], commands: [] as string[], sets: [] as string[], invalidates: 0 }
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
const keys = async (pane: Pane) => (await pane.findAll({ type: 'Box' })).map(b => b.key ?? '')
const color = async (pane: Pane, text: RegExp) => (await pane.find({ type: 'Text', text }))?.props.color

describe('overview', () => {
  test('session_start_opens_overview_tab', async ($, on) => {
    const seen = await start($, on)

    expect(seen.opened).toHaveLength(1)
    expect(seen.opened[0]).toMatchObject({ id: 'overview', title: 'Overview', columns: 48 })
    expect(seen.commands).toContain('overview')
  })

  test('command_reopens_overview_tab', async ($, on) => {
    const seen = await start($, on)
    seen.opened.length = 0

    const ran = await $.command.run({
      command: 'overview', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 },
    })

    expect(seen.opened).toHaveLength(1)
    expect(seen.opened[0]).toMatchObject({ id: 'overview', title: 'Overview', columns: 48 })
    expect(ran).toMatchObject({ text: 'Overview pane opened.' })
  })

  test('empty_trackers_show_empty_lines', async ($, on) => {
    await start($, on)

    const pane = await mount($)

    const titles = (await keys(pane)).filter(k => k.endsWith(':title'))
    expect(titles).toEqual(['plan:title', 'git:title', 'tests:title'])
    expect(await textOf(pane, 'plan:title')).toBe('PLAN')
    expect(await textOf(pane, 'plan:empty')).toBe('No plan tracked yet.')
    expect(await textOf(pane, 'git:title')).toBe('GIT')
    expect(await textOf(pane, 'git:empty')).toBe('Reading git…')
    expect(await textOf(pane, 'tests:title')).toBe('TESTS')
    expect(await textOf(pane, 'tests:empty')).toBe('No test runs yet.')
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

  // The trackers' 1 s ticks, standing in: each redraws only its own panes; Overview follows them, no redraw call here.
  // An inline plugin has no closure over this file (gotcha-test-kit-spawn-fake-inline-plugin-text-keys): literals only.
  test(
    'plan_total_advances_on_screen_and_stops_when_waiting',
    {
      plugins: [{
        name: 'plan-tracker',
        register(on) {
          on('session.start', ($, e, next) => {
            $.clock.every(1_000, () => $.ui.invalidate('ui.render'))
            return next(e)
          })
        },
      }],
    },
    async ($, on) => {
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
      await seen.clock.advance(2_000) // the stand-in keeps ticking: the paused time must still not count
      const waited = await textOf(pane, 'plan:time:p1:total')

      expect(before).toContain('27m 57s')
      expect(ticked).toContain('27m 58s')
      expect(waited).toContain('27m 58s')
    },
  )

  test(
    'test_time_advances_on_screen',
    {
      plugins: [{
        name: 'test-tracker',
        register(on) {
          on('session.start', ($, e, next) => {
            $.clock.every(1_000, () => $.ui.invalidate('ui.render'))
            return next(e)
          })
        },
      }],
    },
    async ($, on) => {
      const seed: Seed = { tests: shaped(TESTS) }
      const seen = await start($, on, seed)
      const pane = await mount($)

      await seen.clock.advance(1_000)
      const running = await textOf(pane, 'card:bar')
      const [live, prior] = TESTS.runs
      seed.tests = shaped({
        ...TESTS,
        runs: [{ ...live!, exit: 0, endedAt: T + 1_000 }, prior!],
        last: { ...TESTS.last, branch: { id: 2, command: COMMAND, counts: counts(12, 0), exit: 0, endedAt: T + 1_000 } },
      })
      await seen.clock.advance(60_000)

      expect(running).toContain('· 9s')
      expect(await textOf(pane, 'card:last:branch')).toContain('1m ago')
    },
  )

  // Inline plugins stand in for the trackers: each redraws its own panes once, at 1, 2 and 3 s.
  test(
    'invalidate_relayed_only_from_plan_and_test_tracker',
    {
      plugins: [
        {
          name: 'git-tracker',
          register(on) {
            on('session.start', ($, e, next) => {
              $.clock.after(1_000, () => $.ui.invalidate('ui.render'))
              return next(e)
            })
          },
        },
        {
          name: 'plan-tracker',
          register(on) {
            on('session.start', ($, e, next) => {
              $.clock.after(2_000, () => $.ui.invalidate('ui.render'))
              return next(e)
            })
          },
        },
        {
          name: 'test-tracker',
          register(on) {
            on('session.start', ($, e, next) => {
              $.clock.after(3_000, () => $.ui.invalidate('ui.render'))
              return next(e)
            })
          },
        },
      ],
    },
    async ($, on) => {
      const seen = await start($, on)
      seen.invalidates = 0

      await seen.clock.advance(1_000)
      const fromGit = seen.invalidates
      await seen.clock.advance(1_000)
      const fromPlan = seen.invalidates
      await seen.clock.advance(1_000)

      expect(fromGit).toBe(1) // git-tracker's own, not relayed
      expect(fromPlan).toBe(3) // + plan-tracker's own and overview's relay of it
      expect(seen.invalidates).toBe(5) // + test-tracker's own and overview's relay of it
    },
  )

  test('plan_row_sections_in_order_with_totals', async ($, on) => {
    const group = (id: string, file: string, n: number, ok: number) => ({ id, title: `plan ${id}`, file, approvedAt: '2026-11-23', items: items(n, ok) })
    const tracker: Tracker = {
      nextId: 60,
      plans: [group('t1', '', 1, 0), group('m1', PLAN_FILE, 44, 42), group('d1', '/repo/docs/superpowers/plans/x.md', 2, 1), group('m2', PLAN_FILE, 2, 1)],
    }
    await start($, on, { tracker })

    const pane = await mount($)

    const sections = (await keys(pane)).filter(k => k.startsWith('plan:section:'))
    expect(sections).toEqual(['plan:section:docs', 'plan:section:mode', 'plan:section:tasks'])
    expect(await textOf(pane, 'plan:section:docs')).toBe('PLAN DOCS1/2')
    expect(await textOf(pane, 'plan:section:mode')).toBe('PLAN MODE43/46')
    expect(await textOf(pane, 'plan:section:tasks')).toBe('TASKS0/1')
    expect(await textOf(pane, 'plan:head:m2')).toContain('▰▰▰▰▰▱▱▱▱▱ 1/2')
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
})
