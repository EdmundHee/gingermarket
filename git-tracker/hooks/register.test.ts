import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/repo'
const PANE = {
  title: 'Git', isFocused: false, bodyColumns: 48, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}
const GH = 'gh pr view --json number,url,state,isDraft'
const NUMSTAT = 'git diff --numstat --summary --no-renames abc123'
const LOG = 'git log --graph --oneline --decorate --boundary --color=never -n 12 main...HEAD'
const BRANCH = 'git rev-parse --abbrev-ref HEAD'
const HEAD_SHA = 'git rev-parse HEAD'
const REFS = 'git for-each-ref --format=%(objectname) %(refname) refs/heads refs/remotes'
const REV_MAIN = 'git rev-list --left-right --count HEAD...main'

/** One git or gh answer: stdout (exit 0), an exit with stdout, a command that cannot start, or one held open (`held`). */
type Reply = string | { exit: number; stdout?: string } | 'missing'
type Answer = Reply | Promise<Reply>

/** An answer that stays unanswered until the test releases it with the real one. */
function held() {
  let release!: (a: Reply) => void
  const answer = new Promise<Reply>(r => { release = r })
  return { answer, release }
}

/** A branch `feat/x` cut from main: 2 ahead, 1 behind, nothing changed, no PR. */
const repo = (): Record<string, Answer> => ({
  [BRANCH]: 'feat/x\n',
  [HEAD_SHA]: 'aaa0001\n',
  [REFS]: 'aaa0001 refs/heads/feat/x\nbbb0001 refs/heads/main\nbbb0002 refs/remotes/origin/HEAD\nbbb0002 refs/remotes/origin/main\n',
  [REV_MAIN]: '2\t1\n',
  'git rev-list --left-right --count HEAD...origin/main': '2\t3\n',
  'git merge-base HEAD main': 'abc123\n',
  [LOG]: '* 3e1c2aa (HEAD -> feat/x) feat: pane\n| * 9f8e7d1 (main) fix typo\n|/\no 872a03f Merge: plan-tracker\n',
  [NUMSTAT]: '',
  'git ls-files --others --exclude-standard': '',
  [GH]: { exit: 1 },
})

/** Answers `process.run` from `answers` (read at call time, so a test may change them); records each argv. */
function git(on: On, answers: Record<string, Answer>) {
  const ran: string[] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.join(' ')
    ran.push(argv)
    const a = await (answers[argv] ?? '')
    if (a === 'missing') return { deny: `${e.argv[0]}: command not found` }
    const { exit, stdout } = typeof a === 'string' ? { exit: 0, stdout: a } : { exit: a.exit, stdout: a.stdout ?? '' }
    return { value: { exitCode: exit, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return ran
}

/** Hooks under the plugin; `settle` lets a refresh a dispatch left running finish. */
function setup(on: On, answers: Record<string, Answer>) {
  const clock = mock.clock(on)
  const seen = { ran: git(on, answers), opened: [] as string[], settle: () => clock.settle() }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: { ok: true } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  return seen
}

const SESSION = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

async function start($: Engine, on: On, answers: Record<string, Answer>) {
  const seen = setup(on, answers)
  await $.session.start(SESSION)
  await seen.settle()
  return seen
}

const edit = ($: Engine) => $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' })

/** HEAD or a branch tip moves after start; the counts change with it (a commit is one more ahead of every ref). */
const MOVES = [
  {
    name: 'head moved', head: 'c0ffee2\n',
    move: { [HEAD_SHA]: 'c0ffee3\n', [REV_MAIN]: '3\t1\n', 'git rev-list --left-right --count HEAD...origin/main': '3\t3\n' },
    header: 'feat/x ← main  3↑ 1↓',
  },
  {
    name: 'tip moved', head: 'c0ffee4\n',
    // same refs, only main's tip sha changes: a key of ref names alone would miss it
    move: {
      [REFS]: 'aaa0001 refs/heads/feat/x\nbbb0009 refs/heads/main\nbbb0002 refs/remotes/origin/HEAD\nbbb0002 refs/remotes/origin/main\n',
      [REV_MAIN]: '2\t4\n',
    },
    header: 'feat/x ← main  2↑ 4↓',
  },
]

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'git-tracker', surface: 'terminal', component: 'Pane', requestId: 'git-tracker', props: PANE })

describe('git-tracker', () => {
  test('parent_fewest_ahead_picks_main', async ($, on) => {
    const answers = {
      ...repo(),
      [REFS]:
        'ccc0001 refs/heads/dev\naaa0001 refs/heads/feat/x\nbbb0001 refs/heads/main\nbbb0002 refs/remotes/origin/HEAD\naaa0001 refs/remotes/origin/feat/x\nbbb0002 refs/remotes/origin/main\n',
      'git rev-list --left-right --count HEAD...dev': '5\t0\n',
      'git rev-list --left-right --count HEAD...origin/feat/x': '0\t0\n',
    }
    const seen = await start($, on, answers)

    const pane = await mount($)

    expect((await pane.find({ key: 'head' }))?.text).toContain('feat/x ← main  2↑ 1↓')
    expect(seen.ran).not.toContain('git rev-list --left-right --count HEAD...origin/feat/x')
  })

  test('trunk_branch_shows_no_parent', async ($, on) => {
    const answers = {
      ...repo(),
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git log --graph --oneline --decorate --color=never -n 12': '* 872a03f (HEAD -> main) Merge\n',
      'git diff --numstat --summary --no-renames HEAD': '',
    }
    await start($, on, answers)

    const pane = await mount($)

    const head = (await pane.find({ key: 'head' }))?.text ?? ''
    expect(head).toContain('main')
    expect(head).not.toContain('←')
    expect(await pane.find({ type: 'Text', text: '872a03f (HEAD -> main) Merge' })).toBeDefined()
  })

  test('graph_draws_git_log_lines_capped_12', async ($, on) => {
    const lines = Array.from({ length: 14 }, (_, i) => `* c${String(i + 1).padStart(2, '0')} commit`)
    await start($, on, { ...repo(), [LOG]: `${lines.join('\n')}\n` })

    const pane = await mount($)

    const drawn = (await pane.findAll({ type: 'Text', text: /^\* c\d\d commit$/ })).map(t => t.text)
    expect(drawn).toEqual(lines.slice(0, 12))
  })

  test('graph_subject_control_chars_stripped', async ($, on) => {
    await start($, on, { ...repo(), [LOG]: '* 3e1c2aa feat: \u001b[31mred\u0007 bell\n' })

    const pane = await mount($)

    expect(await pane.find({ type: 'Text', text: /\u001b|\u0007/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /feat: \[31mred bell$/ })).toBeDefined()
  })

  test('changed_files_show_line_counts', async ($, on) => {
    await start($, on, { ...repo(), [NUMSTAT]: '40\t12\thooks/register.tsx\n-\t-\timg.png\n' })

    const pane = await mount($)

    const section = (await pane.find({ key: 'section:changed' }))?.text ?? ''
    expect(section).toContain('CHANGED 2')
    expect(section).toContain('+40 −12')
    expect((await pane.find({ key: 'file:hooks/register.tsx' }))?.text).toContain('+40 −12')
    expect((await pane.find({ key: 'file:img.png' }))?.text).toContain('bin')
  })

  test('new_files_include_tracked_and_untracked', async ($, on) => {
    await start($, on, {
      ...repo(),
      [NUMSTAT]: '30\t0\tREADME.md\n create mode 100644 README.md\n',
      'git ls-files --others --exclude-standard': 'notes.md\n',
      'git diff --no-index --numstat -- /dev/null notes.md': { exit: 1, stdout: '5\t0\t/dev/null => notes.md\n' },
    })

    const pane = await mount($)

    const section = (await pane.find({ key: 'section:new' }))?.text ?? ''
    expect(section).toContain('NEW 2')
    expect(section).toContain('+35')
    expect((await pane.find({ key: 'file:README.md' }))?.text).toContain('+30')
    expect((await pane.find({ key: 'file:notes.md' }))?.text).toContain('+5')
    expect(await pane.find({ key: 'section:changed' })).toBeUndefined()
  })

  test('pr_shows_number_state_and_link', async ($, on) => {
    const url = 'https://github.com/o/r/pull/12'
    await start($, on, { ...repo(), [GH]: `{"number":12,"url":"${url}","state":"OPEN","isDraft":false}\n` })

    const pane = await mount($)

    expect(await pane.find({ type: 'Text', text: 'PR #12 open' })).toBeDefined()
    expect((await pane.find({ type: 'Link' }))?.props.href).toBe(url)
  })

  test('missing_pr_or_gh_hides_pr_row (no PR)', async ($, on) => {
    await start($, on, { ...repo(), [GH]: { exit: 1 } })

    const pane = await mount($)

    expect(await pane.find({ key: 'pr' })).toBeUndefined()
    expect((await pane.find({ key: 'head' }))?.text).toContain('feat/x ← main')
  })

  test('missing_pr_or_gh_hides_pr_row (no gh)', async ($, on) => {
    await start($, on, { ...repo(), [GH]: 'missing' })

    const pane = await mount($)

    expect(await pane.find({ key: 'pr' })).toBeUndefined()
    expect((await pane.find({ key: 'head' }))?.text).toContain('feat/x ← main')
  })

  test('not_a_repo_shows_message', async ($, on) => {
    await start($, on, { ...repo(), 'git rev-parse --abbrev-ref HEAD': { exit: 128 } })

    const pane = await mount($)

    expect(await pane.find({ type: 'Text', text: 'Not a git repository.' })).toBeDefined()
    expect(await pane.find({ key: 'head' })).toBeUndefined()
  })

  test('edit_call_refreshes_files_without_gh', async ($, on) => {
    const answers = repo()
    const seen = await start($, on, answers)
    answers[NUMSTAT] = '3\t0\ta.ts\n'

    await edit($)
    await seen.settle()

    const pane = await mount($)
    expect((await pane.find({ key: 'file:a.ts' }))?.text).toContain('+3')
    expect(seen.ran.filter(argv => argv === GH)).toHaveLength(1)
  })

  test('bash_gh_pr_refreshes_pr', async ($, on) => {
    const answers = repo()
    const seen = await start($, on, answers)
    answers[GH] = '{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false}\n'

    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await seen.settle()

    const pane = await mount($)
    expect(await pane.find({ type: 'Text', text: 'PR #7 open' })).toBeDefined()
  })

  test('colors_mark_counts_hash_refs_and_pr_state', async ($, on) => {
    await start($, on, {
      ...repo(),
      [NUMSTAT]: '40\t12\ta.ts\n',
      [GH]: '{"number":3,"url":"https://github.com/o/r/pull/3","state":"MERGED","isDraft":false}\n',
    })

    const pane = await mount($)

    const color = async (text: RegExp) => (await pane.find({ type: 'Text', text }))?.props.color
    expect(await color(/^\+40$/)).toBe('success')
    expect(await color(/^−12$/)).toBe('error')
    expect(await color(/^3e1c2aa$/)).toBe('warning')
    expect(await color(/^HEAD$/)).toBe('suggestion')
    expect(await color(/^feat\/x$/)).toBe('suggestion') // the header's branch, drawn before the graph's ref
    expect(await color(/^merged$/)).toBe('merged')
  })

  test('command_opens_git_pane', async ($, on) => {
    const seen = await start($, on, repo())

    const ran = await $.command.run({
      command: 'git-tracker', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 },
    })

    expect(seen.opened).toContain('git-tracker')
    expect(ran).toMatchObject({ text: 'Git pane opened.' })
  })

  test('bash_git_push_refreshes_pr', async ($, on) => {
    const answers = repo()
    const seen = await start($, on, answers)
    answers[GH] = '{"number":9,"url":"https://github.com/o/r/pull/9","state":"OPEN","isDraft":false}\n'

    await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/x' })
    await seen.settle()

    const pane = await mount($)
    expect(await pane.find({ type: 'Text', text: 'PR #9 open' })).toBeDefined()
  })

  test('refresh_button_reloads_files_and_pr', async ($, on) => {
    const answers = repo()
    const seen = await start($, on, answers)
    const pane = await mount($)
    answers[NUMSTAT] = '3\t0\ta.ts\n'

    await pane.press({ key: 'refresh' })

    expect((await pane.find({ key: 'file:a.ts' }))?.text).toContain('+3')
    expect(seen.ran.filter(argv => argv === GH)).toHaveLength(2)
  })

  test('untracked_files_capped_at_30', async ($, on) => {
    const names = Array.from({ length: 31 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.md`)
    await start($, on, { ...repo(), 'git ls-files --others --exclude-standard': `${names.join('\n')}\n` })

    const pane = await mount($)

    expect((await pane.find({ key: 'section:new' }))?.text).toContain('NEW 30')
    expect(await pane.find({ key: 'file:f30.md' })).toBeDefined()
    expect(await pane.find({ key: 'file:f31.md' })).toBeUndefined()
  })

  test('session_start_returns_while_git_runs', async ($, on) => {
    const answers = repo()
    const branch = held()
    answers[BRANCH] = branch.answer
    const seen = setup(on, answers)
    let started = false

    void $.session.start(SESSION).then(() => { started = true })
    await seen.settle()
    const startedWhileHeld = started
    const pane = await mount($)
    const loading = await pane.find({ type: 'Text', text: 'Reading git…' })
    branch.release('feat/x\n')
    await seen.settle()

    expect(startedWhileHeld).toBe(true)
    expect(loading).toBeDefined()
    expect((await pane.find({ key: 'head' }))?.text).toContain('feat/x ← main  2↑ 1↓')
  })

  test('edit_call_returns_while_refresh_runs', async ($, on) => {
    const answers = repo()
    const seen = await start($, on, answers)
    const numstat = held()
    answers[NUMSTAT] = numstat.answer
    let returned = false

    void edit($).then(() => { returned = true })
    await seen.settle()
    const returnedWhileHeld = returned
    numstat.release('3\t0\ta.ts\n')
    await seen.settle()

    expect(returnedWhileHeld).toBe(true)
    const pane = await mount($)
    expect((await pane.find({ key: 'file:a.ts' }))?.text).toContain('+3')
  })

  test('parent_counts_reused_while_head_unchanged', async ($, on) => {
    const seen = await start($, on, { ...repo(), [HEAD_SHA]: 'c0ffee1\n' })

    await edit($)
    await seen.settle()

    const pane = await mount($)
    expect(seen.ran.filter(argv => argv === REV_MAIN)).toHaveLength(1)
    expect((await pane.find({ key: 'head' }))?.text).toContain('feat/x ← main  2↑ 1↓')
  })

  for (const m of MOVES) {
    test(`parent_recounted_when_head_or_tip_moves (${m.name})`, async ($, on) => {
      const answers = { ...repo(), [HEAD_SHA]: m.head }
      const seen = await start($, on, answers)
      Object.assign(answers, m.move)

      await edit($)
      await seen.settle()

      const pane = await mount($)
      expect(seen.ran.filter(argv => argv === REV_MAIN)).toHaveLength(2)
      expect((await pane.find({ key: 'head' }))?.text).toContain(m.header)
    })
  }

  test('parent_rev_lists_run_8_at_a_time', async ($, on) => {
    const names = Array.from({ length: 20 }, (_, i) => `b${String(i + 1).padStart(2, '0')}`)
    const answers: Record<string, Answer> = {
      ...repo(),
      [REFS]: `aaa0001 refs/heads/feat/x\n${names.map(n => `bbb0001 refs/heads/${n}\n`).join('')}`,
    }
    // each round's rev-lists wait on that round's gate; answers are read at call time
    const [gate1, gate2, gate3] = [held(), held(), held()]
    const holdOn = (gate: ReturnType<typeof held>) =>
      Object.assign(answers, Object.fromEntries(names.map(n => [`git rev-list --left-right --count HEAD...${n}`, gate.answer])))
    const seen = setup(on, answers)
    const started = () => seen.ran.filter(argv => argv.startsWith('git rev-list ')).length

    holdOn(gate1)
    void $.session.start(SESSION)
    await seen.settle()
    const round1 = started()
    holdOn(gate2)
    gate1.release('1\t0\n')
    await seen.settle()
    const round2 = started()
    holdOn(gate3)
    gate2.release('1\t0\n')
    await seen.settle()
    const round3 = started()
    gate3.release('1\t0\n')
    await seen.settle()

    expect([round1, round2, round3]).toEqual([8, 16, 20])
  })

  test('edit_during_start_refresh_reruns_once', async ($, on) => {
    const answers = repo()
    const branch = held()
    answers[BRANCH] = branch.answer
    const seen = setup(on, answers)

    void $.session.start(SESSION)
    await seen.settle()
    void edit($)
    await seen.settle()
    answers[NUMSTAT] = '3\t0\ta.ts\n'
    branch.release('feat/x\n')
    await seen.settle()

    const pane = await mount($)
    expect(seen.ran.filter(argv => argv === BRANCH)).toHaveLength(2)
    expect((await pane.find({ key: 'file:a.ts' }))?.text).toContain('+3')
  })
})
