/**
 * Overview pane: plan-tracker's, git-tracker's and test-tracker's session state in one tab, a row each. It reads their
 * state (any plugin reads any value; the owner alone writes it) and runs nothing: no git, no gh, no tests, no model.
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
import type { PluginState, Register, ShapedValue } from 'claude-code'
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
/** Whose redraws Overview follows: their timers tick the plan clock and a running test; git-tracker's writes redraw. */
const RELAY = new Set(['plan-tracker', 'test-tracker'])

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PANE, description: 'Open the Overview pane: plan, git and tests in one tab' })
    void $.ui.open({ id: PANE, title: 'Overview', columns: DOCK_COLUMNS })
    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Overview', columns: DOCK_COLUMNS })
    return { text: opened.isPlaced ? 'Overview pane opened.' : `Overview pane waits: ${opened.reason}` }
  })

  // A tracker's `$.ui.invalidate` redraws only its own panes; the live times here follow its timer. Our own call never
  // comes back through this hook, so it cannot loop. A failure here passes the event on, never blocks it.
  on('ui.invalidate', async ($, e, next) => {
    const done = await next(e)
    if (RELAY.has(next.origin.plugin)) $.ui.invalidate('ui.render')
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const t = await read($, plan)
    const g = await read($, git)
    const v = await read($, tests)
    const now = await $.clock.now()

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
            <Text dimColor>{`${ok}/${p.items.length}${spent > 0 ? ` ${fmt(spent)}` : ''}`}</Text>
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
            <Text bold>PLAN</Text>
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
          const plans = t.plans.filter(p => sourceOf(p) === source)
          if (plans.length === 0) return null
          const items = plans.flatMap(p => p.items)
          return (
            <Box flexDirection="column">
              <Box key={`plan:section:${source}`} flexDirection="row" gap={1}>
                <Box flexGrow={1}>
                  <Text bold>{label}</Text>
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
        <Box key="git:title">
          <Text bold>GIT</Text>
        </Box>
        {gitBody}
      </Box>
    )

    // ---- tests ----

    const tcs = v.branch?.tcs ?? []
    const testsTitle = (
      <Box key="tests:title">
        <Text bold>TESTS</Text>
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

    return (
      <Box flexDirection="column" gap={1}>
        {planRow}
        {gitRow}
        {testsRow}
      </Box>
    )
  })
}
