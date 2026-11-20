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

/** One piece of output: text, a piece held until the test releases it, or a stream that throws there. */
type Piece = string | Promise<string> | { err: string }
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
  const seen = { argv: [] as string[][], env: [] as unknown[], ended: [] as string[] }
  on('process.spawn', async function* (_$, e) {
    seen.argv.push([...e.argv])
    seen.env.push(e.env)
    const command = e.argv[2] ?? ''
    const script = scripts[command] ?? { pieces: [] }
    try {
      // a stand-in for a call on $ answers { value } or { deny }: a child that cannot start, or a stream that broke
      if (script.reject !== undefined) return { deny: script.reject }
      for (const p of script.pieces) {
        if (typeof p === 'object' && 'err' in p) return { deny: p.err }
        yield { stream: 'stdout' as const, text: await p }
      }
      return { value: { code: script.code === undefined ? 0 : script.code, signal: script.signal ?? null } }
    } finally {
      seen.ended.push(command)
    }
  })
  return seen
}

/** `bash`: answers every Bash call in place of an empty success. */
type Setup = { scripts?: Record<string, Script>; files?: Record<string, string>; bash?: () => Promise<unknown> }

function setup(on: On, o: Setup = {}) {
  const clock = mock.clock(on)
  const files = o.files ?? {}
  const seen = {
    opened: [] as { id: string; title?: string; columns?: number }[],
    tools: [] as Record<string, unknown>[],
    spawn: spawner(on, o.scripts ?? {}),
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
  return seen
}

async function start($: Engine, on: On, o: Setup = {}) {
  const seen = setup(on, o)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.settle()
  return seen
}

const run = ($: Engine, command: string, agentId?: string) =>
  $.tool.run({ tool: RUN, command, ...(agentId === undefined ? {} : { agentId }) } as never)

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
    const seen = await start($, on, { scripts: { 'bun test': { pieces: ['(pass) s > a', ' [1ms]\n'] } } })

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
    await call
    await seen.settle()

    expect(during).toContain('now: tests/screen/TC-012.mjs')
    expect(await textOf(pane, 'row:1:0')).toContain('✗ TC-012 login')
  })

  test('test_rows_get_tc_ids_from_code_test_column', async ($, on) => {
    const out = '(pass) s > x_does_y (case 1) [2ms]\n(pass) b > dup [1ms]\n(pass) z > dup [1ms]\n'
    const seen = await start($, on, {
      files: {
        [CASES]: [
          row('TC-007', 'x feature', 'a/register.test.ts > x_does_y'),
          row('TC-008', 'dup in b', 'b/register.test.ts > dup'),
          row('TC-009', 'dup in c', 'c/register.test.ts > dup'),
        ].join('\n'),
      },
      scripts: { 'bun test': { pieces: [out] } },
    })

    await run($, 'bun test')
    await seen.settle()
    const pane = await mount($)
    const rows = [await textOf(pane, 'row:1:0'), await textOf(pane, 'row:1:1'), await textOf(pane, 'row:1:2')]
    delete seen.files[CASES]
    await run($, 'bun test')
    await seen.settle()

    expect(rows[0]).toContain('TC-007 x_does_y (case 1)')
    expect(rows[1]).toContain('TC-008 dup')
    expect(rows[2]).toContain('✓ dup')
    expect(rows[2]).not.toContain('TC-')
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
    h1.release('\n')
    await c1

    expect(first).toEqual({ oldest: false, kept: true, newestOpen: true, olderOpen: false })
    expect(both.r7).toContain('h1a')
    expect(both.r8).toContain('h2a')
    expect(later).toEqual({ held: true, heldOpen: true, h2: false })
  })

  test('elapsed_redraws_only_while_running', async ($, on) => {
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
    await seen.clock.advance(3000)
    const pane = await mount($)
    const head = await textOf(pane, 'head:1')
    rest.release('\n')
    await call
    await seen.settle()
    const atEnd = redraws
    await seen.clock.advance(5000)

    expect(head).toContain('3s')
    expect(redraws).toBe(atEnd)
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
