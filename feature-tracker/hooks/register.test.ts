import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const R = '/r' // repo toplevel
const V = '/v' // notesDir
const DOCS = `${R}/docs/features`
const HEAD = 'f9d904b'
const NOON = new Date(2026, 9, 19, 12).getTime() // 2026-10-19 local, whatever the test machine's zone
const PANE = {
  title: 'Features', isFocused: false, bodyColumns: 48, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 }, view: {},
}
const INV = '## Auth\npaths: a/**\n- [done] Login — email\n'
const GROUPS = JSON.stringify({ projects: { syph: { group: 'product', stack: ['nuxt'], repo: [R] } } })
/** A prior Auth review: one finding ticked, one open. */
const PRIOR =
  '---\ntype: review\nmodule: Auth\nsha: abc1234\n---\n# Review — Auth (abc1234)\n\n' +
  '## Tech debt\n- [x] med · a/x.ts:3 — dup validation → share schema\n  why\n' +
  '## Missing handling\n- [ ] high · a/login.ts:42 — no rate limit → add limiter\n  why\n'
const PRIOR_PATH = `${DOCS}/reviews/2026-10-12_auth-abc1234.md`
const FINDINGS = JSON.stringify({
  findings: [
    { bucket: 'debt', sev: 'high', file: 'a/x.ts', line: 42, title: 't', why: 'w', fix: 'f' },
    { bucket: 'handling', sev: 'med', file: 'a/y.ts', title: 'u', why: 'w2', fix: 'g' },
    { bucket: 'debt', sev: 'low', file: 'a/z.ts', line: 1, title: 'v', why: '', fix: 'h' },
  ],
  fixed: [],
})

/** One git answer: stdout (exit 0) or an exit with stdout. */
type Answer = string | { exit: number; stdout?: string }

/** Answers `process.run` from `answers` (unknown argv → empty stdout, exit 0); records each argv. */
function git(on: On, answers: Record<string, Answer>) {
  const ran: string[] = []
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    ran.push(argv)
    const a = answers[argv] ?? ''
    const { exit, stdout } = typeof a === 'string' ? { exit: 0, stdout: a } : { exit: a.exit, stdout: a.stdout ?? '' }
    return { value: { exitCode: exit, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return ran
}

/** An in-memory file system: `files` by absolute path, `dirs` that exist with nothing in them. */
function fakeFs(on: On, files: Record<string, string>, dirs: string[]) {
  const map = new Map(Object.entries(files))
  let tick = 0
  const mtime = new Map([...map.keys()].map(k => [k, ++tick]))
  const writes: string[] = []
  on('fs.read', (_$, e) => (map.has(e.path) ? { value: map.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', (_$, e) => {
    map.set(e.path, e.text)
    mtime.set(e.path, ++tick)
    writes.push(e.path)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: map.has(e.path) || dirs.includes(e.path) || [...map.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$, e) => {
    const pre = `${e.path}/`
    const names = [...map.keys()].filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/'))
    if (names.length === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: names.map(k => ({ name: k.slice(pre.length), kind: 'file' as const, size: 1, mtimeMs: mtime.get(k) ?? 0, isLink: false })) }
  })
  return { map, writes }
}

type Setup = { files?: Record<string, string>; dirs?: string[]; answers?: Record<string, Answer>; agents?: Array<{ id: string; type: string }> }

/** Starts the session with every op the plugin reaches answered beneath it; hooks go in before the first `$` call. */
async function start($: Engine, on: On, { files = {}, dirs = [], answers = {}, agents = [] }: Setup = {}) {
  const seen = {
    ran: git(on, { 'git rev-parse --show-toplevel': `${R}\n`, 'git rev-parse --short=7 HEAD': `${HEAD}\n`, ...answers }),
    fs: fakeFs(on, files, dirs),
    spawns: [] as Array<{ subagentType: string; model?: string; prompt: string; description: string }>,
    registered: [] as Array<{ name: string; tools?: readonly string[]; model?: string }>,
    toasts: [] as string[],
    submitted: [] as string[],
    opened: [] as string[],
    order: [] as string[], // session.start beneath the plugin (Plan, Git) vs its ui.open
  }
  // The kit hands this hook the Agent tool's own parameters (snake_case) and drops any agentId a hook
  // answers ("set by core"), so spawns are normalised here and agent.list names them a1, a2, …
  on('agent.spawn', (_$, e) => {
    const raw = e as unknown as Record<string, string>
    seen.spawns.push({ subagentType: raw.subagent_type ?? raw.subagentType ?? '', model: raw.model, prompt: raw.prompt ?? '', description: raw.description ?? '' })
    return { model: 'opus' }
  })
  on('agent.list', () => ({
    value: [
      ...seen.spawns.map((s, i) => ({ id: `a${i + 1}`, description: s.description, type: s.subagentType, status: 'running' as const, prompt: s.prompt })),
      ...agents.map(a => ({ ...a, description: 'other', status: 'running' as const, prompt: '' })),
    ],
  }))
  on('agent.register', (_$, e) => {
    seen.registered.push(e)
    return { value: { agent: `feature-tracker:${e.name}` } }
  })
  on('session.start', (_$, e) => {
    seen.order.push('session.start')
    return { cwd: e.cwd }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    seen.order.push('ui.open')
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: NOON }))
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.session.start({ cwd: R, surface: 'terminal', isInteractive: true })
  return seen
}

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'feature-tracker', surface: 'terminal', component: 'Pane', requestId: 'feature-tracker', props: PANE })

/** The reader subagent `agentId` ends its run with `answer`. */
const finish = ($: Engine, answer: string, agentId = 'a1') =>
  $.turn.complete({ reason: 'answer', answer, durationMs: 1, isAborted: false, turnId: `t-${agentId}`, agentId })

const textOf = async (pane: Awaited<ReturnType<typeof mount>>, key: string) => (await pane.find({ key }))?.text ?? ''

/** A subagent's report as the engine hands it back to the main loop: a peer message framed by the harness. */
const handback = ($: Engine, from: string) =>
  $.prompt.submit({
    text: `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] The report follows:\n  {"findings":[]}\n</agent-message>`,
    origin: { kind: 'peer' },
    wait: false,
  })

const command = ($: Engine, args: string) =>
  $.command.run({ command: 'feature-tracker', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

describe('feature-tracker', () => {
  test('repo_mode_when_no_notesdir', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV } })

    const pane = await mount($)

    expect(await textOf(pane, 'head')).toContain('Features · r (repo)')
    expect(await pane.find({ key: 'module:Auth' })).toBeDefined()
  })

  test('vault_mode_resolves_project_from_groups', { options: { notesDir: V } }, async ($, on) => {
    await start($, on, { files: { [`${V}/_tools/groups.json`]: GROUPS, [`${V}/syph/features.md`]: INV } })

    const pane = await mount($)

    expect(await textOf(pane, 'head')).toContain('Features · syph (vault)')
    expect(await pane.find({ key: 'module:Auth' })).toBeDefined()
  })

  test('vault_mode_falls_back_to_basename', { options: { notesDir: V } }, async ($, on) => {
    await start($, on, { files: { [`${V}/r/features.md`]: INV } })

    const pane = await mount($)

    expect(await textOf(pane, 'head')).toContain('Features · r (vault)')
    expect(await pane.find({ key: 'module:Auth' })).toBeDefined()
  })

  test('missing_vault_folder_falls_back_with_hint', { options: { notesDir: V } }, async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV } })

    const pane = await mount($)

    expect(await textOf(pane, 'head')).toContain('(repo)')
    expect(await textOf(pane, 'hint')).toContain(`${V}/r`)
    expect(await pane.find({ key: 'module:Auth' })).toBeDefined()
  })

  test('parses_modules_paths_and_statuses', async ($, on) => {
    const inv =
      '## Auth\npaths: a/**\n- [done] Login — email\n- [partial] Reset — no expiry\n- [planned] OAuth\n' +
      '- [broken] Lockout — never unlocks\nsome free note\n\n## Billing\npaths: b/**\n- [done] Checkout — stripe\n'
    await start($, on, { files: { [`${DOCS}/features.md`]: inv } })
    const pane = await mount($)

    await pane.press({ key: 'toggle:Auth' })

    expect(await textOf(pane, 'meta:Auth')).toContain('1✓ 1◐ 1○ 1✗')
    expect(await textOf(pane, 'feature:Auth/Login')).toContain('Login')
    expect(await textOf(pane, 'feature:Auth/Login')).not.toContain('email')
    expect(await pane.find({ key: 'feature:Auth/OAuth' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /some free note/ })).toBeUndefined()
    expect(await pane.find({ key: 'module:Billing' })).toBeDefined()
  })

  test('pane_opens_after_inner_session_start', async ($, on) => {
    const seen = await start($, on)

    await mount($)

    expect(seen.order).toEqual(['session.start', 'ui.open'])
  })

  test('no_inventory_shows_scan_cta', async ($, on) => {
    await start($, on)

    const pane = await mount($)

    expect(await pane.find({ key: 'scan' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /No features\.md yet/ })).toBeDefined()
    expect(await pane.find({ key: 'meta:Auth' })).toBeUndefined()
  })

  test('scan_writes_new_inventory', { options: { notesDir: V } }, async ($, on) => {
    const seen = await start($, on, { files: { [`${V}/_tools/groups.json`]: GROUPS }, dirs: [`${V}/syph`] })
    const pane = await mount($)
    const answer = JSON.stringify({
      modules: [
        { name: 'Auth', paths: ['a/**'], features: [{ name: 'Login', desc: 'email', status: 'done' }] },
        { name: 'Billing', paths: ['b/**'], features: [] },
      ],
    })

    await pane.press({ key: 'scan' })
    await finish($, answer)

    const file = seen.fs.map.get(`${V}/syph/features.md`) ?? ''
    expect(file).toContain('type: doc')
    expect(file).toContain('Project: [[syph]]')
    expect(file).toContain('## Auth\npaths: a/**\n- [done] Login\n')
    expect(file).toContain('## Billing\npaths: b/**\n')
  })

  test('scan_merge_never_rewrites_user_lines', async ($, on) => {
    const mine = '## Auth\npaths: a/**\n- [done] Login — my words\nnote to self\n'
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: mine } })
    const pane = await mount($)
    const answer = JSON.stringify({
      modules: [
        { name: 'Auth', paths: ['a/**'], features: [{ name: 'Login', desc: 'theirs', status: 'partial' }, { name: 'Reset', desc: 'mail', status: 'planned' }] },
        { name: 'Billing', paths: ['b/**'], features: [] },
      ],
    })

    await pane.press({ key: 'scan' })
    await finish($, answer)

    expect(seen.fs.map.get(`${DOCS}/features.md`)).toBe(
      '## Auth\npaths: a/**\n- [done] Login — my words\nnote to self\n- [planned] Reset (new)\n\n## Billing (new)\npaths: b/**\n',
    )
  })

  test('scan_bad_json_writes_nothing', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'scan' })
    await finish($, 'I could not read the repo.')

    expect(seen.fs.map.get(`${DOCS}/features.md`)).toBe(INV)
    expect(seen.toasts.some(t => t.includes('scan'))).toBe(true)
    expect(await textOf(pane, 'scan')).toBe('Scan')
  })

  test('review_writes_note_with_checkboxes', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)

    const note = seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`) ?? ''
    expect(note).toContain('type: review')
    expect(note).toContain('module: Auth')
    expect(note).toContain(`sha: ${HEAD}`)
    expect(note.indexOf('## Tech debt')).toBeGreaterThan(-1)
    expect(note.indexOf('## Missing handling')).toBeGreaterThan(note.indexOf('## Tech debt'))
    expect(note).toContain('- [ ] high · a/x.ts:42 — t → f')
    expect(note).toContain('- [ ] med · a/y.ts — u → g')
    expect(note).not.toContain('Project: [[')
  })

  test('review_prompt_carries_prior_findings', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: PRIOR } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })

    const prompt = seen.spawns[0]?.prompt ?? ''
    const at = (s: string) => prompt.indexOf(s)
    expect(at('DO NOT REPEAT')).toBeGreaterThan(-1)
    expect(at('dup validation')).toBeGreaterThan(at('DO NOT REPEAT'))
    expect(at('STILL OPEN')).toBeGreaterThan(at('dup validation'))
    expect(at('no rate limit')).toBeGreaterThan(at('STILL OPEN'))
  })

  test('review_lists_resolved_and_keeps_old_notes', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: PRIOR } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, JSON.stringify({ findings: [], fixed: ['no rate limit'] }))

    expect(seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`)).toContain('## Resolved since last review\n- no rate limit')
    expect(seen.fs.map.get(PRIOR_PATH)).toBe(PRIOR)
  })

  test('review_never_edits_inventory', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)

    expect(seen.fs.map.get(`${DOCS}/features.md`)).toBe(INV)
    expect(seen.fs.writes).not.toContain(`${DOCS}/features.md`)
  })

  test('rerun_same_day_suffixes_filename', async ($, on) => {
    const first = `${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [first]: 'old' } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)

    expect(seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}-2.md`)).toContain('type: review')
    expect(seen.fs.map.get(first)).toBe('old')
  })

  test('review_spawns_opus_reader_with_scope', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })

    expect(seen.spawns).toHaveLength(1)
    expect(seen.spawns[0]).toMatchObject({ subagentType: 'feature-tracker:reader', model: 'opus' })
    expect(seen.spawns[0]?.prompt).toContain('a/**')
    expect(seen.spawns[0]?.prompt).toContain('Login')
  })

  test('reader_registered_readonly_and_hidden', async ($, on) => {
    const seen = await start($, on)

    const offer = await $.agent.offer({
      agent: 'feature-tracker:reader', description: 'reader', source: 'plugin', provider: { plugin: 'feature-tracker', tier: 'user' },
    })

    expect(seen.registered[0]).toMatchObject({ name: 'reader', tools: ['Read', 'Grep', 'Glob'], model: 'opus' })
    expect(offer).toMatchObject({ isOffered: false })
  })

  test('stale_counts_changed_files_since_sha', async ($, on) => {
    const seen = await start($, on, {
      files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: PRIOR },
      answers: { 'git diff --name-only abc1234 -- :(glob)a/**': 'a/1\na/2\na/3\n' },
    })

    const pane = await mount($)

    expect(await textOf(pane, 'meta:Auth')).toContain('stale · 3 files')
    expect(seen.ran).toContain('git diff --name-only abc1234 -- :(glob)a/**')
  })

  test('fresh_and_never_reviewed_states', async ($, on) => {
    const inv = `${INV}\n## Billing\npaths: b/**\n- [done] Checkout — stripe\n`
    await start($, on, { files: { [`${DOCS}/features.md`]: inv, [PRIOR_PATH]: PRIOR } })

    const pane = await mount($)

    expect(await textOf(pane, 'meta:Auth')).not.toContain('stale')
    expect(await textOf(pane, 'meta:Billing')).toContain('never reviewed')
  })

  test('open_count_from_latest_note', async ($, on) => {
    const note = `${PRIOR}- [ ] low · a/q.ts — second open → fix it\n`
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: note } })

    const pane = await mount($)

    expect(await textOf(pane, 'meta:Auth')).toContain('2 open')
  })

  test('plan_fixes_submits_prompt', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: PRIOR } })
    const pane = await mount($)

    await pane.press({ key: 'fix:Auth' })

    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toContain(PRIOR_PATH)
    expect(seen.submitted[0]).toContain('Auth')
    expect(seen.submitted[0]).toContain('plan mode')
  })

  test('plan_fixes_hidden_when_none_open', async ($, on) => {
    const done = PRIOR.replace('- [ ] high', '- [x] high')
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: done } })

    const pane = await mount($)

    expect(await textOf(pane, 'meta:Auth')).toContain('0 open')
    expect(await pane.find({ key: 'fix:Auth' })).toBeUndefined()
  })

  test('busy_module_blocks_second_review', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await pane.press({ key: 'review:Auth' })

    expect(seen.spawns).toHaveLength(1)
    expect(await textOf(pane, 'review:Auth')).toBe('reviewing…')
  })

  test('vault_note_has_project_wikilink', { options: { notesDir: V } }, async ($, on) => {
    const seen = await start($, on, { files: { [`${V}/_tools/groups.json`]: GROUPS, [`${V}/syph/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)

    const note = seen.fs.map.get(`${V}/syph/reviews/2026-10-19_auth-${HEAD}.md`) ?? ''
    expect(note).toContain('Project: [[syph]]')
    expect(note).toContain('group: product')
    expect(note).toContain('  - stack/nuxt')
  })

  test('command_opens_scans_reviews_and_rejects_unknown', async ($, on) => {
    const inv = `${INV}\n## Billing\npaths: b/**\n`
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: inv } })

    await command($, '')
    await command($, 'scan')
    await command($, 'review auth')
    const unknown = await command($, 'review Nope')

    expect(seen.opened).toContain('feature-tracker')
    expect(seen.spawns).toHaveLength(2)
    expect(seen.spawns[0]?.description).toContain('scan')
    expect(seen.spawns[0]?.prompt).toContain('at most 40 characters')
    expect(seen.spawns[0]?.prompt).not.toContain('"desc"')
    expect(seen.spawns[1]?.prompt).toContain('a/**')
    expect(unknown).toMatchObject({ text: expect.stringContaining('Auth, Billing') })
  })

  test('non_git_repo_reviews_without_staleness', async ($, on) => {
    const seen = await start($, on, {
      files: { [`${DOCS}/features.md`]: INV },
      answers: { 'git rev-parse --show-toplevel': { exit: 128 } },
    })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)

    expect(seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-nogit.md`)).toContain('sha: nogit')
    expect(await textOf(pane, 'meta:Auth')).not.toContain('stale')
    expect(seen.ran.some(a => a.startsWith('git diff'))).toBe(false)
  })

  test('reader_handback_never_reaches_main_loop', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)
    await pane.press({ key: 'review:Auth' })

    const entered = await handback($, 'a1')

    expect(entered).toMatchObject({ drop: expect.any(String) })
  })

  test('other_agent_messages_pass_through', async ($, on) => {
    await start($, on, { agents: [{ id: 'b1', type: 'Explore' }] })

    const entered = await handback($, 'b1')

    expect(entered).toMatchObject({ text: expect.stringContaining('from="b1"') })
    expect(entered).not.toHaveProperty('drop')
  })
})
