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
const ITEMS_NOTE = `${PRIOR}## Improvement\n- [ ] low · a/y.ts — cache list → memo\n`
const FINDINGS = JSON.stringify({
  findings: [
    { bucket: 'debt', sev: 'high', file: 'a/x.ts', line: 42, title: 't', why: 'w', fix: 'f' },
    { bucket: 'handling', sev: 'med', file: 'a/y.ts', title: 'u', why: 'w2', fix: 'g' },
    { bucket: 'debt', sev: 'low', file: 'a/z.ts', line: 1, title: 'v', why: '', fix: 'h' },
  ],
  fixed: [],
})
/** An Auth note whose fixes carry area tags: two auth-login (one high), one postgres, one untagged. */
const TAGGED_NOTE =
  '---\ntype: review\nmodule: Auth\nsha: abc1234\n---\n# Review — Auth (abc1234)\n\n## Missing handling\n' +
  '- [ ] med · `postgres` · a/db.ts — no pool → cap pool\n' +
  '- [ ] low · `auth-login` · a/login.ts:9 — weak message → reword\n' +
  '- [ ] high · `auth-login` · a/login.ts:42 — no rate limit → add limiter\n' +
  '- [ ] med · a/misc.ts — loose type → narrow\n'
/** INV plus a Billing module, and a Billing note whose two fixes are both high `billing-db`. */
const INV_BILLING = `${INV}\n## Billing\npaths: b/**\n- [done] Pay — card\n`
const BILLING_PATH = `${DOCS}/reviews/2026-10-15_billing-abc1234.md`
const BILLING_NOTE =
  '---\ntype: review\nmodule: Billing\nsha: abc1234\n---\n# Review — Billing (abc1234)\n\n## Missing handling\n' +
  '- [ ] high · `billing-db` · b/pay.ts:3 — double charge → idempotency key\n' +
  '- [ ] high · `billing-db` · b/refund.ts — refund race → lock row\n'
/** The verifier's answer with no verdicts: every finding is kept as the reader wrote it. */
const NO_VERDICTS = '{"verdicts":[]}'

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

type Setup = {
  files?: Record<string, string>
  dirs?: string[]
  answers?: Record<string, Answer>
  agents?: Array<{ id: string; type: string }>
  store?: Record<string, unknown> // the plugin's $.store before the session starts
}

/** Starts the session with every op the plugin reaches answered beneath it; hooks go in before the first `$` call. */
async function start($: Engine, on: On, { files = {}, dirs = [], answers = {}, agents = [], store = {} }: Setup = {}) {
  const seen = {
    ran: git(on, { 'git rev-parse --show-toplevel': `${R}\n`, 'git rev-parse --short=7 HEAD': `${HEAD}\n`, ...answers }),
    fs: fakeFs(on, files, dirs),
    spawns: [] as Array<{ subagentType: string; model?: string; prompt: string; description: string }>,
    registered: [] as Array<{ name: string; tools?: readonly string[]; model?: string }>,
    toasts: [] as string[],
    submitted: [] as string[],
    opened: [] as string[],
    widths: [] as Array<number | undefined>, // each ui.open's columns
    store: new Map(Object.entries(store)),
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
    seen.widths.push(e.columns)
    return { value: { isPlaced: true as const } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: NOON }))
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: R, surface: 'terminal', isInteractive: true })
  return seen
}

const mount = ($: Engine, bodyColumns = PANE.bodyColumns) =>
  $.ui.mount({ plugin: 'feature-tracker', surface: 'terminal', component: 'Pane', requestId: 'feature-tracker', props: { ...PANE, bodyColumns } })

/** The reader subagent `agentId` ends its run with `answer`. */
const finish = ($: Engine, answer: string, agentId = 'a1') =>
  $.turn.complete({ reason: 'answer', answer, durationMs: 1, isAborted: false, turnId: `t-${agentId}`, agentId })

const textOf = async (pane: Awaited<ReturnType<typeof mount>>, key: string) => (await pane.find({ key }))?.text ?? ''

/** A Button's chrome: undefined type when the key is not drawn. */
const look = async (pane: Awaited<ReturnType<typeof mount>>, key: string) => {
  const f = await pane.find({ key })
  return { type: f?.type, plain: f?.props.plain, variant: f?.props.variant }
}

/** Props of the first element child of `key`: an item's severity chip. */
const chipOf = async (pane: Awaited<ReturnType<typeof mount>>, key: string) =>
  ((await pane.find({ key }))?.children.find(c => typeof c === 'object') as { props?: Record<string, unknown> } | undefined)?.props

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
    await finish($, NO_VERDICTS, 'a2')

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

  test('review_prompt_offers_improve_bucket', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })

    const prompt = seen.spawns[0]?.prompt ?? ''
    expect(prompt).toContain('improve (')
    expect(prompt).toContain('missing|debt|handling|tests|security|improve')
  })

  test('review_note_lists_improvements_last', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)
    const answer = JSON.stringify({
      findings: [
        { bucket: 'improve', sev: 'low', file: 'a/y.ts', title: 'cache list', why: '', fix: 'memo' },
        { bucket: 'debt', sev: 'med', file: 'a/x.ts', title: 't', why: '', fix: 'f' },
      ],
      fixed: [],
    })

    await pane.press({ key: 'review:Auth' })
    await finish($, answer)
    await finish($, NO_VERDICTS, 'a2')

    const note = seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`) ?? ''
    expect(note.indexOf('## Tech debt')).toBeGreaterThan(-1)
    expect(note.indexOf('## Improvement')).toBeGreaterThan(note.indexOf('## Tech debt'))
    expect(note).toContain('- [ ] low · a/y.ts — cache list → memo')
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
    await finish($, NO_VERDICTS, 'a2')

    expect(seen.fs.map.get(`${DOCS}/features.md`)).toBe(INV)
    expect(seen.fs.writes).not.toContain(`${DOCS}/features.md`)
  })

  test('rerun_same_day_suffixes_filename', async ($, on) => {
    const first = `${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [first]: 'old' } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)
    await finish($, NO_VERDICTS, 'a2')

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



  test('ideas_counted_apart_from_open', async ($, on) => {
    const note = `${PRIOR}## Improvement\n- [ ] low · a/y.ts — cache list → memo\n- [ ] low · a/z.ts — merge steps → one call\n`
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: note } })

    const pane = await mount($)

    expect(await textOf(pane, 'meta:Auth')).toContain('1 open · 2 ideas')
  })



  test('note_button_opens_latest_note', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: PRIOR } })
    const pane = await mount($)

    await pane.press({ key: 'note:Auth' })

    expect(seen.ran).toContain(`open ${PRIOR_PATH}`)
  })

  test('note_open_failure_toasts_path', async ($, on) => {
    const answers = { [`open ${PRIOR_PATH}`]: { exit: 1 }, [`xdg-open ${PRIOR_PATH}`]: { exit: 1 } }
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: PRIOR }, answers })
    const pane = await mount($)

    await pane.press({ key: 'note:Auth' })

    expect(seen.toasts.join('\n')).toContain(PRIOR_PATH)
  })

  test('groups_start_collapsed_with_counts', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)

    await pane.press({ key: 'toggle:Auth' })

    expect(await textOf(pane, 'group:Auth:fixes')).toBe('▸ Fixes 1')
    expect(await textOf(pane, 'group:Auth:ideas')).toBe('▸ Ideas 1')
    expect(await pane.find({ key: 'item:Auth:fixes:0' })).toBeUndefined()
  })

  test('group_lists_unticked_items', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })

    await pane.press({ key: 'group:Auth:fixes' })
    await pane.press({ key: 'tag:Auth:fixes:untagged' })

    const row = await textOf(pane, 'item:Auth:fixes:0')
    expect(row).toContain('○')
    expect(row).toContain('high')
    expect(row).toContain('no rate limit')
    expect(await pane.find({ key: 'item:Auth:fixes:1' })).toBeUndefined()
  })

  test('plan_selected_sends_only_picked_lines', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:fixes' })
    await pane.press({ key: 'group:Auth:ideas' })
    await pane.press({ key: 'tag:Auth:ideas:untagged' })

    await pane.press({ key: 'item:Auth:ideas:0' })

    expect(await textOf(pane, 'plan:Auth')).toBe('Plan 1 selected')
    expect(await textOf(pane, 'item:Auth:ideas:0')).toContain('◉')

    await pane.press({ key: 'plan:Auth' })

    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toContain(PRIOR_PATH)
    expect(seen.submitted[0]).toContain('Auth')
    expect(seen.submitted[0]).toContain('plan mode')
    expect(seen.submitted[0]).toContain('- low · a/y.ts — cache list → memo')
    expect(seen.submitted[0]).not.toContain('no rate limit')
    expect(await pane.find({ key: 'plan:Auth' })).toBeUndefined()
  })

  test('all_selects_then_clears_group', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:fixes' })

    await pane.press({ key: 'all:Auth:fixes' })

    expect(await textOf(pane, 'plan:Auth')).toBe('Plan 1 selected')

    await pane.press({ key: 'all:Auth:fixes' })

    expect(await pane.find({ key: 'plan:Auth' })).toBeUndefined()
  })

  test('play_plans_single_item', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:ideas' })
    await pane.press({ key: 'tag:Auth:ideas:untagged' })

    await pane.press({ key: 'go:Auth:ideas:0' })

    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toContain('plan this finding')
    expect(seen.submitted[0]).toContain(PRIOR_PATH)
    expect(seen.submitted[0]).toContain('- low · a/y.ts — cache list → memo')
    expect(await pane.find({ key: 'plan:Auth' })).toBeUndefined()
  })

  test('action_buttons_framed_rows_plain', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:fixes' })
    await pane.press({ key: 'tag:Auth:fixes:untagged' })

    await pane.press({ key: 'item:Auth:fixes:0' })

    const framed = { type: 'Button', plain: undefined, variant: undefined }
    expect(await look(pane, 'scan')).toEqual(framed)
    expect(await look(pane, 'review:Auth')).toEqual(framed)
    expect(await look(pane, 'note:Auth')).toEqual(framed)
    expect(await look(pane, 'all:Auth:fixes')).toEqual(framed)
    expect(await look(pane, 'go:Auth:fixes:0')).toEqual(framed)
    expect(await look(pane, 'plan:Auth')).toEqual({ ...framed, variant: 'primary' })
    expect((await look(pane, 'toggle:Auth')).plain).toBe(true)
    expect((await look(pane, 'group:Auth:fixes')).plain).toBe(true)
    expect((await look(pane, 'item:Auth:fixes:0')).plain).toBe(true)
  })

  test('sev_chip_coloured_by_level', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:fixes' })
    await pane.press({ key: 'tag:Auth:fixes:untagged' })

    await pane.press({ key: 'group:Auth:ideas' })
    await pane.press({ key: 'tag:Auth:ideas:untagged' })

    expect(await chipOf(pane, 'item:Auth:fixes:0')).toMatchObject({ backgroundColor: 'error', color: 'inverseText' })
    expect(await chipOf(pane, 'item:Auth:ideas:0')).toMatchObject({ backgroundColor: 'suggestion' })
    expect(await textOf(pane, 'item:Auth:fixes:0')).toContain('high')
  })

  test('note_hidden_until_reviewed', async ($, on) => {
    const inv = `${INV}\n## Billing\npaths: b/**\n- [done] Checkout — stripe\n`
    await start($, on, { files: { [`${DOCS}/features.md`]: inv, [PRIOR_PATH]: PRIOR } })

    const pane = await mount($)

    expect(await pane.find({ key: 'note:Auth' })).toBeDefined()
    expect(await pane.find({ key: 'note:Billing' })).toBeUndefined()
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
    await finish($, NO_VERDICTS, 'a2')

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
    await finish($, NO_VERDICTS, 'a2')

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

  test('clear_reloads_inventory', async ($, on) => {
    const seen = await start($, on)
    seen.fs.map.set(`${DOCS}/features.md`, INV)

    await $.classic.SessionStart({ source: 'clear' })
    const pane = await mount($)

    expect(await pane.find({ key: 'module:Auth' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /No features\.md yet/ })).toBeUndefined()
    expect(seen.opened).toEqual(['feature-tracker', 'feature-tracker'])
  })

  test('clear_frees_busy_review', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)
    await pane.press({ key: 'review:Auth' })

    await $.classic.SessionStart({ source: 'clear' })
    await pane.press({ key: 'review:Auth' })

    expect(seen.spawns.map(s => s.description)).toEqual(['feature-tracker review: Auth', 'feature-tracker review: Auth'])
  })
  test('verifier_spawned_after_review', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)

    expect(seen.spawns).toHaveLength(2)
    expect(seen.spawns[1]).toMatchObject({ subagentType: 'feature-tracker:reader', model: 'opus', description: 'feature-tracker verify: Auth' })
    expect(seen.spawns[1]?.prompt).toContain('a/x.ts:42')
    expect(seen.spawns[1]?.prompt).toContain('0. [debt] high')
    expect(seen.fs.writes.some(w => w.includes('/reviews/'))).toBe(false)
    expect(await textOf(pane, 'review:Auth')).toBe('verifying…')
  })

  test('verifier_rejects_and_rerates', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)
    const verdicts = JSON.stringify({
      verdicts: [
        { i: 0, verdict: 'false', sev: 'high', why: 'handled at a/x.ts:40' },
        { i: 1, verdict: 'partly', sev: 'low', why: 'only offline' },
        { i: 2, verdict: 'true', sev: 'low', why: 'ok' },
      ],
    })

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)
    await finish($, verdicts, 'a2')

    const note = seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`) ?? ''
    expect(note).toContain('verified: 3/3')
    expect(note).toContain('## Rejected by verifier\n- [x] high · a/x.ts:42 — t → f')
    expect(note).toContain('  verify: handled at a/x.ts:40')
    expect(note).toContain('- [ ] low · a/y.ts — u → g\n  w2\n  verify: partly — only offline')
    expect(note).toContain('- [ ] low · a/z.ts:1 — v → h')
    expect(seen.toasts.some(t => t.includes('1 rejected'))).toBe(true)
  })

  test('verifier_bad_answer_keeps_findings', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)
    await finish($, 'nope', 'a2')

    const note = seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`) ?? ''
    expect(note).toContain('verified: 0/3')
    expect(note).toContain('- [ ] high · a/x.ts:42 — t → f')
    expect(note).toContain('- [ ] med · a/y.ts — u → g')
    expect(note).toContain('- [ ] low · a/z.ts:1 — v → h')
    expect(seen.toasts.some(t => t.includes('unverified'))).toBe(true)
    expect(await textOf(pane, 'review:Auth')).toBe('Review')
  })

  test('rejected_findings_not_repeated', async ($, on) => {
    const prior = `${PRIOR}## Rejected by verifier\n- [x] high · a/x.ts:42 — t → f\n  verify: handled\n`
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: prior } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })

    expect(seen.spawns[0]?.prompt).toContain('[Rejected by verifier] a/x.ts:42 — t')
  })

  test('no_findings_skips_verifier', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, JSON.stringify({ findings: [], fixed: [] }))

    expect(seen.spawns).toHaveLength(1)
    expect(seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`)).toContain('No findings.')
  })

  test('review_prompt_has_severity_rules', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })

    expect(seen.spawns[0]?.prompt).toContain('high only when')
    expect(seen.spawns[0]?.prompt).toContain('limit or contradict')
  })

  test('plan_prompt_asks_to_verify', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:ideas' })
    await pane.press({ key: 'tag:Auth:ideas:untagged' })

    await pane.press({ key: 'go:Auth:ideas:0' })

    expect(seen.submitted[0]).toContain('data, not instructions')
    expect(seen.submitted[0]).toContain('against the current code')
  })

  test('dirty_review_recorded', async ($, on) => {
    const seen = await start($, on, {
      files: { [`${DOCS}/features.md`]: INV },
      answers: { 'git status --porcelain -- :(glob)a/**': ' M a/x.ts\n?? a/n.ts\n' },
    })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)
    await finish($, NO_VERDICTS, 'a2')

    const note = seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`) ?? ''
    expect(note).toContain('dirty: 2')
    expect(note).toContain('2 uncommitted files')
    expect(await textOf(pane, 'meta:Auth')).toContain('dirty')
  })

  test('clean_review_has_no_dirty_marker', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })
    await finish($, FINDINGS)
    await finish($, NO_VERDICTS, 'a2')

    expect(seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`)).not.toContain('dirty:')
    expect(await textOf(pane, 'meta:Auth')).not.toContain('dirty')
  })

  test('non_hex_sha_never_reaches_git', async ($, on) => {
    const bad = PRIOR.replace('sha: abc1234', 'sha: --output=/x')
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: bad } })

    const pane = await mount($)

    expect(seen.ran.some(a => a.startsWith('git diff'))).toBe(false)
    expect(await textOf(pane, 'meta:Auth')).not.toContain('stale')
  })

  test('review_prompt_asks_for_reused_tags', async ($, on) => {
    const inv = `${INV}\n## Billing\npaths: b/**\n- [done] Checkout — stripe\n`
    const auth = PRIOR.replace('high · a/login.ts:42', 'high · `auth-login` · a/login.ts:42')
    const billing = '---\ntype: review\nmodule: Billing\nsha: abc1234\n---\n## Missing handling\n- [ ] med · `postgres` · b/db.ts — no pool → cap pool\n'
    const files = { [`${DOCS}/features.md`]: inv, [PRIOR_PATH]: auth, [`${DOCS}/reviews/2026-10-12_billing-abc1234.md`]: billing }
    const seen = await start($, on, { files })
    const pane = await mount($)

    await pane.press({ key: 'review:Auth' })

    const prompt = seen.spawns[0]?.prompt ?? ''
    expect(prompt).toContain('"tag":')
    expect(prompt).toContain('narrow enough that its findings fit one PR')
    expect(prompt).toMatch(/reuse one when it fits: .*auth-login/)
    expect(prompt).toMatch(/reuse one when it fits: .*postgres/)
    expect(prompt).toContain('auth-login · a/login.ts:42 — no rate limit')
  })

  test('review_note_writes_normalised_tag', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($)
    const tagged = JSON.parse(FINDINGS)
    tagged.findings[0].tag = 'Auth Login!'
    tagged.findings[1].tag = 'a'.repeat(40)

    await pane.press({ key: 'review:Auth' })
    await finish($, JSON.stringify(tagged))
    await finish($, NO_VERDICTS, 'a2')

    const note = seen.fs.map.get(`${DOCS}/reviews/2026-10-19_auth-${HEAD}.md`) ?? ''
    expect(note).toContain('- [ ] high · `auth-login` · a/x.ts:42 — t → f')
    expect(note).toContain(`- [ ] med · \`${'a'.repeat(24)}\` · a/y.ts — u → g`)
    expect(note).toContain('- [ ] low · a/z.ts:1 — v → h')
  })

  test('fixes_grouped_by_tag_most_urgent_first', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: TAGGED_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })

    await pane.press({ key: 'group:Auth:fixes' })

    const keys = (await pane.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('tag:'))
    expect(keys).toEqual(['tag:Auth:fixes:auth-login', 'tag:Auth:fixes:postgres', 'tag:Auth:fixes:untagged'])
    expect(await textOf(pane, 'tag:Auth:fixes:auth-login')).toBe('▸ auth-login 2 · 1 high')
    expect(await pane.find({ key: 'item:Auth:fixes:0' })).toBeUndefined()
  })

  test('tag_group_lists_its_items', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: TAGGED_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:fixes' })

    await pane.press({ key: 'tag:Auth:fixes:auth-login' })

    const rows = (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('item:'))
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.text).join('\n')).toContain('weak message')
    expect(rows.map(r => r.text).join('\n')).toContain('no rate limit')
    expect(await pane.find({ text: 'no pool' })).toBeUndefined()
  })

  test('pr_button_plans_tag_group', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: TAGGED_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:fixes' })

    await pane.press({ key: 'pr:Auth:fixes:auth-login' })

    expect(await look(pane, 'pr:Auth:fixes:auth-login')).toEqual({ type: 'Button', plain: undefined, variant: undefined })
    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toContain('one branch and one PR for area auth-login')
    expect(seen.submitted[0]).toContain('weak message → reword')
    expect(seen.submitted[0]).toContain('no rate limit → add limiter')
    expect(seen.submitted[0]).not.toContain('no pool')
  })

  test('plan_prompt_asks_to_tick_note', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: TAGGED_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:fixes' })

    await pane.press({ key: 'pr:Auth:fixes:auth-login' })

    expect(seen.submitted[0]).toContain(`tick its "- [ ]" box in ${PRIOR_PATH}`)
  })

  test('ticked_finding_leaves_group_after_main_turn', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: TAGGED_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })
    await pane.press({ key: 'group:Auth:fixes' })
    seen.fs.map.set(PRIOR_PATH, TAGGED_NOTE.replace('- [ ] high · `auth-login`', '- [x] high · `auth-login`'))

    await $.turn.complete({ reason: 'answer', answer: 'fixed', durationMs: 1, isAborted: false, turnId: 't-main' })

    expect(await textOf(pane, 'tag:Auth:fixes:auth-login')).toBe('▸ auth-login 1 · 1 low')
  })

  test('untagged_note_shows_one_group', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: ITEMS_NOTE } })
    const pane = await mount($)
    await pane.press({ key: 'toggle:Auth' })

    await pane.press({ key: 'group:Auth:fixes' })

    const keys = (await pane.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('tag:'))
    expect(keys).toEqual(['tag:Auth:fixes:untagged'])
    expect(await textOf(pane, 'tag:Auth:fixes:untagged')).toBe('▸ untagged 1 · 1 high')
  })

  test('layout_switch_defaults_to_list', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: TAGGED_NOTE } })

    const pane = await mount($, 96)

    expect(await textOf(pane, 'layout:1')).toBe('List')
    expect((await pane.find({ key: 'layout:1' }))?.props.variant).toBe('primary')
    expect(await textOf(pane, 'layout:2')).toBe('2 col')
    expect(await textOf(pane, 'layout:3')).toBe('3 col')
    expect(await pane.find({ key: 'toggle:Auth' })).toBeDefined()
    expect((await pane.findAll({ type: 'Box' })).some(b => b.key?.startsWith('card:'))).toBe(false)
  })

  test('layout_switch_requests_pane_width', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: TAGGED_NOTE } })
    const pane = await mount($, 96)
    const before = seen.widths.length

    await pane.press({ key: 'layout:2' })
    await pane.press({ key: 'layout:3' })
    await pane.press({ key: 'layout:1' })

    expect(seen.widths.slice(before)).toEqual([96, 144, 48])
    expect(await pane.find({ key: 'toggle:Auth' })).toBeDefined()
  })

  test('cards_sorted_by_criticality', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 96)

    await pane.press({ key: 'layout:2' })

    const keys = (await pane.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => k.startsWith('card:'))
    expect(keys).toEqual(['card:Billing:fixes:billing-db', 'card:Auth:fixes:auth-login', 'card:Auth:fixes:postgres', 'card:Auth:fixes:untagged'])
    expect(await pane.find({ key: 'toggle:Auth' })).toBeUndefined()
  })

  test('card_shows_summary_and_width', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 96)

    await pane.press({ key: 'layout:2' })

    const card = await pane.find({ key: 'card:Auth:fixes:auth-login' })
    expect(card?.text).toContain('auth-login')
    expect(card?.text).toContain('Auth · Fixes')
    expect(card?.text).toContain('1 high · 1 low')
    expect(await textOf(pane, 'fold:Auth:fixes:auth-login')).toBe('▸ 2 findings')
    expect(card?.props.width).toBe(47)
    expect(card?.props.borderStyle).toBe('round')
    const grid = await pane.find({ key: 'cards' })
    expect(grid?.props.columnGap).toBe(1)
    expect(grid?.props.gap).toBeUndefined() // a row gap leaves a blank line between bordered rows
    expect(grid?.props.paddingTop).toBe(1)
    expect(card?.props.marginTop).toBe(-1) // drawn over the bottom border of the card above
  })

  test('card_width_splits_three_ways', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 144)

    await pane.press({ key: 'layout:3' })

    expect((await pane.find({ key: 'card:Auth:fixes:auth-login' }))?.props.width).toBe(47)
  })

  test('card_expands_to_its_findings', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 96)
    await pane.press({ key: 'layout:2' })

    await pane.press({ key: 'fold:Auth:fixes:auth-login' })

    const card = await pane.find({ key: 'card:Auth:fixes:auth-login' })
    expect(await textOf(pane, 'fold:Auth:fixes:auth-login')).toBe('▾ 2 findings')
    expect(card?.text).toContain('no rate limit')
    expect(card?.text).toContain('weak message')
    expect(card?.text).not.toContain('no pool')
    const go = (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('go:Auth:fixes:auth-login:'))
    expect(go).toHaveLength(2)
  })

  test('card_summary_is_top_finding', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 96)
    await pane.press({ key: 'layout:2' })

    const sum = await pane.find({ key: 'sum:Auth:fixes:auth-login' })
    expect(sum?.text).toBe('no rate limit') // the high, not the low `weak message`
    expect(sum?.props.height).toBe(2)
    expect(sum?.props.overflow).toBe('hidden')

    await pane.press({ key: 'fold:Auth:fixes:auth-login' })

    expect(await pane.find({ key: 'sum:Auth:fixes:auth-login' })).toBeUndefined() // the open list shows it
  })

  test('card_buttons_submit_plan_prompts', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 96)
    await pane.press({ key: 'layout:2' })

    await pane.press({ key: 'pr:Billing:fixes:billing-db' })
    await pane.press({ key: 'fold:Auth:fixes:auth-login' })
    await pane.press({ key: 'go:Auth:fixes:auth-login:0' })

    expect(seen.submitted).toHaveLength(2)
    expect(seen.submitted[0]).toContain('one branch and one PR for area billing-db')
    expect(seen.submitted[0]).toContain(BILLING_PATH)
    expect(seen.submitted[1]?.match(/`auth-login`/g)).toHaveLength(1)
    expect(seen.submitted[1]).toContain('no rate limit') // a card lists its findings high first
    expect(seen.submitted[1]).not.toContain('one PR')
  })

  test('grid_without_findings_says_so', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV } })
    const pane = await mount($, 96)

    await pane.press({ key: 'layout:2' })

    expect(await textOf(pane, 'nocards')).toContain('No open findings')
    expect(await pane.find({ key: 'scan' })).toBeDefined()
  })

  test('narrow_pane_wraps_cards', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 48)

    await pane.press({ key: 'layout:3' })

    expect((await pane.find({ key: 'card:Auth:fixes:auth-login' }))?.props.width).toBe(48)
  })

  test('layout_choice_is_stored', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV, [PRIOR_PATH]: TAGGED_NOTE } })
    const pane = await mount($, 96)

    await pane.press({ key: 'layout:3' })

    expect(seen.store.get('layout')).toBe(3)
  })

  test('stored_layout_returns_next_session', async ($, on) => {
    const seen = await start($, on, {
      files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE },
      store: { layout: 2 },
    })

    const pane = await mount($, 96)

    expect(seen.widths).toEqual([96])
    expect((await pane.find({ key: 'layout:2' }))?.props.variant).toBe('primary')
    expect(await pane.find({ key: 'card:Billing:fixes:billing-db' })).toBeDefined()
    expect(await pane.find({ key: 'toggle:Auth' })).toBeUndefined()
  })

  test('clear_keeps_layout', async ($, on) => {
    const seen = await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 96)
    await pane.press({ key: 'layout:2' })

    await $.classic.SessionStart({ source: 'clear' })

    expect((await pane.findAll({ type: 'Box' })).some(b => b.key?.startsWith('card:'))).toBe(true)
    expect(seen.widths.at(-1)).toBe(96)
  })

  test('bad_stored_layout_falls_back_to_list', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV }, store: { layout: 'wide' } })

    const pane = await mount($)

    expect((await pane.find({ key: 'layout:1' }))?.props.variant).toBe('primary')
    expect(await pane.find({ key: 'toggle:Auth' })).toBeDefined()
  })

  test('card_shows_its_note_date', async ($, on) => {
    await start($, on, { files: { [`${DOCS}/features.md`]: INV_BILLING, [PRIOR_PATH]: TAGGED_NOTE, [BILLING_PATH]: BILLING_NOTE } })
    const pane = await mount($, 96)

    await pane.press({ key: 'layout:2' })

    expect((await pane.find({ key: 'card:Auth:fixes:auth-login' }))?.text).toContain('2026-10-12')
    expect((await pane.find({ key: 'card:Billing:fixes:billing-db' }))?.text).toContain('2026-10-15')
  })
})
