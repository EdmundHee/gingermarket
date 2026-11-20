import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Phase, PlanItem, Times, Tracker } from '../types'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PLAN = '# Fix the thing\n\n## Context\nwhy\n\n## Change\n1. edit a\n2. test b\n'
const MARK = 'mcp__plan-tracker__mark_done'
const AUDIT_SYS = 'You audit which' // the turn-end / Verify-all system prompt
const PANE = {
  title: 'Plan', isFocused: false, bodyColumns: 80, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

const seeded = (items: Array<[number, PlanItem['status'], Partial<PlanItem>?]>, note?: string): Tracker => ({
  nextId: items.length + 1,
  plans: [{
    id: 'p1', title: 'Seeded', file: '/tmp/seeded.md', approvedAt: '2026-10-08T00:00:00.000Z',
    items: items.map(([id, status, patch]) => ({ id, text: `item ${id}`, status, ...patch })),
    ...(note ? { note } : {}),
  }],
})

/** An audit reply in the shape the turn-end audit expects. */
const audit = (items: Array<[number, 'verified' | 'unverified', string]>, reply = 'partial', why = 'more to do') =>
  JSON.stringify({ items: items.map(([id, verdict, reason]) => ({ id, verdict, reason })), reply, why })

/** Fakes opus: every `$.model.complete` beneath the plugin answers `reply(e)`. Returns the call count. */
function opus(on: On, reply: (e: { system?: string; prompt: string }) => string) {
  const calls = { n: 0 }
  on('model.complete', (_$, e) => {
    calls.n += 1
    return { value: { isAnswered: true as const, text: reply(e), usage: USAGE } }
  })
  return calls
}

/** Fakes the engine's ExitPlanMode: the user approved `plan`. */
function approved(on: On, plan = PLAN) {
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({
    result: { plan, isAgent: false, filePath: '/tmp/plan.md' },
    text: 'User has approved your plan. You can now start coding.',
  }))
}

const CWD = '/tmp/plan-tracker-test'
const KEY = `tracker:${CWD}`
const DOC = '# Parser Implementation Plan\n\n### Task 1: Parser\n- [ ] **Step 1: test**\n\n### Task 2: CLI\n- [ ] **Step 1: test**\n'

/** Fakes the Skill and Write tools and the file system beneath the plugin; returns the paths read. */
function docs(on: On, doc = DOC, listing: Array<{ name: string; mtimeMs: number }> = []) {
  const reads: string[] = []
  on('tool.call', { tool: 'Skill' }, (_$, e) => ({ result: { success: true, commandName: String(e.skill) }, text: 'Launching skill' }))
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' as const, filePath: 'x' } }))
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    return { value: doc }
  })
  on('fs.list', () => ({ value: listing.map(f => ({ ...f, kind: 'file' as const, size: 1, isLink: false })) }))
  return reads
}

/** An Edit inside the repo unless `path` says otherwise. */
const repoEdit = ($: Engine, path = `${CWD}/src/a.ts`) => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })

/** An in-memory `$.store` the test can read; `mock.store` would hide it. */
function fakeStore(on: On, entries: Record<string, unknown>) {
  const map = new Map(Object.entries(entries))
  on('store.get', (_$, e) => ({ value: map.get(e.key) }))
  on('store.set', (_$, e) => { map.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$, e) => { map.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...map.keys()] }))
  return map
}

/** Starts the session with every op the plugin reaches answered beneath it; hooks go in before the first `$` call. */
/** `at`: the clock's time as the session starts; a stored live run ticks from then on. */
async function start($: Engine, on: On, tracker?: Tracker, messages: unknown[] = [], at = 0) {
  const seen = {
    state: undefined as Tracker | undefined,
    store: fakeStore(on, tracker ? { [KEY]: tracker } : {}),
    submitted: [] as string[],
    toasts: [] as string[],
    opened: [] as string[],
    focused: [] as string[],
    redraws: 0,
    clock: mock.clock(on),
    session: { id: 's1' },
  }
  on('session.id', () => ({ value: seen.session.id }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' as const, filePath: 'x' } }))
  on('ui.invalidate', () => {
    seen.redraws += 1
    return { value: undefined }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('state.set', { plugin: 'plan-tracker', key: 'tracker' }, (_$, e, next) => {
    seen.state = e.value as Tracker
    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__plan-tracker__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: messages as never }))
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    if (e.focus) seen.focused.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: { ok: true } }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { ok: true } }))
  await seen.clock.set(at)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  return seen
}

/** The main turn ends answered; `agentId` or `reason` override that. */
const endTurn = ($: Engine, over: { agentId?: string; reason?: 'answer' | 'aborted' | 'error' } = {}) =>
  $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1', ...over })

const edit = ($: Engine) => $.tool.call({ tool: 'Edit', file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' })

/** Fakes the AskUserQuestion dialog behind `$.ui.ask`: the user picks `label`. */
function asked(on: On, label: string) {
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({
    result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: label } },
  }))
}

/** Runs `/plan-tracker <args>` from the composer. */
const command = ($: Engine, args = '') =>
  $.command.run({ command: 'plan-tracker', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

/** A turn begins as the tracker's own work prompt (plan work) unless `text` says otherwise. */
const startTurn = ($: Engine, text = 'Work on plan item #1: item 1') => $.turn.start({ text, turnId: 't2' })

const T = 1_000_000_000
const SEC = 1000

/** A seeded group whose clock runs `phase` since `since`, with `time` already counted. */
const clocked = (
  items: Array<[number, PlanItem['status'], Partial<PlanItem>?]>,
  phase: Phase = 'dev',
  since = T,
  time: Times = {},
): Tracker => {
  const base = seeded(items)
  return { ...base, plans: base.plans.map(p => ({ ...p, time })), clock: { group: 'p1', phase, since, session: 's1' } }
}

/** The user sends a query while in plan mode. */
const planPrompt = ($: Engine) => $.classic.UserPromptSubmit({ prompt: 'plan this', permission_mode: 'plan' })

/** A Bash call as the main loop (or `agentId`) makes it. */
const bash = ($: Engine, command: string, over: { run_in_background?: boolean; agentId?: string } = {}) =>
  $.tool.call({ tool: 'Bash', command, ...over } as never)

const REVIEW = `{ cat brief.md; echo "MODE: plan-review"; cat plan.md; } | codex exec -s read-only -o out.md -`
const ACCEPT = `{ cat brief.md; echo "MODE: acceptance"; cat plan.md; } | codex exec -s read-only -o out.md -`

/** Mounts the pane, reads one keyed node's text, unmounts. */
async function textOf($: Engine, key: string) {
  const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
  const text = (await pane.find({ key }))?.text
  await pane.unmount()
  return text
}

/** The time on a group's phase row (`time:<group>:<phase>`), or undefined when the row is not drawn. */
const timeRow = ($: Engine, group: string, phase: Phase | 'total') => textOf($, `time:${group}:${phase}`)

describe('plan-tracker', () => {
  test('approval adds a group with opus\'s items', async ($, on) => {
    opus(on, () => '["edit a", "test b"]')
    approved(on)
    const seen = await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })

    const t = seen.state
    expect(t?.plans).toHaveLength(1)
    expect(t?.plans[0]?.title).toBe('Fix the thing')
    expect(t?.plans[0]?.items.map(i => [i.id, i.text, i.status])).toEqual([[1, 'edit a', 'open'], [2, 'test b', 'open']])
    expect(seen.store.get(KEY)).toEqual(t)
  })

  test('rejected plan adds nothing', async ($, on) => {
    const calls = opus(on, () => '["never"]')
    on('tool.call', { tool: 'ExitPlanMode' }, () => ({ isError: true as const, result: 'rejected', text: 'The user rejected the plan.' }))
    const seen = await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })

    expect(seen.state?.plans ?? []).toHaveLength(0)
    expect(seen.store.has(KEY)).toBe(false)
    expect(calls.n).toBe(0)
  })

  test('mark_done records the claim without a model call', async ($, on) => {
    const calls = opus(on, () => audit([[1, 'verified', 'x']]))
    const seen = await start($, on, seeded([[1, 'open']]))

    const ran = await $.tool.call({ tool: MARK, id: 1, evidence: 'edited a.ts' })

    expect(calls.n).toBe(0)
    // a registered tool's result is a string or content blocks; the engine refuses an object
    expect(typeof ran.result).toBe('string')
    expect(ran.result).toContain('#1')
    const item = seen.state?.plans[0]?.items[0]
    expect(item?.status).toBe('claimed')
    expect(item?.claim).toBe('edited a.ts')
  })

  test('turn end verifies a claimed item', async ($, on) => {
    const prompts: string[] = []
    on('model.complete', (_$, e) => {
      prompts.push(e.prompt)
      return { value: { isAnswered: true as const, text: audit([[1, 'verified', 'Edit on a.ts seen']], 'done'), usage: USAGE } }
    })
    const seen = await start($, on, seeded([[1, 'open']]))

    await $.tool.call({ tool: MARK, id: 1, evidence: 'edited a.ts' })
    await endTurn($)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('developer claims done: edited a.ts')
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('verified')
  })

  test('turn end leaves an unproven claim claimed', async ($, on) => {
    opus(on, () => audit([[1, 'unverified', 'no edit on a.ts']], 'done'))
    const seen = await start($, on, seeded([[1, 'open']]))

    await $.tool.call({ tool: MARK, id: 1, evidence: 'done' })
    await endTurn($)

    const item = seen.state?.plans[0]?.items[0]
    expect(item?.status).toBe('claimed')
    expect(item?.note).toBe('no edit on a.ts')
  })

  test('mark_done on a verified item changes nothing', async ($, on) => {
    const seen = await start($, on, seeded([[1, 'verified', { note: 'by you' }]]))

    const ran = await $.tool.call({ tool: MARK, id: 1, evidence: 'again' })

    expect(ran.result).toContain('already verified')
    expect(seen.state?.plans[0]?.items[0]).toEqual({ id: 1, text: 'item 1', status: 'verified', note: 'by you' })
  })

  test('compose shows a fresh claim as audit pending', async ($, on) => {
    await start($, on, seeded([[1, 'claimed', { claim: 'edited a.ts' }]]))

    const { sections } = await $.prompt.compose({
      model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'],
      tools: ['Read', MARK], outputStyle: null, traits: [],
    })

    expect(sections.find(s => s.id === 'plan-tracker:open')?.text ?? '').toContain('#1 [claimed, audit pending] item 1')
  })

  test('mark_done on an unknown id answers a string, no opus', async ($, on) => {
    const calls = opus(on, () => '{"verdict":"verified","reason":"x"}')
    await start($, on, seeded([[1, 'open']]))

    const ran = await $.tool.call({ tool: MARK, id: 9, evidence: 'done' })

    expect(calls.n).toBe(0)
    expect(typeof ran.result).toBe('string')
    expect(ran.result).toContain('#9')
  })

  test('mark_done on an unknown id lists the open items', async ($, on) => {
    opus(on, () => '{"verdict":"verified","reason":"x"}')
    await start($, on, seeded([[1, 'open'], [2, 'verified'], [3, 'claimed']]))

    const ran = await $.tool.call({ tool: MARK, id: 9, evidence: 'done' })

    expect(ran.result).toContain('#9')
    expect(ran.result).toContain('#1 item 1')
    expect(ran.result).toContain('#3 item 3')
    expect(ran.result).not.toContain('#2')
  })

  test('compose lists open and claimed items', async ($, on) => {
    await start($, on, seeded([[1, 'open'], [2, 'claimed', { note: 'no test run' }], [3, 'verified']]))

    const { sections } = await $.prompt.compose({
      model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'],
      tools: ['Read', MARK], outputStyle: null, traits: [],
    })

    const text = sections.find(s => s.id === 'plan-tracker:open')?.text ?? ''
    expect(text).toContain('#1 [open] item 1')
    expect(text).toContain('#2 [claimed, unverified: no test run] item 2')
    expect(text).not.toContain('#3')
    expect(text).toContain('mark_done')
  })

  test('pressing work submits a prompt', async ($, on) => {
    const seen = await start($, on, seeded([[1, 'open'], [2, 'open']]))

    const terminal = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await terminal.press({ key: 'toggle:p1' }) // groups start collapsed; the expanded set is shared by both surfaces
    await terminal.press({ key: 'work:1' })
    const desktop = await $.ui.mount({ plugin: 'plan-tracker', surface: 'desktop', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await desktop.press({ key: 'work:2' })

    expect(seen.submitted).toHaveLength(2)
    expect(seen.submitted[0]).toContain('#1')
    expect(seen.submitted[0]).toContain('item 1')
    expect(seen.submitted[0]).toContain('mark_done')
    expect(seen.submitted[1]).toContain('#2')
  })

  test('second work press while queued is ignored', async ($, on) => {
    const seen = await start($, on, seeded([[1, 'open']]))
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'toggle:p1' })

    await pane.press({ key: 'work:1' })
    await pane.press({ key: 'work:1' })
    expect(seen.submitted).toHaveLength(1)

    await $.turn.start({ text: seen.submitted[0] ?? '', turnId: 't2' })
    await pane.press({ key: 'work:1' })
    expect(seen.submitted).toHaveLength(2)
  })

  test('verify all applies verdicts without unverifying', async ($, on) => {
    opus(on, () => audit([[1, 'verified', 'ok'], [2, 'unverified', 'still no test']], 'done'))
    const seen = await start($, on, seeded([[1, 'open'], [2, 'claimed', { note: 'no test run' }], [3, 'verified']]))

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'verify-all' })

    const items = seen.state?.plans[0]?.items ?? []
    expect(items.map(i => i.status)).toEqual(['verified', 'claimed', 'verified'])
    expect(items[1]?.note).toBe('still no test')
  })

  test('turn end audits open items after an edit', async ($, on) => {
    const calls = opus(on, () => audit([[1, 'verified', 'edit seen']], 'done'))
    const seen = await start($, on, seeded([[1, 'open']]))

    await edit($)
    await endTurn($)

    expect(calls.n).toBe(1)
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('verified')
    expect(seen.store.get(KEY)).toEqual(seen.state)
  })

  test('turn end without work calls no opus', async ($, on) => {
    const calls = opus(on, () => audit([[1, 'verified', 'x']]))
    const seen = await start($, on, seeded([[1, 'open']]))

    await $.tool.call({ tool: 'Read', file_path: '/tmp/a.ts' })
    await endTurn($)

    expect(calls.n).toBe(0)
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('open')
  })

  test('turn end with everything verified calls no opus', async ($, on) => {
    const calls = opus(on, () => audit([]))
    await start($, on, seeded([[1, 'verified']]))

    await edit($)
    await endTurn($)

    expect(calls.n).toBe(0)
  })

  test('subagent and aborted turns call no opus', async ($, on) => {
    const calls = opus(on, () => audit([[1, 'verified', 'x']]))
    const seen = await start($, on, seeded([[1, 'open']]))

    await edit($)
    await endTurn($, { agentId: 'a1' })
    await endTurn($, { reason: 'aborted' })

    expect(calls.n).toBe(0)
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('open')
  })

  test('mark_done is listed in the prompt, not deferred', async ($, on) => {
    await start($, on)

    const r = await $.tool.describe({ tool: MARK, description: 'd', isDeferred: true, provider: { plugin: 'plan-tracker', tier: 'user' } })

    expect(r.isDeferred).toBe(false)
    expect(r.description).toBe('d')
  })

  test('second approval adds a group on top', async ($, on) => {
    opus(on, () => '["x"]')
    approved(on, '# Second plan\n\n1. x\n')
    const seen = await start($, on, seeded([[1, 'open']]))

    await $.tool.call({ tool: 'ExitPlanMode' })

    const t = seen.state
    expect(t?.plans.map(p => p.title)).toEqual(['Second plan', 'Seeded'])
    expect(t?.plans[0]?.items[0]?.id).toBe(2)
    expect(t?.plans[1]?.items[0]?.status).toBe('open')
  })

  test('approving the same plan again keeps its group and ids', async ($, on) => {
    const calls = opus(on, () => '["a","b"]')
    approved(on)
    const seen = await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })
    await $.tool.call({ tool: 'ExitPlanMode' })

    const t = seen.state
    expect(t?.plans).toHaveLength(1)
    expect(t?.plans[0]?.items.map(i => i.id)).toEqual([1, 2])
    expect(t?.nextId).toBe(3)
    expect(calls.n).toBe(1)
  })

  test('approving the same plan after a failed extraction replaces the empty group', async ($, on) => {
    const calls = opus(on, () => (calls.n === 1 ? 'Sorry, I cannot help with that.' : '["a"]'))
    approved(on)
    const seen = await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })
    await $.tool.call({ tool: 'ExitPlanMode' })

    const t = seen.state
    expect(t?.plans).toHaveLength(1)
    expect(t?.plans[0]?.items.map(i => [i.id, i.text])).toEqual([[1, 'a']])
  })

  test('failed extraction leaves a retry', async ($, on) => {
    opus(on, () => 'Sorry, I cannot help with that.')
    approved(on)
    const seen = await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })

    const group = seen.state?.plans[0]
    expect(group?.items).toHaveLength(0)
    expect(group?.note).toBeDefined()
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    expect(await pane.find({ key: 'extract-again' })).toBeDefined()
  })

  test('session start loads the store', async ($, on) => {
    const stored = seeded([[1, 'verified'], [2, 'open']])

    const seen = await start($, on, stored)

    expect(seen.state).toEqual(stored)
  })

  test('plan turn sends the leftovers back as one prompt', async ($, on) => {
    opus(on, () => audit([[1, 'verified', 'ok'], [2, 'unverified', 'no test'], [3, 'unverified', 'untouched']], 'partial', 'said #3 is next'))
    const seen = await start($, on, seeded([[1, 'open'], [2, 'open'], [3, 'open']]))

    await startTurn($)
    await edit($)
    await endTurn($)

    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toMatch(/^Work on plan items #2 #3:/)
    expect(seen.submitted[0]).toContain('no test')
    expect(seen.submitted[0]).not.toContain('#1')
    const items = seen.state?.plans[0]?.items ?? []
    expect(items.map(i => [i.status, i.nudges ?? 0])).toEqual([['verified', 0], ['open', 1], ['open', 1]])
  })

  test('subagent turn start keeps the plan turn nudge', async ($, on) => {
    opus(on, () => audit([[1, 'verified', 'ok'], [2, 'unverified', 'no test'], [3, 'unverified', 'untouched']], 'partial', 'said #3 is next'))
    const seen = await start($, on, seeded([[1, 'open'], [2, 'open'], [3, 'open']]))

    await startTurn($)
    await $.turn.start({ text: 'Explore the parser', turnId: 't3', agentId: 'sub' })
    await edit($)
    await endTurn($)

    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toMatch(/^Work on plan items #2 #3:/)
  })

  test('blocked reply notes the group and sends nothing', async ($, on) => {
    opus(on, () => audit([[1, 'verified', 'ok'], [2, 'unverified', 'untouched']], 'blocked', 'asked which DB'))
    const seen = await start($, on, seeded([[1, 'open'], [2, 'open']]))

    await startTurn($)
    await edit($)
    await endTurn($)

    expect(seen.submitted).toHaveLength(0)
    expect(seen.state?.plans[0]?.note).toContain('asked which DB')
    expect(seen.state?.plans[0]?.items[1]?.nudges ?? 0).toBe(0)
  })

  test('nudge cap leaves the item to the user', async ($, on) => {
    opus(on, () => audit([[2, 'unverified', 'still untouched']], 'partial'))
    const seen = await start($, on, seeded([[1, 'verified'], [2, 'open', { nudges: 2 }]]))

    await startTurn($, 'Work on plan item #2: item 2')
    await edit($)
    await endTurn($)

    expect(seen.submitted).toHaveLength(0)
    expect(seen.state?.plans[0]?.note).toContain('#2')
    expect(seen.state?.plans[0]?.note).toContain('▶')
  })

  test('typed turn audits but sends nothing', async ($, on) => {
    const calls = opus(on, () => audit([[1, 'verified', 'ok'], [2, 'unverified', 'untouched']], 'partial'))
    const seen = await start($, on, seeded([[1, 'open'], [2, 'open']]))

    await startTurn($, 'fix the typo')
    await edit($)
    await endTurn($)

    expect(calls.n).toBe(1)
    expect(seen.submitted).toHaveLength(0)
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('verified')
  })

  test('approval turn with no work audits and nudges', async ($, on) => {
    const calls = opus(on, e =>
      e.system?.startsWith(AUDIT_SYS)
        ? audit([[1, 'unverified', 'not started'], [2, 'unverified', 'not started']], 'partial', 'stopped after approval')
        : '["edit a", "test b"]',
    )
    approved(on)
    const seen = await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })
    await endTurn($)

    expect(calls.n).toBe(2)
    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toContain('#1 #2')
    expect(seen.submitted[0]).toContain('Fix the thing')
  })

  test('mark_done turn nudges the rest', async ($, on) => {
    opus(on, () => audit([[1, 'verified', 'Edit seen'], [2, 'unverified', 'untouched']], 'done', 'says all done'))
    const seen = await start($, on, seeded([[1, 'open'], [2, 'open']]))

    await startTurn($, 'do the plan')
    await $.tool.call({ tool: MARK, id: 1, evidence: 'edited a.ts' })
    await endTurn($)

    expect(seen.submitted).toHaveLength(1)
    expect(seen.submitted[0]).toContain('#2')
    expect(seen.submitted[0]).not.toContain('#1')
  })

  test('unparsed audit sends nothing', async ($, on) => {
    opus(on, () => 'Sorry, I cannot help with that.')
    const seen = await start($, on, seeded([[1, 'open']]))

    await startTurn($)
    await edit($)
    await endTurn($)

    expect(seen.submitted).toHaveLength(0)
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('open')
    expect(seen.state?.plans[0]?.note).toBeUndefined()
  })

  test('multi-id work prompt clears every queued id', async ($, on) => {
    const seen = await start($, on, seeded([[1, 'open'], [2, 'open']]))
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'toggle:p1' })

    await pane.press({ key: 'work:1' })
    expect(seen.submitted).toHaveLength(1)

    await startTurn($, 'Work on plan items #1 #2:\n#1 item 1\n#2 item 2')
    await pane.press({ key: 'work:1' })
    expect(seen.submitted).toHaveLength(2)
  })

  test('approval keeps every item opus lists', async ($, on) => {
    const forty = Array.from({ length: 40 }, (_, n) => `step ${n + 1}`)
    opus(on, () => JSON.stringify(forty))
    approved(on)
    const seen = await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })

    const items = seen.state?.plans[0]?.items ?? []
    expect(items).toHaveLength(40)
    expect(items[39]?.text).toBe('step 40')
  })

  test('compose lists every open item', async ($, on) => {
    const forty = Array.from({ length: 40 }, (_, n): [number, PlanItem['status']] => [n + 1, 'open'])
    await start($, on, seeded(forty))

    const { sections } = await $.prompt.compose({
      model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'],
      tools: ['Read', MARK], outputStyle: null, traits: [],
    })

    const text = sections.find(s => s.id === 'plan-tracker:open')?.text ?? ''
    expect(text).toContain('#40 [open] item 40')
  })

  test('pane shows nudges and the group note', async ($, on) => {
    await start($, on, seeded([[1, 'open', { nudges: 1 }]], 'waiting on you: which DB'))

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'toggle:p1' })

    expect(await pane.find({ type: 'Text', text: /↻1/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /waiting on you: which DB/ })).toBeDefined()
  })

  test('extraction asks opus, checks ask sonnet', async ($, on) => {
    const models: string[] = []
    on('model.complete', (_$, e) => {
      models.push(e.model)
      const text = e.system?.startsWith('You extract') ? '["edit a"]' : audit([[1, 'unverified', 'x']], 'done')
      return { value: { isAnswered: true as const, text, usage: USAGE } }
    })
    approved(on)
    await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })
    await $.tool.call({ tool: MARK, id: 1, evidence: 'edited a' })
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'verify-all' })

    expect(models).toEqual(['opus', 'sonnet'])
  })
  test('verifier sees the head and tail of a long tool output', async ($, on) => {
    const prompts: string[] = []
    on('model.complete', (_$, e) => {
      prompts.push(e.prompt)
      return { value: { isAnswered: true as const, text: audit([[1, 'verified', 'x']], 'done'), usage: USAGE } }
    })
    const out = `HEAD-MARK ${'(pass) a test\n'.repeat(200)}(fail) TAIL-MARK Received: ["haiku"]`
    const transcript = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'test' }, text: out }] }]
    await start($, on, seeded([[1, 'open']]), transcript)

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'verify-all' })

    expect(prompts[0]).toContain('HEAD-MARK')
    expect(prompts[0]).toContain('TAIL-MARK Received: ["haiku"]')
  })

  /** The tracker's reminder line on a tool result, if any. */
  const reminder = (r: { context?: readonly string[] }) => (r.context ?? []).filter(c => c.startsWith('plan-tracker:'))

  test('third work call reminds about open items', async ($, on) => {
    await start($, on, seeded([[1, 'open']]))

    const first = await edit($)
    const second = await edit($)
    const third = await edit($)

    expect(reminder(first)).toHaveLength(0)
    expect(reminder(second)).toHaveLength(0)
    expect(reminder(third)).toHaveLength(1)
    expect(reminder(third)[0]).toContain('#1 item 1')
    expect(reminder(third)[0]).toContain('mark_done')
  })

  test('no reminder when nothing is open or in a subagent', async ($, on) => {
    await start($, on, seeded([[1, 'open']]))
    // the typed args leave agentId out; the test's engine `$` passes the input whole, as a subagent's loop does
    const subEdit = { tool: 'Edit' as const, file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b', agentId: 'sub' }
    const sub = () => $.tool.call(subEdit)

    const inSub = [await sub(), await sub(), await sub()]
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'toggle:p1' })
    await pane.press({ key: 'done:1' })
    const onMain = [await edit($), await edit($), await edit($)]

    expect(inSub.flatMap(reminder)).toHaveLength(0)
    expect(onMain.flatMap(reminder)).toHaveLength(0)
  })

  test('mark_done restarts the reminder count', async ($, on) => {
    await start($, on, seeded([[1, 'open'], [2, 'open']]))

    const before = [await edit($), await edit($)]
    await $.tool.call({ tool: MARK, id: 1, evidence: 'edited a.ts' })
    const after = [await edit($), await edit($)]
    const due = await edit($)

    expect([...before, ...after].flatMap(reminder)).toHaveLength(0)
    expect(reminder(due)).toHaveLength(1)
    expect(reminder(due)[0]).toContain('#2 item 2')
    expect(reminder(due)[0]).not.toContain('#1 ')
  })

  test('execution skill tracks the plan doc by task heading', async ($, on) => {
    const calls = opus(on, () => '["never"]')
    const reads = docs(on)
    const seen = await start($, on)

    await $.tool.call({ tool: 'Skill', skill: 'superpowers:executing-plans', args: 'docs/superpowers/plans/p.md' })

    const group = seen.state?.plans[0]
    expect(seen.state?.plans).toHaveLength(1)
    expect(group?.items.map(i => [i.text, i.status])).toEqual([['Task 1: Parser', 'open'], ['Task 2: CLI', 'open']])
    // the engine resolves a relative path before the op, so the plugin resolves it against the session cwd itself
    expect(group?.file).toBe(`${CWD}/docs/superpowers/plans/p.md`)
    expect(reads).toEqual([`${CWD}/docs/superpowers/plans/p.md`])
    expect(calls.n).toBe(0)
  })

  test('execution skill falls back to the last plan doc written', async ($, on) => {
    const reads = docs(on)
    const seen = await start($, on)
    const doc = `${CWD}/docs/superpowers/plans/q.md`

    await $.tool.call({ tool: 'Write', file_path: doc, content: DOC })
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:subagent-driven-development' })

    expect(reads).toEqual([doc])
    expect(seen.state?.plans).toHaveLength(1)
  })

  test('execution skill falls back to the newest plan doc on disk', async ($, on) => {
    const reads = docs(on, DOC, [{ name: 'old.md', mtimeMs: 1 }, { name: 'new.md', mtimeMs: 2 }, { name: 'notes.txt', mtimeMs: 3 }])
    const seen = await start($, on)

    await $.tool.call({ tool: 'Skill', skill: 'superpowers:executing-plans' })

    expect(reads).toEqual([`${CWD}/docs/superpowers/plans/new.md`])
    expect(seen.state?.plans).toHaveLength(1)
  })

  test('a non-execution skill tracks nothing', async ($, on) => {
    const reads = docs(on)
    const seen = await start($, on)

    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })

    expect(seen.state?.plans ?? []).toHaveLength(0)
    expect(reads).toHaveLength(0)
  })

  test('a doc without task headings falls back to opus', async ($, on) => {
    const calls = opus(on, () => '["a","b"]')
    docs(on, PLAN)
    const seen = await start($, on)

    await $.tool.call({ tool: 'Skill', skill: 'superpowers:executing-plans', args: 'docs/superpowers/plans/p.md' })

    expect(calls.n).toBe(1)
    expect(seen.state?.plans[0]?.items.map(i => i.text)).toEqual(['a', 'b'])
  })

  test('first repo edit tracks the typed prompt once', async ($, on) => {
    const calls = opus(on, () => '["add x","test x"]')
    const seen = await start($, on)

    await startTurn($, 'add x with a test')
    await repoEdit($)
    await repoEdit($)

    const group = seen.state?.plans[0]
    expect(calls.n).toBe(1)
    expect(seen.state?.plans).toHaveLength(1)
    expect(group?.title).toBe('add x with a test')
    expect(group?.items.map(i => i.text)).toEqual(['add x', 'test x'])
    expect(group?.file).toBe('')
  })

  test('subagent turn start keeps the typed prompt', async ($, on) => {
    const calls = opus(on, () => '["add x","test x"]')
    const seen = await start($, on)

    await startTurn($, 'add x with a test')
    await $.turn.start({ text: 'Explore the repo', turnId: 't3', agentId: 'sub' })
    await repoEdit($)

    expect(calls.n).toBe(1)
    expect(seen.state?.plans.map(p => p.title)).toEqual(['add x with a test'])
  })

  test('edits outside the repo or in docs/superpowers track no prompt', async ($, on) => {
    const calls = opus(on, () => '["x"]')
    const seen = await start($, on)

    await startTurn($, 'write the spec')
    await edit($)
    await repoEdit($, `${CWD}-other/a.ts`)
    await repoEdit($, `${CWD}/docs/superpowers/specs/s.md`)
    await $.tool.call({ tool: 'Read', file_path: `${CWD}/src/a.ts` })

    expect(calls.n).toBe(0)
    expect(seen.state?.plans ?? []).toHaveLength(0)
  })

  test('a prompt with nothing to do adds no group', async ($, on) => {
    opus(on, () => '[]')
    const seen = await start($, on)

    await startTurn($, 'tidy up')
    await repoEdit($)

    expect(seen.state?.plans ?? []).toHaveLength(0)
    expect(seen.store.has(KEY)).toBe(false)
    expect(seen.toasts).toHaveLength(0)
  })

  test('a follow-up prompt gets its own group', async ($, on) => {
    const prompts: string[] = []
    on('model.complete', (_$, e) => {
      prompts.push(e.prompt)
      const text = prompts.length === 1 ? '["add x","test x"]' : '["fix y"]'
      return { value: { isAnswered: true as const, text, usage: USAGE } }
    })
    const seen = await start($, on)

    await startTurn($, 'add x with a test')
    await repoEdit($)
    await startTurn($, 'also fix y')
    await repoEdit($)

    const t = seen.state
    expect(t?.plans.map(p => p.title)).toEqual(['also fix y', 'add x with a test'])
    expect(t?.plans[0]?.items.map(i => [i.id, i.text])).toEqual([[3, 'fix y']])
    expect(prompts[1]).toContain('#1 add x')
    expect(prompts[1]).toContain('#2 test x')
  })

  test('pane shows the plan file path', async ($, on) => {
    const base = seeded([[1, 'open']])
    await start($, on, { ...base, plans: base.plans.map(p => ({ ...p, file: `${CWD}/docs/superpowers/plans/p.md` })) })

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'toggle:p1' })

    expect(await pane.find({ type: 'Text', text: 'docs/superpowers/plans/p.md' })).toBeDefined()
  })

  test('pane_groups_from_three_sources_shows_three_sections', async ($, on) => {
    const base = seeded([[1, 'verified'], [2, 'open']]).plans[0]!
    const group = (id: string, file: string, items: PlanItem[]) => ({ ...base, id, title: id, file, items })
    await start($, on, {
      nextId: 5,
      plans: [
        group('task', '', [{ id: 4, text: 'typed', status: 'open' }]),
        group('doc', `${CWD}/docs/superpowers/plans/x.md`, base.items),
        group('mode', '/Users/x/.claude/plans/y.md', [{ id: 3, text: 'approved', status: 'verified' }]),
      ],
    })

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })

    const sections = (await pane.findAll({ type: 'Box' })).map(s => s.key).filter(k => k?.startsWith('section:'))
    expect(sections).toEqual(['section:docs', 'section:mode', 'section:tasks'])
    expect((await pane.find({ key: 'section:docs' }))?.text).toContain('PLAN DOCS')
    expect((await pane.find({ key: 'section:docs' }))?.text).toContain('1/2')
    expect((await pane.find({ key: 'section:mode' }))?.text).toContain('1/1')
    expect((await pane.find({ key: 'section:tasks' }))?.text).toContain('0/1')
  })

  test('pane_with_only_typed_tasks_shows_only_tasks_section', async ($, on) => {
    const base = seeded([[1, 'open']])
    await start($, on, { ...base, plans: base.plans.map(p => ({ ...p, file: '' })) })

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })

    expect(await pane.find({ key: 'section:tasks' })).toBeDefined()
    expect(await pane.find({ key: 'section:docs' })).toBeUndefined()
    expect(await pane.find({ key: 'section:mode' })).toBeUndefined()
  })

  test('reset_confirmed_wipes_tracker', async ($, on) => {
    asked(on, 'Wipe')
    const seen = await start($, on, seeded([[1, 'open']]))

    const ran = await command($, 'reset')

    expect(ran).toMatchObject({ text: 'Plan tracker wiped.' })
    expect(seen.state?.plans).toEqual([])
    expect(seen.store.get(KEY)).toEqual({ nextId: 2, plans: [] })
  })

  test('reset_declined_keeps_tracker', async ($, on) => {
    asked(on, 'Keep')
    const seen = await start($, on, seeded([[1, 'open']]))

    const ran = await command($, 'reset')

    expect(ran).toMatchObject({ text: 'Kept.' })
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('open')
  })

  test('clear_reloads_tracker', async ($, on) => {
    const seen = await start($, on, seeded([[1, 'open']]))
    const stored = seeded([[1, 'verified'], [2, 'open']])
    seen.store.set(KEY, stored)

    await $.classic.SessionStart({ source: 'clear' })

    expect(seen.state).toEqual(stored)
  })

  test('clear_frees_queued_item', async ($, on) => {
    const seen = await start($, on, seeded([[1, 'open']]))
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'toggle:p1' })
    await pane.press({ key: 'work:1' })

    await $.classic.SessionStart({ source: 'clear' })
    await pane.press({ key: 'work:1' })

    expect(seen.submitted).toHaveLength(2)
  })

  test('remove_button_drops_group', async ($, on) => {
    const seen = await start($, on, seeded([[1, 'open']]))

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'remove:p1' })

    expect(seen.state?.plans).toEqual([])
    expect((seen.store.get(KEY) as Tracker).plans).toEqual([])
  })

  test('extract_again_fills_failed_group', async ($, on) => {
    opus(on, () => '["a", "b"]')
    on('fs.read', () => ({ value: PLAN }))
    const seen = await start($, on, seeded([], 'extraction failed'))

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'extract-again' })

    const group = seen.state?.plans[0]
    expect(group?.items.map(i => [i.id, i.text, i.status])).toEqual([[1, 'a', 'open'], [2, 'b', 'open']])
    expect(group?.note).toBeUndefined()
    expect(seen.state?.nextId).toBe(3)
  })

  test('command_opens_plan_pane', async ($, on) => {
    const seen = await start($, on)
    seen.opened.length = 0 // session start opens the pane unasked

    const ran = await command($)

    expect(seen.opened).toEqual(['plan-tracker'])
    expect(ran).toMatchObject({ text: 'Plan tracker pane opened.' })
  })

  // ── per-plan phase timing ────────────────────────────────────────────────

  test('plan_mode_prompt_starts_a_planning_run', async ($, on) => {
    const seen = await start($, on, undefined, [], T)

    await planPrompt($)
    await seen.clock.advance(5 * SEC)

    expect(seen.focused).toEqual(['plan-tracker'])
    expect(await textOf($, 'pending')).toContain('Planning (not approved yet)')
    const row = await timeRow($, 'pending', 'plan')
    expect(row).toContain('●')
    expect(row).toMatch(/(^|\D)5s$/)
    expect((seen.store.get(KEY) as Tracker).clock).toMatchObject({ phase: 'plan', since: T })
  })

  test('default_mode_prompt_starts_nothing', async ($, on) => {
    const seen = await start($, on)

    await $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode: 'default' })

    expect(seen.state?.clock).toBeUndefined()
    expect(seen.focused).toEqual([])
  })

  test('follow_up_plan_prompt_keeps_the_run', async ($, on) => {
    const seen = await start($, on, undefined, [], T)
    await planPrompt($)

    await seen.clock.advance(60 * SEC)
    await planPrompt($)

    expect(seen.state?.pending?.plan).toBe(60 * SEC)
    expect(seen.state?.clock).toMatchObject({ phase: 'plan', since: T + 60 * SEC })
    expect(seen.focused).toHaveLength(1)
  })

  test('approval_moves_planning_time_into_the_group', async ($, on) => {
    opus(on, () => '["edit a", "test b"]')
    approved(on)
    const seen = await start($, on, undefined, [], T)
    await planPrompt($)

    await seen.clock.advance(90 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })
    await seen.clock.advance(60 * SEC)

    const id = seen.state?.plans[0]?.id ?? ''
    expect(await timeRow($, id, 'plan')).toContain('1m 30s')
    const dev = await timeRow($, id, 'dev')
    expect(dev).toContain('1m 00s')
    expect(dev).toContain('●')
    expect(await timeRow($, id, 'total')).toContain('2m 30s')
    expect(await textOf($, 'pending')).toBeUndefined()
  })

  test('approval_without_plan_prompt_starts_in_dev', async ($, on) => {
    opus(on, () => '["edit a"]')
    approved(on)
    const seen = await start($, on, undefined, [], T)

    await $.tool.call({ tool: 'ExitPlanMode' })
    await seen.clock.advance(20 * SEC)

    const id = seen.state?.plans[0]?.id ?? ''
    expect(await timeRow($, id, 'dev')).toMatch(/(^|\D)20s$/)
    expect(await timeRow($, id, 'plan')).toBeUndefined()
  })

  test('codex_plan_review_splits_from_plan', async ($, on) => {
    opus(on, () => '["edit a"]')
    approved(on)
    const seen = await start($, on, undefined, [], T)
    await planPrompt($)

    await seen.clock.advance(30 * SEC)
    await bash($, REVIEW)
    await seen.clock.advance(20 * SEC)
    await $.tool.call({ tool: 'Write', file_path: '/Users/x/.claude/plans/p.md', content: 'plan' })
    await seen.clock.advance(10 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })

    const id = seen.state?.plans[0]?.id ?? ''
    expect(await timeRow($, id, 'plan')).toMatch(/(^|\D)40s$/)
    expect(await timeRow($, id, 'review')).toMatch(/(^|\D)20s$/)
  })

  test('repo_edit_is_dev_test_command_is_test_git_switches_nothing', async ($, on) => {
    const seen = await start($, on, clocked([[1, 'open']], 'dev'), [], T)

    await seen.clock.advance(10 * SEC)
    await bash($, 'claude plugin test plan-tracker')
    await seen.clock.advance(5 * SEC)
    await bash($, 'git status')
    await seen.clock.advance(5 * SEC)
    await repoEdit($)

    expect(await timeRow($, 'p1', 'dev')).toMatch(/(^|\D)10s$/)
    expect(await timeRow($, 'p1', 'test')).toMatch(/(^|\D)10s$/)
    expect(seen.state?.clock?.phase).toBe('dev')
  })

  test('test_tracker_run_counts_as_test_work', async ($, on) => {
    const calls = opus(on, () => audit([[1, 'verified', 'tests ran']], 'done'))
    let release!: () => void
    const ran = new Promise<void>(r => { release = r })
    on('tool.call', { tool: /^mcp__test-tracker__run_tests$/ }, async () => {
      await ran
      return { result: 'exit 0 · ✓ 1 ✗ 0 · 0.1s' }
    })
    // two items: verifying the last one would stop the clock and hide the time card
    const seen = await start($, on, clocked([[1, 'open'], [2, 'open']], 'dev'), [], T)

    await seen.clock.advance(10 * SEC)
    const call = $.tool.call({ tool: 'mcp__test-tracker__run_tests', command: 'pytest -q' } as never)
    await seen.clock.advance(5 * SEC)
    const whileHeld = await timeRow($, 'p1', 'test')
    release()
    await call
    await endTurn($)

    expect(whileHeld).toContain('●')
    expect(whileHeld).toMatch(/(^|\D)5s$/)
    expect(calls.n).toBe(1)
  })

  test('acceptance_is_codex_verify_then_edits_are_review_fixes', async ($, on) => {
    const seen = await start($, on, clocked([[1, 'open']], 'test'), [], T)

    await bash($, ACCEPT)
    await seen.clock.advance(30 * SEC)
    await repoEdit($)
    await seen.clock.advance(15 * SEC)

    expect(await timeRow($, 'p1', 'verify')).toMatch(/(^|\D)30s$/)
    const fixes = await timeRow($, 'p1', 'fixes')
    expect(fixes).toContain('Review fixes')
    expect(fixes).toContain('●')
    expect(fixes).toMatch(/(^|\D)15s$/)
  })

  test('turn_end_pauses_the_clock_and_next_turn_resumes', async ($, on) => {
    const seen = await start($, on, clocked([[1, 'open']], 'dev'), [], T)

    await endTurn($)
    await seen.clock.advance(120 * SEC)
    await $.turn.start({ text: 'carry on', turnId: 't3' })
    await seen.clock.advance(5 * SEC)

    const dev = await timeRow($, 'p1', 'dev')
    expect(dev).toContain('●')
    expect(dev).toMatch(/(^|\D)5s$/)
    expect(await timeRow($, 'p1', 'total')).toMatch(/(^|\D)5s$/)
    expect(await timeRow($, 'p1', 'waiting')).toBeUndefined()
    expect(seen.state?.plans[0]?.time?.waiting).toBeUndefined()
  })

  test('background_codex_keeps_counting_through_turn_end', async ($, on) => {
    const seen = await start($, on, undefined, [], T)
    await planPrompt($)

    await bash($, REVIEW, { run_in_background: true })
    await endTurn($)
    await seen.clock.advance(180 * SEC)
    await startTurn($, '') // the result's notification starts this turn
    await endTurn($)
    await seen.clock.advance(60 * SEC)

    expect(await timeRow($, 'pending', 'review')).toContain('3m 00s')
    expect(await timeRow($, 'pending', 'total')).toContain('3m 00s')
    expect(await timeRow($, 'pending', 'waiting')).toBeUndefined()
    expect(seen.state?.pending?.waiting).toBeUndefined()
  })

  test('typed_prompt_while_background_codex_runs_ends_its_codex_time', async ($, on) => {
    const seen = await start($, on, undefined, [], T)
    await planPrompt($)
    await bash($, REVIEW, { run_in_background: true })
    await endTurn($)

    await seen.clock.advance(60 * SEC)
    await planPrompt($) // the user types again in plan mode while Codex still runs
    await $.turn.start({ text: 'plan this', turnId: 't3' })
    await seen.clock.advance(60 * SEC)
    await $.tool.call({ tool: 'Write', file_path: '/Users/x/.claude/plans/p.md', content: 'plan' })

    expect(await timeRow($, 'pending', 'review')).toContain('1m 00s')
    const plan = await timeRow($, 'pending', 'plan')
    expect(plan).toContain('●')
    expect(plan).toContain('1m 00s')
  })

  test('dialog_time_is_not_counted', async ($, on) => {
    const late: { advance?: (ms: number) => Promise<void> } = {} // the clock exists only once start() has run
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
      await late.advance?.(40 * SEC)
      return { result: { questions: e.questions, answers: {} } }
    })
    const seen = await start($, on, clocked([[1, 'open']], 'dev'), [], T)
    late.advance = seen.clock.advance

    await $.tool.call({
      tool: 'AskUserQuestion',
      questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] }],
    } as never)
    await seen.clock.advance(5 * SEC)

    const dev = await timeRow($, 'p1', 'dev')
    expect(dev).toContain('●')
    expect(dev).toMatch(/(^|\D)5s$/)
    expect(await timeRow($, 'p1', 'total')).toMatch(/(^|\D)5s$/)
    expect(await timeRow($, 'p1', 'waiting')).toBeUndefined()
    expect(seen.state?.plans[0]?.time?.waiting).toBeUndefined()
  })

  test('last_item_verified_stops_the_clock', async ($, on) => {
    opus(on, () => audit([[1, 'verified', 'seen']]))
    const seen = await start($, on, clocked([[1, 'claimed', { claim: 'ran it' }]], 'dev'), [], T)

    await seen.clock.advance(10 * SEC)
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'verify-all' })
    await pane.unmount()
    await seen.clock.advance(600 * SEC)

    expect(seen.state?.clock).toBeUndefined()
    expect(seen.state?.plans[0]?.time?.dev).toBe(10 * SEC)
    expect(await textOf($, 'head:p1')).toMatch(/\b10s/)
  })

  test('clear_keeps_buckets_and_the_running_clock', async ($, on) => {
    const seen = await start($, on, clocked([[1, 'open']], 'dev', T, { plan: 30 * SEC }), [], T + 50 * SEC)

    await $.classic.SessionStart({ source: 'clear' })
    await seen.clock.advance(10 * SEC)

    expect(await timeRow($, 'p1', 'plan')).toMatch(/(^|\D)30s$/)
    const dev = await timeRow($, 'p1', 'dev')
    expect(dev).toContain('●')
    expect(dev).toContain('1m 00s')
  })

  test('new_session_skips_the_gap_a_reload_does_not', async ($, on) => {
    const stored = clocked([[1, 'open']], 'dev')
    const seen = await start($, on, { ...stored, clock: { ...stored.clock!, session: 'old' } }, [], T + 8 * 3600 * SEC)

    await seen.clock.advance(5 * SEC)
    const first = await timeRow($, 'p1', 'dev')
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true }) // a plugin reload: same session id
    await seen.clock.advance(5 * SEC)

    expect(first).toMatch(/(^|\D)5s$/)
    expect(await timeRow($, 'p1', 'dev')).toMatch(/(^|\D)10s$/)
  })

  test('failed_extraction_keeps_the_planning_clock', async ($, on) => {
    opus(on, () => 'not json')
    approved(on)
    const seen = await start($, on, undefined, [], T)
    await planPrompt($)

    await seen.clock.advance(30 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })
    await seen.clock.advance(10 * SEC)

    const id = seen.state?.plans[0]?.id ?? ''
    expect(seen.state?.plans[0]?.items).toEqual([])
    expect(seen.state?.clock?.group).toBe(id)
    expect(await timeRow($, id, 'plan')).toMatch(/(^|\D)30s$/)
    expect(await timeRow($, id, 'dev')).toMatch(/(^|\D)10s$/)
  })

  test('rejected_plan_keeps_planning_and_skips_the_dialog_time', async ($, on) => {
    const late: { advance?: (ms: number) => Promise<void> } = {}
    on('tool.call', { tool: 'ExitPlanMode' }, async () => {
      await late.advance?.(30 * SEC) // the user reads the plan, then rejects it
      return { isError: true as const, result: 'rejected', text: 'The user rejected the plan.' }
    })
    const seen = await start($, on, undefined, [], T)
    late.advance = seen.clock.advance
    await planPrompt($)

    await seen.clock.advance(30 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })
    await seen.clock.advance(20 * SEC)

    expect(seen.state?.clock?.group).toBeUndefined()
    expect(seen.state?.plans).toEqual([])
    const plan = await timeRow($, 'pending', 'plan')
    expect(plan).toContain('●')
    expect(plan).toMatch(/(^|\D)50s$/)
    expect(await timeRow($, 'pending', 'waiting')).toBeUndefined()
    expect(seen.state?.pending?.waiting).toBeUndefined()
  })

  test('removed_group_stops_the_clock', async ($, on) => {
    const seen = await start($, on, clocked([[1, 'open']], 'dev'), [], T)
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })

    await seen.clock.advance(10 * SEC)
    await pane.press({ key: 'remove:p1' })

    expect(seen.state?.plans).toEqual([])
    expect(seen.state?.clock).toBeUndefined()
    expect((seen.store.get(KEY) as Tracker).clock).toBeUndefined()
  })

  test('mark_done_on_another_group_moves_the_clock', async ($, on) => {
    const base = clocked([[1, 'open']], 'dev')
    const p1 = base.plans[0]!
    const tracker: Tracker = { ...base, nextId: 3, plans: [p1, { ...p1, id: 'p2', title: 'Other', items: [{ id: 2, text: 'item 2', status: 'open' }] }] }
    const seen = await start($, on, tracker, [], T)

    await seen.clock.advance(10 * SEC)
    await $.tool.call({ tool: MARK, id: 2, evidence: 'did it' })
    await seen.clock.advance(10 * SEC)

    const a = await timeRow($, 'p1', 'dev')
    const b = await timeRow($, 'p2', 'dev')
    expect(a).toMatch(/(^|\D)10s$/)
    expect(a).not.toContain('●')
    expect(b).toMatch(/(^|\D)10s$/)
    expect(b).toContain('●')
  })

  test('work_prompt_restarts_the_clock_on_an_unfinished_group', async ($, on) => {
    const base = seeded([[1, 'open']])
    const p1 = base.plans[0]!
    const tracker: Tracker = { ...base, nextId: 3, plans: [p1, { ...p1, id: 'p2', title: 'Done', items: [{ id: 2, text: 'item 2', status: 'verified' }] }] }
    const seen = await start($, on, tracker, [], T)

    await startTurn($, 'Work on plan item #1: item 1')
    await seen.clock.advance(20 * SEC)

    expect(seen.state?.clock).toMatchObject({ group: 'p1', phase: 'dev' })
    const dev = await timeRow($, 'p1', 'dev')
    expect(dev).toContain('●')
    expect(dev).toMatch(/(^|\D)20s$/)
  })

  test('resumed_group_with_codex_verify_time_edits_as_review_fixes', async ($, on) => {
    const base = seeded([[1, 'open']])
    const p1 = { ...base.plans[0]!, time: { verify: 30 * SEC } }
    const tracker: Tracker = { ...base, nextId: 3, plans: [p1, { ...p1, id: 'p2', title: 'Done', time: {}, items: [{ id: 2, text: 'item 2', status: 'verified' }] }] }
    const seen = await start($, on, tracker, [], T)

    await startTurn($, 'Work on plan item #1: item 1')
    await repoEdit($)
    await seen.clock.advance(10 * SEC)

    expect(seen.state?.clock?.phase).toBe('fixes')
    const fixes = await timeRow($, 'p1', 'fixes')
    expect(fixes).toContain('●')
    expect(fixes).toMatch(/(^|\D)10s$/)
    expect(await timeRow($, 'p1', 'dev')).toBeUndefined()
  })

  test('subagent_test_run_counts_as_test', async ($, on) => {
    const seen = await start($, on, clocked([[1, 'open']], 'dev'), [], T)

    await bash($, 'claude plugin test plan-tracker', { agentId: 'sub' })
    await seen.clock.advance(10 * SEC)

    const row = await timeRow($, 'p1', 'test')
    expect(row).toContain('●')
    expect(row).toMatch(/(^|\D)10s$/)
  })

  test('groups_start_collapsed_and_toggle_shows_items', async ($, on) => {
    await start($, on, seeded([[1, 'open'], [2, 'open']], 'waiting on you: which DB'))
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })

    const collapsed = await pane.find({ key: 'work:1' })
    const note = await pane.find({ type: 'Text', text: /waiting on you: which DB/ })
    await pane.press({ key: 'toggle:p1' })
    const open = await pane.find({ key: 'work:1' })
    await pane.press({ key: 'toggle:p1' })

    expect(collapsed).toBeUndefined()
    expect(note).toBeDefined()
    expect(open).toBeDefined()
    expect(await pane.find({ key: 'work:1' })).toBeUndefined()
  })

  test('verified_group_is_one_line_with_its_total', async ($, on) => {
    const base = seeded([[1, 'verified'], [2, 'verified']])
    await start($, on, { ...base, plans: base.plans.map(p => ({ ...p, time: { dev: 180 * SEC } })) })

    const head = await textOf($, 'head:p1')

    expect(head).toContain('2/2')
    expect(head).toContain('3m 00s')
    expect(await timeRow($, 'p1', 'dev')).toBeUndefined()
  })

  test('extraction_time_counts_as_dev_not_plan', async ($, on) => {
    approved(on)
    const late: { advance?: (ms: number) => Promise<void> } = {}
    on('model.complete', async () => {
      await late.advance?.(10 * SEC)
      return { value: { isAnswered: true as const, text: '["edit a"]', usage: USAGE } }
    })
    const seen = await start($, on, undefined, [], T)
    late.advance = seen.clock.advance
    await planPrompt($)

    await seen.clock.advance(30 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })

    const id = seen.state?.plans[0]?.id ?? ''
    expect(await timeRow($, id, 'plan')).toMatch(/(^|\D)30s$/)
    expect(await timeRow($, id, 'dev')).toMatch(/(^|\D)10s$/)
  })

  test('typed_task_counts_from_its_prompt', async ($, on) => {
    opus(on, () => '["do x"]')
    const seen = await start($, on, undefined, [], T)

    await $.turn.start({ text: 'please do x', turnId: 't9' })
    await seen.clock.advance(20 * SEC)
    await repoEdit($)

    const id = seen.state?.plans[0]?.id ?? ''
    expect(seen.state?.clock).toMatchObject({ group: id, phase: 'dev' })
    expect(await timeRow($, id, 'dev')).toMatch(/(^|\D)20s$/)
  })

  test('reapproval_after_failed_extraction_keeps_the_time', async ($, on) => {
    let answer = 'not json'
    opus(on, () => answer)
    approved(on)
    const seen = await start($, on, undefined, [], T)
    await planPrompt($)
    await seen.clock.advance(30 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })

    answer = '["edit a"]'
    await seen.clock.advance(30 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })
    await seen.clock.advance(10 * SEC)

    const id = seen.state?.plans[0]?.id ?? ''
    expect(seen.state?.plans).toHaveLength(1)
    expect(seen.state?.clock?.group).toBe(id)
    expect(await timeRow($, id, 'plan')).toMatch(/(^|\D)30s$/)
    expect(await timeRow($, id, 'dev')).toMatch(/(^|\D)40s$/)
  })

  test('reapproved_verified_plan_takes_the_planning_time_and_stops', async ($, on) => {
    opus(on, () => '["edit a"]')
    approved(on)
    const seen = await start($, on, undefined, [], T)
    await $.tool.call({ tool: 'ExitPlanMode' })
    const id = seen.state?.plans[0]?.id ?? ''
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: `toggle:${id}` })
    await pane.press({ key: 'done:1' })
    await pane.unmount()
    await seen.clock.advance(100 * SEC)
    await planPrompt($)

    await seen.clock.advance(20 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })

    expect(seen.state?.plans).toHaveLength(1)
    expect(seen.state?.plans[0]?.time?.plan).toBe(20 * SEC)
    expect(seen.state?.clock).toBeUndefined()
  })

  test('plan_prompt_during_a_group_run_stops_that_group', async ($, on) => {
    const seen = await start($, on, clocked([[1, 'open']], 'dev'), [], T)

    await seen.clock.advance(10 * SEC)
    await planPrompt($)

    expect(seen.state?.plans[0]?.time?.dev).toBe(10 * SEC)
    expect(seen.state?.clock).toMatchObject({ phase: 'plan', since: T + 10 * SEC })
    expect(seen.state?.clock?.group).toBeUndefined()
  })

  test('tick_redraws_only_while_a_clock_runs', async ($, on) => {
    opus(on, () => audit([[1, 'verified', 'seen']]))
    const seen = await start($, on, clocked([[1, 'claimed', { claim: 'ran it' }]], 'dev'), [], T)
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await seen.clock.advance(3 * SEC)
    const live = seen.redraws

    await pane.press({ key: 'verify-all' })
    const atEnd = seen.redraws
    await seen.clock.advance(30 * SEC)

    expect(live).toBe(3)
    expect(seen.redraws).toBe(atEnd)
  })

  test('long_run_shows_hours_and_minutes', async ($, on) => {
    await start($, on, clocked([[1, 'open']], 'dev'), [], T + 3723 * SEC)

    expect(await timeRow($, 'p1', 'total')).toContain('1h 02m')
  })

  test('old_group_without_time_shows_no_phase_rows', async ($, on) => {
    await start($, on, seeded([[1, 'open']]))

    expect(await timeRow($, 'p1', 'total')).toBeUndefined()
    expect(await timeRow($, 'p1', 'dev')).toBeUndefined()
  })

  test('stored_waiting_bucket_is_left_out_of_total', async ($, on) => {
    const base = seeded([[1, 'open']])
    await start($, on, { ...base, plans: base.plans.map(p => ({ ...p, time: { dev: 10 * SEC, waiting: 60 * SEC } })) })

    const total = await timeRow($, 'p1', 'total')

    expect(await timeRow($, 'p1', 'dev')).toMatch(/(^|\D)10s$/)
    expect(total).toMatch(/(^|\D)10s$/)
    expect(await timeRow($, 'p1', 'waiting')).toBeUndefined()
  })

  test('paused_clock_stops_redrawing', async ($, on) => {
    const seen = await start($, on, clocked([[1, 'open']], 'dev'), [], T + 10 * SEC)
    await endTurn($)
    const atPause = seen.redraws

    await seen.clock.advance(30 * SEC)

    expect(seen.redraws).toBe(atPause)
    const dev = await timeRow($, 'p1', 'dev')
    expect(dev).not.toContain('●')
    expect(dev).toMatch(/(^|\D)10s$/)
    expect(await timeRow($, 'p1', 'total')).toMatch(/(^|\D)10s$/)
  })

  test('approval_dialog_time_is_not_counted', async ($, on) => {
    opus(on, () => '["edit a", "test b"]')
    const late: { advance?: (ms: number) => Promise<void> } = {}
    on('tool.call', { tool: 'ExitPlanMode' }, async () => {
      await late.advance?.(40 * SEC) // the user reads the plan, then approves it
      return { result: { plan: PLAN, isAgent: false, filePath: '/tmp/plan.md' }, text: 'User has approved your plan.' }
    })
    const seen = await start($, on, undefined, [], T)
    late.advance = seen.clock.advance
    await planPrompt($)

    await seen.clock.advance(90 * SEC)
    await $.tool.call({ tool: 'ExitPlanMode' })
    await seen.clock.advance(60 * SEC)

    const id = seen.state?.plans[0]?.id ?? ''
    expect(await timeRow($, id, 'plan')).toContain('1m 30s')
    const dev = await timeRow($, id, 'dev')
    expect(dev).toContain('●')
    expect(dev).toContain('1m 00s')
    expect(await timeRow($, id, 'total')).toContain('2m 30s')
  })

  test('stored_paused_clock_resumes_without_the_gap', async ($, on) => {
    const stored = clocked([[1, 'open']], 'waiting', T, { dev: 10 * SEC })
    const seen = await start($, on, { ...stored, clock: { ...stored.clock!, resume: 'dev' } }, [], T + 300 * SEC)

    await $.turn.start({ text: 'carry on', turnId: 't3' })
    await seen.clock.advance(5 * SEC)

    const dev = await timeRow($, 'p1', 'dev')
    expect(dev).toContain('●')
    expect(dev).toMatch(/(^|\D)15s$/)
    expect(await timeRow($, 'p1', 'total')).toMatch(/(^|\D)15s$/)
    expect(await timeRow($, 'p1', 'waiting')).toBeUndefined()
  })

  test('verified_line_leaves_out_stored_waiting', async ($, on) => {
    const base = seeded([[1, 'verified'], [2, 'verified']])
    await start($, on, { ...base, plans: base.plans.map(p => ({ ...p, time: { dev: 180 * SEC, waiting: 120 * SEC } })) })

    const head = await textOf($, 'head:p1')

    expect(head).toContain('2/2 3m 00s')
  })

  test('approval_drops_stored_pending_waiting', async ($, on) => {
    opus(on, () => '["edit a"]')
    approved(on)
    const stored: Tracker = { nextId: 1, plans: [], pending: { plan: 30 * SEC, waiting: 60 * SEC }, clock: { phase: 'plan', since: T, session: 's1' } }
    const seen = await start($, on, stored, [], T)

    await $.tool.call({ tool: 'ExitPlanMode' })
    await seen.clock.advance(10 * SEC)

    const id = seen.state?.plans[0]?.id ?? ''
    expect(await timeRow($, id, 'plan')).toMatch(/(^|\D)30s$/)
    const dev = await timeRow($, id, 'dev')
    expect(dev).toContain('●')
    expect(dev).toMatch(/(^|\D)10s$/)
    expect(await timeRow($, id, 'total')).toMatch(/(^|\D)40s$/)
    expect(await timeRow($, id, 'waiting')).toBeUndefined()
  })

  test('idle_dialog_keeps_the_clock_paused', async ($, on) => {
    asked(on, 'Keep')
    const seen = await start($, on, clocked([[1, 'open']], 'dev'), [], T + 10 * SEC)
    await endTurn($)

    await command($, 'reset')
    await seen.clock.advance(60 * SEC)

    expect(seen.state?.plans[0]?.time?.dev).toBe(10 * SEC)
    expect(seen.state?.clock?.phase).toBe('waiting')
    expect(await timeRow($, 'p1', 'total')).toMatch(/(^|\D)10s$/)
  })
})
