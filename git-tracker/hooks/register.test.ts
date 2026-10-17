import { describe, expect, test } from 'claude-code/testing'
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

/** One git or gh answer: stdout (exit 0), an exit with stdout, or a command that cannot start. */
type Answer = string | { exit: number; stdout?: string } | 'missing'

/** A branch `feat/x` cut from main: 2 ahead, 1 behind, nothing changed, no PR. */
const repo = (): Record<string, Answer> => ({
  'git rev-parse --abbrev-ref HEAD': 'feat/x\n',
  'git for-each-ref --format=%(refname) refs/heads refs/remotes':
    'refs/heads/feat/x\nrefs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\n',
  'git rev-list --left-right --count HEAD...main': '2\t1\n',
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
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    ran.push(argv)
    const a = answers[argv] ?? ''
    if (a === 'missing') return { deny: `${e.argv[0]}: command not found` }
    const { exit, stdout } = typeof a === 'string' ? { exit: 0, stdout: a } : { exit: a.exit, stdout: a.stdout ?? '' }
    return { value: { exitCode: exit, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return ran
}

async function start($: Engine, on: On, answers: Record<string, Answer>) {
  const seen = { ran: git(on, answers), opened: [] as string[] }
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
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  return seen
}

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'git-tracker', surface: 'terminal', component: 'Pane', requestId: 'git-tracker', props: PANE })

describe('git-tracker', () => {
  test('parent_fewest_ahead_picks_main', async ($, on) => {
    const answers = {
      ...repo(),
      'git for-each-ref --format=%(refname) refs/heads refs/remotes':
        'refs/heads/dev\nrefs/heads/feat/x\nrefs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/feat/x\nrefs/remotes/origin/main\n',
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

    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' })

    const pane = await mount($)
    expect((await pane.find({ key: 'file:a.ts' }))?.text).toContain('+3')
    expect(seen.ran.filter(argv => argv === GH)).toHaveLength(1)
  })

  test('bash_gh_pr_refreshes_pr', async ($, on) => {
    const answers = repo()
    await start($, on, answers)
    answers[GH] = '{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false}\n'

    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

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
})
