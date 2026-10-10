import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { PlanItem, Tracker } from '../types'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PLAN = '# Fix the thing\n\n## Context\nwhy\n\n## Change\n1. edit a\n2. test b\n'
const MARK = 'mcp__plan-tracker__mark_done'
const AUDIT_SYS = 'You audit which' // the turn-end / Verify-all system prompt; mark_done's starts "You audit whether"
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
async function start($: Engine, on: On, tracker?: Tracker, messages: unknown[] = []) {
  const seen = {
    state: undefined as Tracker | undefined,
    store: fakeStore(on, tracker ? { [KEY]: tracker } : {}),
    submitted: [] as string[],
  }
  on('state.set', { plugin: 'plan-tracker', key: 'tracker' }, (_$, e, next) => {
    seen.state = e.value as Tracker
    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__plan-tracker__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: messages as never }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
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
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  return seen
}

/** The main turn ends answered; `agentId` or `reason` override that. */
const endTurn = ($: Engine, over: { agentId?: string; reason?: 'answer' | 'aborted' | 'error' } = {}) =>
  $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1', ...over })

const edit = ($: Engine) => $.tool.call({ tool: 'Edit', file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' })

/** A turn begins as the tracker's own work prompt (plan work) unless `text` says otherwise. */
const startTurn = ($: Engine, text = 'Work on plan item #1: item 1') => $.turn.start({ text, turnId: 't2' })

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

  test('mark_done verified by opus', async ($, on) => {
    opus(on, () => '{"verdict":"verified","reason":"Edit on a.ts seen"}')
    const seen = await start($, on, seeded([[1, 'open']]))

    const ran = await $.tool.call({ tool: MARK, id: 1, evidence: 'edited a.ts' })

    // a registered tool's result is a string or content blocks; the engine refuses an object
    expect(typeof ran.result).toBe('string')
    expect(ran.result).toContain('verified')
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('verified')
  })

  test('mark_done unverified becomes claimed', async ($, on) => {
    opus(on, () => '{"verdict":"unverified","reason":"no edit on a.ts"}')
    const seen = await start($, on, seeded([[1, 'open']]))

    const ran = await $.tool.call({ tool: MARK, id: 1, evidence: 'done' })

    expect(typeof ran.result).toBe('string')
    expect(ran.result).toContain('no edit on a.ts')
    const item = seen.state?.plans[0]?.items[0]
    expect(item?.status).toBe('claimed')
    expect(item?.note).toBe('no edit on a.ts')
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
    opus(on, e =>
      e.system?.startsWith(AUDIT_SYS)
        ? audit([[2, 'unverified', 'untouched']], 'done', 'says all done')
        : '{"verdict":"verified","reason":"Edit seen"}',
    )
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

    expect(await pane.find({ type: 'Text', text: /↻1/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /waiting on you: which DB/ })).toBeDefined()
  })

  test('every call asks opus', async ($, on) => {
    const models: string[] = []
    on('model.complete', (_$, e) => {
      models.push(e.model)
      const text = e.system?.startsWith('You extract') ? '["edit a"]'
        : e.system?.startsWith(AUDIT_SYS) ? audit([[1, 'unverified', 'x']], 'done')
        : '{"verdict":"unverified","reason":"x"}'
      return { value: { isAnswered: true as const, text, usage: USAGE } }
    })
    approved(on)
    await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })
    await $.tool.call({ tool: MARK, id: 1, evidence: 'edited a' })
    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'verify-all' })

    expect(models).toEqual(['opus', 'opus', 'opus'])
  })
  test('verifier sees the head and tail of a long tool output', async ($, on) => {
    const prompts: string[] = []
    on('model.complete', (_$, e) => {
      prompts.push(e.prompt)
      return { value: { isAnswered: true as const, text: '{"verdict":"verified","reason":"x"}', usage: USAGE } }
    })
    const out = `HEAD-MARK ${'(pass) a test\n'.repeat(200)}(fail) TAIL-MARK Received: ["haiku"]`
    const transcript = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'test' }, text: out }] }]
    await start($, on, seeded([[1, 'open']]), transcript)

    await $.tool.call({ tool: MARK, id: 1, evidence: 'ran the tests' })

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
    await pane.press({ key: 'done:1' })
    const onMain = [await edit($), await edit($), await edit($)]

    expect(inSub.flatMap(reminder)).toHaveLength(0)
    expect(onMain.flatMap(reminder)).toHaveLength(0)
  })

  test('mark_done restarts the reminder count', async ($, on) => {
    opus(on, () => '{"verdict":"verified","reason":"edit shown"}')
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
})
