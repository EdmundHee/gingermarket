import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/repo'
const RUN = 'mcp__test-tracker__run_tests'
const CASES = `${CWD}/tests/TEST_CASES.md`
const PANE = {
  title: 'Tests', isFocused: false, bodyColumns: 48, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 }, view: {},
}

/** One piece of output: stdout text, a piece held until the test releases it, stderr text, or a stream that throws. */
type Piece = string | Promise<string> | { err: string } | { stderr: string }
/** How the fake child behaves: its pieces, how it ends, or a start that fails. */
type Script = { pieces: Piece[]; code?: number | null; signal?: string | null; reject?: string }

/** A piece that stays unwritten until the test releases it with the text. */
function held() {
  let release!: (text: string) => void
  const piece = new Promise<string>(r => { release = r })
  return { piece, release }
}

/** Answers `process.spawn` by the command `sh -c` was given; records argv, env and whether each stream ended. */
function spawner(on: On, scripts: Record<string, Script>) {
  const seen = { argv: [] as string[][], env: [] as unknown[], cwd: [] as (string | undefined)[], ended: [] as string[] }
  on('process.spawn', async function* (_$, e) {
    seen.argv.push([...e.argv])
    seen.env.push(e.env)
    seen.cwd.push(e.cwd)
    const command = e.argv[2] ?? ''
    const script = scripts[command] ?? { pieces: [] }
    try {
      // a stand-in for a call on $ answers { value } or { deny }: a child that cannot start, or a stream that broke
      if (script.reject !== undefined) return { deny: script.reject }
      for (const p of script.pieces) {
        if (typeof p === 'object' && 'err' in p) return { deny: p.err }
        if (typeof p === 'object' && 'stderr' in p) yield { stream: 'stderr' as const, text: p.stderr }
        else yield { stream: 'stdout' as const, text: await p }
      }
      return { value: { code: script.code === undefined ? 0 : script.code, signal: script.signal ?? null } }
    } finally {
      seen.ended.push(command)
    }
  })
  return seen
}

/** One git answer: stdout (exit 0), an exit with stdout, a git that cannot start, or one held open (a promise).
 *  Commands not listed exit 1: not a repo. */
type GitAnswer = string | { exit: number; stdout?: string } | 'missing'
type GitReply = GitAnswer | Promise<GitAnswer>

/** Answers `process.run` from `answers` (read at call time, so a test may change them); records each argv. */
function git(on: On, answers: Record<string, GitReply>) {
  const ran: string[] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.join(' ')
    ran.push(argv)
    const a = await (answers[argv] ?? { exit: 1 })
    if (a === 'missing') return { deny: 'git: command not found' }
    const { exit, stdout } = typeof a === 'string' ? { exit: 0, stdout: a } : { exit: a.exit, stdout: a.stdout ?? '' }
    return { value: { exitCode: exit, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return ran
}

/** `bash`: answers every Bash call in place of an empty success. `git`: the repo's answers; none, not a repo. */
type Setup = {
  scripts?: Record<string, Script>
  files?: Record<string, string>
  bash?: () => Promise<unknown>
  git?: Record<string, GitReply>
  bashRule?: 'allow' | 'ask' | 'deny' // what the person's Bash rules say of a run_tests command
}

function setup(on: On, o: Setup = {}) {
  const clock = mock.clock(on)
  const files = o.files ?? {}
  const seen = {
    opened: [] as { id: string; title?: string; columns?: number }[],
    tools: [] as Record<string, unknown>[],
    spawn: spawner(on, o.scripts ?? {}),
    ran: git(on, o.git ?? {}),
    files,
    clock,
    settle: () => clock.settle(),
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => {
    seen.tools.push(e as unknown as Record<string, unknown>)
    return { value: { tool: `mcp__test-tracker__${e.name}` } }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('tool.call', { tool: 'Bash' }, async () =>
    (o.bash ? await o.bash() : { result: { stdout: '', stderr: '', interrupted: false } }) as never)
  on('tool.check', () => ({ decision: o.bashRule ?? 'allow', reason: 'Bash(rm:*)' }) as never)
  on('session.cwd', () => ({ value: CWD }))
  on('classic.SessionStart', () => ({}))
  return seen
}

async function start($: Engine, on: On, o: Setup = {}) {
  const seen = setup(on, o)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.settle()
  return seen
}

const run = ($: Engine, command: string, agentId?: string, scope?: string) =>
  $.tool.run({
    tool: RUN, command, ...(agentId === undefined ? {} : { agentId }), ...(scope === undefined ? {} : { scope }),
  } as never)

const resultOf = (r: unknown) => String((r as { result?: unknown }).result ?? '')

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'test-tracker', surface: 'terminal', component: 'Pane', requestId: 'test-tracker', props: PANE })

type Pane = Awaited<ReturnType<typeof mount>>
const textOf = async (pane: Pane, key: string) => (await pane.find({ key }))?.text ?? ''
const has = async (pane: Pane, key: string) => (await pane.find({ key })) !== undefined

/** A TEST_CASES.md table row: id, feature and code test; the cells between are filler. */
const row = (id: string, feature: string, code: string) => `| ${id} | ${feature} | unit | p | s | e | ${code} | todo |`

describe('test-tracker', () => {
  test('session_start_opens_tests_tab', async ($, on) => {
    const seen = await start($, on)

    const pane = await mount($)

    expect(seen.opened[0]).toMatchObject({ id: 'test-tracker', title: 'Tests', columns: 48 })
    expect(await textOf(pane, 'empty')).toBe('No test runs yet.')
  })

  test('command_opens_tests_tab', async ($, on) => {
    const seen = await start($, on)
    seen.opened.length = 0

    const ran = await $.command.run({
      command: 'test-tracker', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 },
    })

    expect(seen.opened.map(o => o.id)).toContain('test-tracker')
    expect(ran).toMatchObject({ text: 'Tests pane opened.' })
  })

  test('run_tests_shows_rows_while_running', async ($, on) => {
    const rest = held()
    const seen = await start($, on, { scripts: { 'claude plugin test x': { pieces: ['(pass) s > a_works [1ms]\n', rest.piece] } } })

    const call = run($, 'claude plugin test x')
    let isDone = false
    void call.then(() => { isDone = true })
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'head:1')).toContain('▶')
    expect(await textOf(pane, 'head:1')).toContain('claude plugin test x')
    expect(await textOf(pane, 'stat:1')).toContain('✓ 1')
    expect(await textOf(pane, 'stat:1')).toContain('last: a_works')
    expect(await textOf(pane, 'row:1:0')).toContain('✓ a_works')
    expect(isDone).toBe(false)
    expect(seen.spawn.argv[0]).toEqual(['/bin/sh', '-c', 'claude plugin test x'])
    expect(seen.spawn.env[0]).toMatchObject({ PYTHONUNBUFFERED: '1', NO_COLOR: '1' })
    rest.release('\n')
    await call
  })

  test('run_tests_result_keeps_failures_drops_passes', async ($, on) => {
    const seen = await start($, on, {
      scripts: { 'claude plugin test x': { pieces: ['(pass) s > a [1ms]\nerror: boom\n(fail) s > b [2ms]\n'], code: 1 } },
    })

    const result = resultOf(await run($, 'claude plugin test x'))
    await seen.settle()
    const pane = await mount($)

    expect(result.startsWith('exit 1 · ✓ 1 ✗ 1')).toBe(true)
    expect(result).toContain('error: boom')
    expect(result).toContain('(fail) s > b')
    expect(result).not.toContain('(pass) s > a')
    expect(await textOf(pane, 'head:1')).toContain('✗')
  })

  test('line_cut_between_pieces_parsed_once', async ($, on) => {
    // cut inside the marker: without a carry neither half is a row
    const seen = await start($, on, { scripts: { 'bun test': { pieces: ['(pa', 'ss) s > a [1ms]\n'] } } })

    await run($, 'bun test')
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'row:1:0')).toContain('✓ a')
    expect(await has(pane, 'row:1:1')).toBe(false)
    expect(await textOf(pane, 'stat:1')).toContain('✓ 1')
  })

  test('pytest_verbose_rows_and_now', async ($, on) => {
    const rest = held()
    const seen = await start($, on, {
      scripts: { 'pytest -v': { pieces: ['t.py::test_a PASSED [33%]\nt.py::test_s SKIPPED [66%]\nt.py::test_b ', rest.piece], code: 1 } },
    })

    const call = run($, 'pytest -v')
    await seen.settle()
    const pane = await mount($)
    const during = await textOf(pane, 'stat:1')
    rest.release('FAILED [100%]\n')
    await call
    await seen.settle()

    expect(during).toContain('now: test_b')
    expect(during).toContain('✓ 1')
    expect(during).toContain('○ 1')
    expect(await textOf(pane, 'row:1:0')).toContain('✓ test_a')
    expect(await textOf(pane, 'row:1:1')).toContain('○ test_s')
    expect(await textOf(pane, 'row:1:2')).toContain('✗ test_b')
  })

  test('pytest_quiet_dots_count_and_summary_names', async ($, on) => {
    const rest = held()
    const seen = await start($, on, { scripts: { 'pytest -q': { pieces: ['..Fs [ 80%]\n', rest.piece], code: 1 } } })

    const call = run($, 'pytest -q')
    await seen.settle()
    const pane = await mount($)
    const during = await textOf(pane, 'stat:1')
    rest.release('FAILED t.py::test_c - assert 1\n')
    await call
    await seen.settle()
    const after = await textOf(pane, 'stat:1')

    expect(during).toContain('80%')
    expect(after).toContain('✓ 2')
    expect(after).toContain('✗ 1')
    expect(after).toContain('○ 1')
    expect(await textOf(pane, 'row:1:0')).toContain('✗ test_c')
    expect(await has(pane, 'row:1:1')).toBe(false)
  })

  test('vitest_jest_rows_files_not_counted', async ($, on) => {
    const seen = await start($, on, {
      scripts: { 'npm test': { pieces: ['✓ adds 2ms\n× subtracts\n↓ later\n✓ src/a.test.ts (2 tests) 5ms\nPASS src/b.test.js\n'], code: 1 } },
    })

    await run($, 'npm test')
    await seen.settle()
    const pane = await mount($)
    const stat = await textOf(pane, 'stat:1')

    expect(await textOf(pane, 'row:1:0')).toContain('✓ adds')
    expect(await textOf(pane, 'row:1:1')).toContain('✗ subtracts')
    expect(await textOf(pane, 'row:1:2')).toContain('○ later')
    expect(await has(pane, 'row:1:3')).toBe(false)
    expect(stat).toContain('✓ 1')
    expect(stat).toContain('✗ 1')
    expect(stat).toContain('○ 1')
    expect(stat).toContain('last: src/b.test.js')
  })

  test('screen_verdicts_and_current_script', async ($, on) => {
    const rest = held()
    const command = 'sh screen.sh'
    const seen = await start($, on, {
      files: { [CASES]: `${row('TC-012', 'login', 'tests/screen/TC-012.mjs')}\n` },
      scripts: { [command]: { pieces: ['=== tests/screen/TC-012.mjs\n', rest.piece], code: 1 } },
    })

    const call = run($, command)
    await seen.settle()
    const pane = await mount($)
    const during = await textOf(pane, 'stat:1')
    rest.release('TC-012: FAIL\n')
    const result = resultOf(await call)
    await seen.settle()

    expect(during).toContain('now: tests/screen/TC-012.mjs')
    expect(await textOf(pane, 'row:1:0')).toContain('✗ TC-012 login')
    expect(result).toContain('failed: TC-012 login')
  })

  test('test_rows_get_tc_ids_from_code_test_column', async ($, on) => {
    const out = [
      '(pass) s > x_does_y (case 1) [2ms]',
      '(pass) b > dup [1ms]',
      '(pass) z > dup [1ms]',
      '(pass) tests/unit > same [1ms]', // a prefix of two segments
      '(pass) e2 > same [1ms]', // `e2` is in `x/e2e/…` as a substring, no segment: ambiguous
      '(pass) s > moved (tip moved) [1ms]', // the row's own name carries a parameter
      '',
    ].join('\n')
    const seen = await start($, on, {
      files: {
        [CASES]: [
          row('TC-007', 'x feature', 'a/register.test.ts > x_does_y'),
          row('TC-008', 'dup in b', 'b/register.test.ts > dup'),
          row('TC-009', 'dup in c', 'c/register.test.ts > dup'),
          row('TC-010', 'same in unit', 'tests/unit/a.test.ts > same'),
          row('TC-011', 'same in e2e', 'x/e2e/a.test.ts > same'),
          row('TC-012', 'moved', 'g/register.test.ts > moved (head moved / tip moved)'),
        ].join('\n'),
      },
      scripts: { 'bun test': { pieces: [out] } },
    })

    await run($, 'bun test')
    await seen.settle()
    const pane = await mount($)
    const rows = [
      await textOf(pane, 'row:1:0'), await textOf(pane, 'row:1:1'), await textOf(pane, 'row:1:2'),
      await textOf(pane, 'row:1:3'), await textOf(pane, 'row:1:4'), await textOf(pane, 'row:1:5'),
    ]
    delete seen.files[CASES]
    await run($, 'bun test')
    await seen.settle()

    expect(rows[0]).toContain('TC-007 x_does_y (case 1)')
    expect(rows[1]).toContain('TC-008 dup')
    expect(rows[2]).toContain('✓ dup')
    expect(rows[2]).not.toContain('TC-')
    expect(rows[3]).toContain('TC-010 same')
    expect(rows[4]).toContain('✓ same')
    expect(rows[4]).not.toContain('TC-')
    expect(rows[5]).toContain('TC-012 moved (tip moved)')
    expect(await textOf(pane, 'row:2:0')).toContain('x_does_y')
    expect(await textOf(pane, 'row:2:0')).not.toContain('TC-')
  })

  test('bash_test_command_tracked_results_at_end', async ($, on) => {
    const out = held()
    const seen = await start($, on, {
      bash: async () => {
        const text = await out.piece
        return { isError: true, result: text, text }
      },
    })

    const call = $.tool.call({ tool: 'Bash', command: 'pytest -q' })
    await seen.settle()
    const pane = await mount($)
    const head = await textOf(pane, 'head:1')
    const during = await textOf(pane, 'stat:1')
    const rowsDuring = await has(pane, 'row:1:0')
    out.release('..F [100%]')
    await call
    await seen.settle()

    expect(head).toContain('▶')
    expect(head).toContain('pytest -q')
    expect(during).toContain('(bash: results at the end)')
    expect(rowsDuring).toBe(false)
    expect(await textOf(pane, 'stat:1')).toContain('✓ 2')
    expect(await textOf(pane, 'stat:1')).toContain('✗ 1')
    expect(await textOf(pane, 'head:1')).toContain('✗')
  })

  test('bash_non_test_and_background_untracked', async ($, on) => {
    const seen = await start($, on)

    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Bash', command: 'pytest', run_in_background: true })
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'empty')).toBe('No test runs yet.')
  })

  test(
    'abort_stops_child_and_marks_run',
    {
      // an inline plugin loads as a module of its own: no closure over the test, so it waits on the mock clock
      plugins: [{
        name: 'esc',
        tier: 'prepend',
        register: on => {
          on('tool.run', { tool: /^mcp__test-tracker__run_tests$/ }, async ($, e, next) => {
            void next(e).catch(() => undefined)
            await $.clock.sleep(1000)
            return { result: 'interrupted' }
          })
        },
      }],
    },
    async ($, on) => {
      const rest = held()
      const seen = await start($, on, { scripts: { 'pytest -v': { pieces: ['t.py::test_a PASSED\n', rest.piece] } } })

      const call = run($, 'pytest -v')
      await seen.settle()
      await seen.clock.advance(1000)
      await call
      await seen.settle()
      const pane = await mount($)
      rest.release('t.py::test_b PASSED\n')
      await seen.settle()

      expect(await textOf(pane, 'head:1')).toContain('■')
      expect(await textOf(pane, 'head:1')).not.toContain('▶')
      expect(await textOf(pane, 'stat:1')).toContain('stopped')
      expect(seen.spawn.ended).toContain('pytest -v')
      expect(await has(pane, 'row:1:1')).toBe(false)
    },
  )

  test('empty_launch_failure_and_stream_error_end_the_run', async ($, on) => {
    const seen = await start($, on, {
      scripts: {
        nope: { pieces: [], reject: 'ENOENT: nope' },
        'bun test': { pieces: ['(pass) s > a [1ms]\n', { err: 'pipe broke' }] },
      },
    })

    const empty = resultOf(await run($, '  '))
    const pane = await mount($)
    const emptyPane = await textOf(pane, 'empty')
    const launch = resultOf(await run($, 'nope'))
    const broke = resultOf(await run($, 'bun test'))
    await seen.settle()

    expect(empty).toBe('run_tests: command is empty')
    expect(emptyPane).toBe('No test runs yet.')
    expect(launch).toContain('ENOENT: nope')
    expect(broke).toContain('pipe broke')
    expect(await textOf(pane, 'head:1')).toContain('!')
    expect(await textOf(pane, 'head:1')).not.toContain('▶')
    expect(await textOf(pane, 'head:2')).toContain('!')
    expect(await textOf(pane, 'head:2')).not.toContain('▶')
    expect(await textOf(pane, 'stat:2')).toContain('error: pipe broke')
    expect(await textOf(pane, 'row:2:0')).toContain('✓ a')
  })

  test('history_caps_finished_runs_never_drops_running', async ($, on) => {
    const quick = { pieces: ['(pass) s > a [1ms]\n'] }
    const h1 = held()
    const h2 = held()
    const scripts: Record<string, Script> = {
      h1: { pieces: ['(pass) s > h1a [1ms]\n', h1.piece] },
      h2: { pieces: ['(pass) s > h2a [1ms]\n', h2.piece] },
    }
    for (let i = 1; i <= 11; i++) scripts[`c${i}`] = quick
    const seen = await start($, on, { scripts })

    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) await run($, c)
    await seen.settle()
    const pane = await mount($)
    const first = {
      oldest: await has(pane, 'head:1'), kept: await has(pane, 'head:2'),
      newestOpen: await has(pane, 'stat:6'), olderOpen: await has(pane, 'stat:5'),
    }
    const c1 = run($, 'h1')
    const c2 = run($, 'h2')
    await seen.settle()
    const both = { r7: await textOf(pane, 'row:7:0'), r8: await textOf(pane, 'row:8:0') }
    h2.release('\n')
    await c2
    for (const c of ['c7', 'c8', 'c9', 'c10', 'c11']) await run($, c)
    await seen.settle()
    const later = { held: await has(pane, 'head:7'), heldOpen: await has(pane, 'stat:7'), h2: await has(pane, 'head:8') }
    await seen.clock.advance(1000) // h1 ends after every other run
    h1.release('\n')
    const lateResult = resultOf(await c1)
    await seen.settle()
    const order = (await pane.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => /^head:\d+$/.test(k))

    expect(first).toEqual({ oldest: false, kept: true, newestOpen: true, olderOpen: false })
    expect(both.r7).toContain('h1a')
    expect(both.r8).toContain('h2a')
    expect(later).toEqual({ held: true, heldOpen: true, h2: false })
    // the run that ended last is kept, and answered as it ended, though it started before five others
    expect(lateResult.startsWith('exit 0')).toBe(true)
    expect(order).toEqual(['head:13', 'head:12', 'head:11', 'head:10', 'head:7'])
  })

  test('elapsed_redraws_each_second_while_running_then_each_minute', async ($, on) => {
    const rest = held()
    const seen = setup(on, { scripts: { 'bun test': { pieces: ['(pass) s > a [1ms]\n', rest.piece] } } })
    let redraws = 0
    on('ui.invalidate', (_$, e, next) => {
      redraws += 1
      return next(e)
    })
    await seen.clock.set(1_000_000)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

    const call = run($, 'bun test')
    await seen.settle()
    const atStart = redraws
    await seen.clock.advance(3000)
    const whileRunning = redraws - atStart
    const pane = await mount($)
    const head = await textOf(pane, 'head:1')
    rest.release('\n')
    await call
    await seen.settle()
    const atEnd = redraws
    await seen.clock.advance(5000)
    const after5s = redraws - atEnd
    await seen.clock.advance(55_000)
    const after60s = redraws - atEnd

    expect(whileRunning).toBe(3) // one a second, for the elapsed time
    expect(head).toContain('3s')
    expect(after5s).toBe(0) // the run ended: no 1 s redraw
    expect(after60s).toBe(1) // the `… ago` lines redraw once a minute
  })

  test('subagent_run_shows_in_tab', async ($, on) => {
    const seen = await start($, on, { scripts: { 'sh screen.sh': { pieces: ['TC-012: PASS\n'] } } })

    await run($, 'sh screen.sh', 'a1')
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'head:1')).toContain('sub')
    expect(await textOf(pane, 'row:1:0')).toContain('✓ TC-012')
  })

  test('run_tests_not_deferred', async ($, on) => {
    const seen = await start($, on)

    expect(seen.tools.find(t => t.name === 'run_tests')).toMatchObject({ name: 'run_tests', isDeferred: false })
  })
})

// ---- the summary card ------------------------------------------------------------------------------------------------

const BR = 'git rev-parse --abbrev-ref HEAD'
const forkOf = (trunk: string) => `git merge-base HEAD ${trunk}`
const count = (sha: string) => `git rev-list --count ${sha}..HEAD`
const TRACKED = 'git ls-files --error-unmatch tests/TEST_CASES.md'
const diff = (sha: string) => `git diff --color=never --unified=0 ${sha} -- tests/TEST_CASES.md`
/** The diff of TEST_CASES.md adding `rows`, as `git diff --unified=0` prints it. */
const added = (rows: string[]) => `@@ -1,0 +2,${rows.length} @@\n${rows.map(r => `+${r}`).join('\n')}\n`
/** Branch `feat/x` cut from dev at `abc`, 2 commits back, TEST_CASES.md tracked; its diff adds `rows`. */
const featX = (rows: string[] = []): Record<string, GitReply> => ({
  [BR]: 'feat/x\n', [forkOf('dev')]: 'abc\n', [count('abc')]: '2\n', [TRACKED]: 'tests/TEST_CASES.md\n', [diff('abc')]: added(rows),
})
const RUN_LINE = 'run: `npm test`'

describe('test-tracker card', () => {
  test('card_scope_from_input', async ($, on) => {
    const rest = held()
    const seen = await start($, on, { git: featX(), scripts: { 'pytest -q': { pieces: ['..\n', rest.piece] } } })

    const call = run($, 'pytest -q', undefined, 'focused')
    await seen.settle()
    const pane = await mount($)
    const head = await textOf(pane, 'card:head')
    rest.release('\n')
    await call

    expect(head).toContain('feat/x')
    expect(head).toContain('Focused test')
  })

  test('card_scope_guessed_from_command', async ($, on) => {
    const quick = { pieces: ['(pass) s > a [1ms]\n'] }
    const seen = await start($, on, {
      files: { [CASES]: `${RUN_LINE}\n` },
      scripts: { 'npm test': quick, 'pytest t.py::test_a': quick, 'bun test': quick, 'sh screen.sh tests/screen/TC-012.mjs': quick },
      bash: async () => ({ result: { stdout: 't.py::test_login PASSED [100%]\n', stderr: '', interrupted: false } }),
    })
    const pane = await mount($)
    const heads: string[] = []

    for (const c of ['npm test', 'pytest t.py::test_a', 'bun test']) {
      await run($, c)
      await seen.settle()
      heads.push(await textOf(pane, 'card:head'))
    }
    await $.tool.call({ tool: 'Bash', command: 'pytest -k login' })
    await seen.settle()
    heads.push(await textOf(pane, 'card:head'))
    const bashRun = await textOf(pane, 'head:4') // the card read run 4 itself, not run 3 left over
    await run($, 'sh screen.sh tests/screen/TC-012.mjs')
    await seen.settle()
    heads.push(await textOf(pane, 'card:head'))

    expect(heads[0]).toContain('Full suite')
    expect(heads[1]).toContain('Focused test')
    expect(heads[2]).toContain('Branch tests')
    expect(heads[3]).toContain('Branch tests')
    expect(bashRun).toContain('pytest -k login')
    expect(heads[4]).toContain('Focused test')
  })

  test('card_flags_full_scope_off_the_run_line', async ($, on) => {
    const seen = await start($, on, { files: { [CASES]: `${RUN_LINE}\n` }, scripts: { 'bun test': { pieces: ['(pass) s > a [1ms]\n'] } } })

    await run($, 'bun test', undefined, 'full')
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'card:head')).toContain('Full suite')
    expect(await textOf(pane, 'card:head')).toContain('not the run: line')
  })

  test('card_bar_expects_last_same_command_total', async ($, on) => {
    const scripts: Record<string, Script> = { 'bun test': { pieces: ['(pass) s > a [1ms]\n(pass) s > b [1ms]\n(pass) s > c [1ms]\n(pass) s > d [1ms]\n'] } }
    const seen = await start($, on, { scripts })
    const pane = await mount($)

    await run($, 'bun test')
    await seen.settle()
    const first = await textOf(pane, 'card:bar')
    const rest = held()
    scripts['bun test'] = { pieces: ['(pass) s > a [1ms]\n(pass) s > b [1ms]\n', rest.piece] }
    const call = run($, 'bun test')
    await seen.settle()
    const second = await textOf(pane, 'card:bar')
    rest.release('\n')
    await call
    // the newest earlier run is the measure, and a run that never finished is none: 3 tests, then a failed start
    scripts['bun test'] = { pieces: ['(pass) s > a [1ms]\n(pass) s > b [1ms]\n(pass) s > c [1ms]\n'] }
    await run($, 'bun test')
    scripts['bun test'] = { pieces: [], reject: 'ENOENT: bun' }
    await run($, 'bun test')
    const again = held()
    scripts['bun test'] = { pieces: ['(pass) s > a [1ms]\n(pass) s > b [1ms]\n', again.piece] }
    const fifth = run($, 'bun test')
    await seen.settle()
    const third = await textOf(pane, 'card:bar')
    again.release('\n')
    await fifth

    expect(first).not.toContain('▰')
    expect(first).toContain('4')
    expect(second).toContain('▰▰▰▰▰▱▱▱▱▱ 2/4')
    expect(third).toContain('▰▰▰▰▰▰▰▱▱▱ 2/3')
  })

  test('card_lists_branch_tcs_and_their_results', async ($, on) => {
    const rows = [
      row('TC-301', 'a', 'tests/screen/TC-301.mjs'),
      row('TC-302', 'b', 'tests/screen/TC-302.mjs'),
      row('TC-303', 'c', 'x/y.test.ts > c_case'),
      row('TC-304', 'd', 't.py::test_s'),
      row('TC-305', 'e', 'manual'),
    ]
    const seen = await start($, on, {
      git: featX(rows),
      files: { [CASES]: rows.join('\n') },
      scripts: { 'sh screen.sh': { pieces: ['TC-301: PASS\nTC-302: FAIL\nt.py::test_s SKIPPED\n'], code: 1 } },
    })
    const pane = await mount($)
    const before = await textOf(pane, 'card:tcs')

    await run($, 'sh screen.sh')
    await seen.settle()
    const after = await textOf(pane, 'card:tcs')

    expect(before).toContain('Branch TCs 5')
    expect(before).toContain('✓ 0')
    expect(before).toContain('· 5 not run')
    expect(after).toContain('✓ 1')
    expect(after).toContain('✗ 1')
    expect(after).toContain('○ 1')
    expect(after).toContain('· 2 not run')
    expect(await textOf(pane, 'card:tc:TC-302')).toContain('✗ TC-302 b')
    expect(await textOf(pane, 'card:tc:TC-303')).toContain('· TC-303 c')
    expect(await textOf(pane, 'card:tc:TC-305')).toContain('· TC-305 e (manual)')
    expect(await has(pane, 'card:tc:TC-301')).toBe(false)
  })

  test('card_no_branch_tcs_on_trunk_or_outside_git', async ($, on) => {
    // starts on a feature branch with a branch TC, so losing the branch must take its TCs away too
    const answers = featX([row('TC-301', 'a', 'manual')])
    const seen = await start($, on, { git: answers, scripts: { 'bun test': { pieces: ['(pass) s > a [1ms]\n'] } } })
    const pane = await mount($)
    const onFeature = await textOf(pane, 'card:tcs')

    answers[BR] = 'dev\n'
    await run($, 'bun test')
    await seen.settle()
    const onTrunk = { head: await textOf(pane, 'card:head'), tcs: await has(pane, 'card:tcs') }
    answers[BR] = 'feat/x\n'
    await run($, 'bun test')
    await seen.settle()
    const back = await has(pane, 'card:tcs')
    delete answers[BR]
    await run($, 'bun test')
    await seen.settle()
    const outside = { head: await textOf(pane, 'card:head'), tcs: await has(pane, 'card:tcs') }
    answers[BR] = 'missing' // git cannot start: a failed read, never an unhandled rejection
    await run($, 'bun test')
    await seen.settle()
    const noGit = { head: await textOf(pane, 'card:head'), tcs: await has(pane, 'card:tcs') }

    expect(onFeature).toContain('Branch TCs 1')
    expect(onTrunk.head).toContain('dev')
    expect(onTrunk.head).toContain('Branch tests')
    expect(onTrunk.tcs).toBe(false)
    expect(back).toBe(true)
    expect(outside.head).toContain('Branch tests')
    expect(outside.head).not.toContain('feat/x')
    expect(outside.tcs).toBe(false)
    expect(noGit.head).not.toContain('feat/x')
    expect(noGit.tcs).toBe(false)
  })

  test('card_run_does_not_wait_on_git', async ($, on) => {
    const branch = held()
    const answers = featX()
    answers[BR] = branch.piece
    const seen = await start($, on, { git: answers, scripts: { 'bun test': { pieces: ['(pass) s > a [1ms]\n'] } } })

    const result = resultOf(await run($, 'bun test'))
    const pane = await mount($)
    const whileHeld = await textOf(pane, 'card:head')
    branch.release('feat/x\n')
    await seen.settle()

    expect(result.startsWith('exit 0')).toBe(true)
    expect(whileHeld).not.toContain('feat/x')
    expect(await textOf(pane, 'card:head')).toContain('feat/x')
  })

  test(
    'card_shows_last_result_per_scope',
    {
      // stops the run named `esc me` the way Esc does: answers above while the call is pending
      plugins: [{
        name: 'esc',
        tier: 'prepend',
        register: on => {
          on('tool.run', { tool: /^mcp__test-tracker__run_tests$/ }, async ($, e, next) => {
            if ((e as { command?: unknown }).command !== 'esc me') return next(e)
            void next(e).catch(() => undefined)
            await $.clock.sleep(1000)
            return { result: 'interrupted' }
          })
        },
      }],
    },
    async ($, on) => {
      const rest = held()
      const seen = setup(on, {
        scripts: {
          'npm test': { pieces: ['(pass) s > a [1ms]\n(pass) s > b [1ms]\n(pass) s > c [1ms]\n'] },
          'bun test': { pieces: ['(pass) s > a [1ms]\n(fail) s > b [1ms]\n'], code: 1 },
          'esc me': { pieces: ['(pass) s > a [1ms]\n', rest.piece] },
          nope: { pieces: [], reject: 'ENOENT: nope' },
        },
      })
      await seen.clock.set(1_000_000)
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      const pane = await mount($)

      await run($, 'npm test', undefined, 'full')
      await seen.clock.advance(12 * 60_000)
      await run($, 'bun test', undefined, 'branch')
      await seen.clock.advance(3 * 60_000)
      await seen.settle()
      const full = await textOf(pane, 'card:last:full')
      const branch = await textOf(pane, 'card:last:branch')
      const call = run($, 'esc me', undefined, 'focused')
      await seen.settle()
      await seen.clock.advance(1000)
      await call
      await seen.settle()
      const stopped = await textOf(pane, 'card:last:focused')
      await run($, 'nope', undefined, 'focused')
      await seen.settle()
      const failed = await textOf(pane, 'card:last:focused')
      rest.release('\n')

      expect(full).toContain('✓')
      expect(full).toContain('3/3')
      expect(full).toContain('15m ago')
      expect(branch).toContain('✗')
      expect(branch).toContain('1/2')
      expect(branch).toContain('3m ago')
      expect(branch).not.toContain('✓')
      expect(stopped).toContain('■')
      expect(stopped).not.toContain('✓')
      expect(failed).toContain('!')
      expect(failed).not.toContain('✓')
    },
  )

  test('card_tc_results_and_last_outlive_history_cap', async ($, on) => {
    const rows = [row('TC-301', 'a', 'tests/screen/TC-301.mjs')]
    const scripts: Record<string, Script> = { 'sh a': { pieces: ['TC-301: PASS\n'] } }
    for (let i = 1; i <= 6; i++) scripts[`c${i}`] = { pieces: ['(pass) s > z [1ms]\n'] }
    const seen = await start($, on, { git: featX(rows), files: { [CASES]: rows.join('\n') }, scripts })

    await run($, 'sh a', undefined, 'full')
    for (let i = 1; i <= 6; i++) await run($, `c${i}`)
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'card:tcs')).toContain('✓ 1')
    expect(await has(pane, 'card:last:full')).toBe(true)
    expect(await has(pane, 'head:1')).toBe(false)
  })

  test('card_branch_tcs_update_while_running', async ($, on) => {
    const rows = [row('TC-301', 'a', 'tests/screen/TC-301.mjs'), row('TC-302', 'b', 'tests/screen/TC-302.mjs')]
    const rest = held()
    const seen = await start($, on, {
      git: featX(rows), files: { [CASES]: rows.join('\n') }, scripts: { 'sh a': { pieces: ['TC-301: PASS\n', rest.piece] } },
    })

    const call = run($, 'sh a')
    await seen.settle()
    const pane = await mount($)
    const during = await textOf(pane, 'card:tcs')
    rest.release('\n')
    await call

    expect(during).toContain('✓ 1')
    expect(during).toContain('· 1 not run')
  })

  test('card_tc_fails_when_any_row_fails_newest_run_wins', async ($, on) => {
    const rows = [row('TC-301', 'x', 'a/x.test.ts > x_case')]
    const scripts: Record<string, Script> = {
      // the failure comes first: a later pass of the same TC must not hide it
      'bun test': { pieces: ['(fail) s > x_case (a) [1ms]\n(pass) s > x_case (b) [1ms]\n'], code: 1 },
    }
    const seen = await start($, on, { git: featX(rows), files: { [CASES]: rows.join('\n') }, scripts })
    const pane = await mount($)

    await run($, 'bun test')
    await seen.settle()
    const mixed = await textOf(pane, 'card:tcs')
    scripts['bun test'] = { pieces: ['(pass) s > x_case (a) [1ms]\n(pass) s > x_case (b) [1ms]\n'] }
    await run($, 'bun test')
    await seen.settle()
    const rerun = await textOf(pane, 'card:tcs')
    scripts['bun test'] = { pieces: ['(fail) s > x_case (a) [1ms]\n(skip) s > x_case (b) [1ms]\n'], code: 1 }
    await run($, 'bun test')
    await seen.settle()
    const failThenSkip = await textOf(pane, 'card:tcs')

    expect(mixed).toContain('✗ 1')
    expect(mixed).toContain('✓ 0')
    expect(rerun).toContain('✓ 1')
    expect(rerun).toContain('✗ 0')
    expect(failThenSkip).toContain('✗ 1')
  })

  test('card_untracked_cases_file_counts_every_row', async ($, on) => {
    const rows = [row('TC-401', 'a', 'manual'), row('TC-402', 'b', 'x.test.ts > b_case')]
    const answers = featX()
    delete answers[TRACKED]
    const seen = await start($, on, { git: answers, files: { [CASES]: `${RUN_LINE}\n${rows.join('\n')}\n` } })

    const pane = await mount($)

    expect(await textOf(pane, 'card:tcs')).toContain('Branch TCs 2')
    expect(await textOf(pane, 'card:tcs')).toContain('· 2 not run')
    expect(seen.ran).not.toContain(diff('abc'))
  })

  test('card_branch_tcs_diff_against_nearest_trunk_fork', async ($, on) => {
    const one = [row('TC-301', 'a', 'manual')]
    const three = [...one, row('TC-302', 'b', 'manual'), row('TC-303', 'c', 'manual')]
    const seen = await start($, on, {
      git: {
        [BR]: 'feat/x\n', [TRACKED]: 'tests/TEST_CASES.md\n',
        // dev is asked first, but main's fork is the nearer one: the branch was cut from main
        [forkOf('dev')]: 'd1\n', [count('d1')]: '9\n', [diff('d1')]: added(three),
        [forkOf('main')]: 'm1\n', [count('m1')]: '2\n', [diff('m1')]: added(one),
      },
    })

    const pane = await mount($)

    expect(await textOf(pane, 'card:tcs')).toContain('Branch TCs 1')
    expect(seen.ran).toContain(diff('m1'))
    expect(seen.ran).not.toContain(diff('d1'))
  })

  test('card_branch_tcs_from_a_remote_trunk_fork', async ($, on) => {
    // a checkout with no local trunk branch, only origin's
    const seen = await start($, on, {
      git: {
        [BR]: 'feat/x\n', [TRACKED]: 'tests/TEST_CASES.md\n',
        [forkOf('origin/main')]: 'o1\n', [count('o1')]: '3\n', [diff('o1')]: added([row('TC-301', 'a', 'manual')]),
      },
    })

    const pane = await mount($)

    expect(await textOf(pane, 'card:tcs')).toContain('Branch TCs 1')
  })
})

// ---- review fixes ---------------------------------------------------------------------------------------------------

describe('test-tracker review fixes', () => {
  test('screen_verdicts_printed_twice_count_once', async ($, on) => {
    // the screen run line prints each verdict live through tee, then again after `--- verdicts`
    const seen = await start($, on, { scripts: { 'sh screen.sh': { pieces: ['TC-012: PASS\nTC-013: FAIL\n--- verdicts\nTC-012: PASS\nTC-013: FAIL\n'], code: 1 } } })

    const result = resultOf(await run($, 'sh screen.sh'))
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'stat:1')).toContain('✓ 1')
    expect(await textOf(pane, 'stat:1')).toContain('✗ 1')
    expect(await has(pane, 'row:1:2')).toBe(false)
    expect(result).toContain('failed: TC-013')
    expect(result).not.toContain('TC-013, TC-013')
  })

  test('bash_naming_a_runner_without_tests_or_refused_leaves_no_run', async ($, on) => {
    let answer: unknown = { result: { stdout: 'Successfully installed pytest-9.0.3\n', stderr: '', interrupted: false } }
    const seen = await start($, on, {
      scripts: { 'npm test': { pieces: ['(pass) s > a [1ms]\n(pass) s > b [1ms]\n'] } },
      files: { [CASES]: `${RUN_LINE}\n` },
      bash: async () => answer,
    })
    await run($, 'npm test')
    await seen.settle()
    const pane = await mount($)

    await $.tool.call({ tool: 'Bash', command: 'pip install pytest' })
    await seen.settle()
    answer = { deny: 'the person refused' }
    await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
    await seen.settle()

    expect(await has(pane, 'head:2')).toBe(false)
    expect(await has(pane, 'head:3')).toBe(false)
    expect(await textOf(pane, 'card:last:full')).toContain('2/2')
    expect(await has(pane, 'card:last:branch')).toBe(false)
  })

  test('bash_interrupted_reads_stopped', async ($, on) => {
    const seen = await start($, on, {
      bash: async () => ({ result: { stdout: 't.py::test_a PASSED [50%]\n', stderr: '', interrupted: true } }),
    })

    await $.tool.call({ tool: 'Bash', command: 'pytest -v' })
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'head:1')).toContain('■')
    expect(await textOf(pane, 'head:1')).not.toContain('✗')
  })

  test('pytest_same_name_failures_in_two_files_both_kept', async ($, on) => {
    const seen = await start($, on, {
      scripts: { 'pytest -q': { pieces: ['.FF [100%]\nFAILED a.py::test_init - assert 1\nFAILED b.py::test_init - assert 2\n'], code: 1 } },
    })

    const result = resultOf(await run($, 'pytest -q'))
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'row:1:0')).toContain('✗ test_init')
    expect(await textOf(pane, 'row:1:1')).toContain('✗ test_init')
    expect(result).toContain('failed: test_init, test_init')
    expect(await textOf(pane, 'stat:1')).toContain('✗ 2')
  })

  test('stderr_between_a_cut_stdout_line_loses_nothing', async ($, on) => {
    const seen = await start($, on, {
      scripts: { 'pytest -v': { pieces: ['t.py::test_a ', { stderr: 'warning: slow\n' }, 'PASSED [100%]\n'] } },
    })

    await run($, 'pytest -v')
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'row:1:0')).toContain('✓ test_a')
    expect(await textOf(pane, 'stat:1')).toContain('✓ 1')
  })

  test('an_older_running_run_does_not_hide_a_newer_result', async ($, on) => {
    const rows = [row('TC-301', 'a', 'tests/screen/TC-301.mjs')]
    const rest = held()
    const seen = await start($, on, {
      git: featX(rows), files: { [CASES]: rows.join('\n') },
      scripts: { 'sh old': { pieces: ['TC-301: PASS\n', rest.piece] }, 'sh new': { pieces: ['TC-301: FAIL\n'], code: 1 } },
    })

    const old = run($, 'sh old')
    await seen.settle()
    await seen.clock.advance(1000)
    await run($, 'sh new')
    await seen.settle()
    const pane = await mount($)
    const whileOldRuns = await textOf(pane, 'card:tcs')
    rest.release('\n')
    await old
    await seen.settle()

    expect(whileOldRuns).toContain('✗ 1')
    expect(whileOldRuns).toContain('✓ 0')
    // the old run ending later still started first: the newer failure stands
    expect(await textOf(pane, 'card:tcs')).toContain('✗ 1')
  })

  test('pytest_node_with_spaces_in_its_parameter', async ($, on) => {
    const seen = await start($, on, {
      scripts: { 'pytest -v': { pieces: ['t.py::test_a[hello world] PASSED [50%]\nt.py::test_b[x y] FAILED [100%]\n'], code: 1 } },
    })

    await run($, 'pytest -v')
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'row:1:0')).toContain('✓ test_a[hello world]')
    expect(await textOf(pane, 'row:1:1')).toContain('✗ test_b[x y]')
  })

  test('a_cut_line_still_reaches_claude_when_the_stream_breaks', async ($, on) => {
    const seen = await start($, on, { scripts: { 'bun test': { pieces: ['error: boom without a newline', { err: 'pipe broke' }] } } })

    const result = resultOf(await run($, 'bun test'))
    await seen.settle()

    expect(result).toContain('error: boom without a newline')
    expect(result).toContain('pipe broke')
  })

  test('reload_ends_a_running_run_with_its_time_and_keeps_ticking', async ($, on) => {
    const rest = held()
    const seen = setup(on, { scripts: { 'bun test': { pieces: ['(pass) s > a [1ms]\n', rest.piece] } } })
    let redraws = 0
    on('ui.invalidate', (_$, e, next) => {
      redraws += 1
      return next(e)
    })
    await seen.clock.set(1_000_000)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const call = run($, 'bun test', undefined, 'branch')
    await seen.settle()
    await seen.clock.advance(4000)

    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true }) // a reload
    await seen.settle()
    const pane = await mount($)
    const head = await textOf(pane, 'head:1')
    const lastLine = await textOf(pane, 'card:last:branch')
    const before = redraws
    await seen.clock.advance(60_000)
    rest.release('\n')
    await call.catch(() => undefined)

    expect(head).toContain('■')
    expect(head).toContain('4.0s')
    expect(lastLine).toContain('■')
    expect(redraws - before).toBeGreaterThan(0)
  })

  test('pytest_quiet_dots_count_before_their_line_ends', async ($, on) => {
    const rest = held()
    const seen = await start($, on, { scripts: { 'pytest -q': { pieces: ['..', '.F', rest.piece], code: 1 } } })

    const call = run($, 'pytest -q')
    await seen.settle()
    const pane = await mount($)
    const during = await textOf(pane, 'stat:1')
    rest.release(' [100%]\n')
    await call
    await seen.settle()
    const after = await textOf(pane, 'stat:1')

    expect(during).toContain('✓ 3')
    expect(during).toContain('✗ 1')
    expect(after).toContain('✓ 3') // the finished line does not count them again
    expect(after).toContain('✗ 1')
  })

  test('pytest_under_another_command_counts_its_dots_and_summary', async ($, on) => {
    const seen = await start($, on, {
      scripts: { 'make test': { pieces: ['======= test session starts =======\n..F [100%]\nFAILED t.py::test_c - assert 1\n'], code: 2 } },
    })

    await run($, 'make test')
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'stat:1')).toContain('✓ 2')
    expect(await textOf(pane, 'stat:1')).toContain('✗ 1')
    expect(await textOf(pane, 'row:1:0')).toContain('✗ test_c')
  })

  test('failed_list_in_the_result_is_capped', async ($, on) => {
    const lines = Array.from({ length: 60 }, (_, i) => `(fail) s > t${i} [1ms]`).join('\n')
    const seen = await start($, on, { scripts: { 'bun test': { pieces: [`${lines}\n`], code: 1 } } })

    const result = resultOf(await run($, 'bun test'))
    await seen.settle()

    expect(result).toContain('t49')
    expect(result).toContain('+10 more')
    expect(result.split('\n')[1]).not.toContain('t50')
  })

  test('jest_skip_glyph_and_parenthesised_time', async ($, on) => {
    const seen = await start($, on, { scripts: { 'npm test': { pieces: ['✓ adds (2 ms)\n○ skipped later\n'] } } })

    await run($, 'npm test')
    await seen.settle()
    const pane = await mount($)

    expect(await textOf(pane, 'row:1:0')).toContain('✓ adds')
    expect(await textOf(pane, 'row:1:0')).not.toContain('ms')
    expect(await textOf(pane, 'row:1:1')).toContain('○ later')
    expect(await textOf(pane, 'stat:1')).toContain('○ 1')
  })

  test('a_run_past_its_timeout_is_stopped', async ($, on) => {
    const rest = held()
    const seen = await start($, on, { scripts: { 'bun test': { pieces: ['(pass) s > a [1ms]\n', rest.piece] } } })

    const call = $.tool.run({ tool: RUN, command: 'bun test', timeoutMs: 5000 } as never)
    await seen.settle()
    await seen.clock.advance(5000)
    const result = resultOf(await call)
    await seen.settle()
    const pane = await mount($)

    rest.release('\n') // the child's piece in flight lands; the stream, left, ends there
    await seen.settle()

    expect(result).toContain('timed out after 5s')
    expect(await textOf(pane, 'head:1')).toContain('!')
    expect(seen.spawn.ended).toContain('bun test')
  })

  test('a_command_the_bash_rules_deny_never_runs', async ($, on) => {
    const seen = await start($, on, { bashRule: 'deny', scripts: { 'rm -rf build && pytest': { pieces: ['.\n'] } } })

    const result = resultOf(await run($, 'rm -rf build && pytest'))
    await seen.settle()
    const pane = await mount($)

    expect(result).toContain('refused')
    expect(seen.spawn.argv).toEqual([])
    expect(await textOf(pane, 'empty')).toBe('No test runs yet.')
  })

  test('clear_reads_the_branch_again', async ($, on) => {
    const seen = await start($, on, { git: featX([row('TC-301', 'a', 'manual')]) })
    const reads = seen.ran.filter(c => c === BR).length

    await $.classic.SessionStart({ source: 'clear' })
    await seen.settle()

    expect(seen.ran.filter(c => c === BR).length).toBeGreaterThan(reads)
  })

  test('run_uses_the_working_directory_of_its_call', async ($, on) => {
    const seen = setup(on, { scripts: { 'bun test': { pieces: ['(pass) s > a [1ms]\n'] } } })
    await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })

    await run($, 'bun test')

    // the fake answers session.cwd with /repo: TEST_CASES.md and the child are read and run there
    expect(seen.spawn.argv[0]).toEqual(['/bin/sh', '-c', 'bun test'])
    expect(seen.spawn.cwd[0]).toBe(CWD)
  })
})
