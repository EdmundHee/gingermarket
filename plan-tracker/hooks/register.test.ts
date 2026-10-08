import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Tracker } from '../types'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PLAN = '# Fix the thing\n\n## Context\nwhy\n\n## Change\n1. edit a\n2. test b\n'
const MARK = 'mcp__plan-tracker__mark_done'
const PANE = {
  title: 'Plan', isFocused: false, bodyColumns: 80, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

const seeded = (items: Array<[number, Tracker['plans'][0]['items'][0]['status'], string?]>): Tracker => ({
  nextId: items.length + 1,
  plans: [{
    id: 'p1', title: 'Seeded', file: '/tmp/seeded.md', approvedAt: '2026-10-08T00:00:00.000Z',
    items: items.map(([id, status, note]) => ({ id, text: `item ${id}`, status, ...(note ? { note } : {}) })),
  }],
})

/** Fakes haiku: every `$.model.complete` beneath the plugin answers `reply(e)`. Returns the call count. */
function haiku(on: On, reply: (e: { system?: string; prompt: string }) => string) {
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
async function start($: Engine, on: On, tracker?: Tracker) {
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
  on('session.messages', () => ({ value: [] }))
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

describe('plan-tracker', () => {
  test('approval adds a group with haiku\'s items', async ($, on) => {
    haiku(on, () => '["edit a", "test b"]')
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
    const calls = haiku(on, () => '["never"]')
    on('tool.call', { tool: 'ExitPlanMode' }, () => ({ isError: true as const, result: 'rejected', text: 'The user rejected the plan.' }))
    const seen = await start($, on)

    await $.tool.call({ tool: 'ExitPlanMode' })

    expect(seen.state?.plans ?? []).toHaveLength(0)
    expect(seen.store.has(KEY)).toBe(false)
    expect(calls.n).toBe(0)
  })

  test('mark_done verified by haiku', async ($, on) => {
    haiku(on, () => '{"verdict":"verified","reason":"Edit on a.ts seen"}')
    const seen = await start($, on, seeded([[1, 'open']]))

    const ran = await $.tool.call({ tool: MARK, id: 1, evidence: 'edited a.ts' })

    expect((ran.result as { message: string }).message).toContain('verified')
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('verified')
  })

  test('mark_done unverified becomes claimed', async ($, on) => {
    haiku(on, () => '{"verdict":"unverified","reason":"no edit on a.ts"}')
    const seen = await start($, on, seeded([[1, 'open']]))

    const ran = await $.tool.call({ tool: MARK, id: 1, evidence: 'done' })

    expect((ran.result as { message: string }).message).toContain('no edit on a.ts')
    const item = seen.state?.plans[0]?.items[0]
    expect(item?.status).toBe('claimed')
    expect(item?.note).toBe('no edit on a.ts')
  })

  test('compose lists open and claimed items', async ($, on) => {
    await start($, on, seeded([[1, 'open'], [2, 'claimed', 'no test run'], [3, 'verified']]))

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
    haiku(on, () => '[{"id":1,"verdict":"verified","reason":"ok"},{"id":2,"verdict":"unverified","reason":"still no test"}]')
    const seen = await start($, on, seeded([[1, 'open'], [2, 'claimed', 'no test run'], [3, 'verified']]))

    const pane = await $.ui.mount({ plugin: 'plan-tracker', surface: 'terminal', component: 'Pane', requestId: 'plan-tracker', props: PANE })
    await pane.press({ key: 'verify-all' })

    const items = seen.state?.plans[0]?.items ?? []
    expect(items.map(i => i.status)).toEqual(['verified', 'claimed', 'verified'])
    expect(items[1]?.note).toBe('still no test')
  })

  test('turn end audits open items after an edit', async ($, on) => {
    const calls = haiku(on, () => '[{"id":1,"verdict":"verified","reason":"edit seen"}]')
    const seen = await start($, on, seeded([[1, 'open']]))

    await edit($)
    await endTurn($)

    expect(calls.n).toBe(1)
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('verified')
    expect(seen.store.get(KEY)).toEqual(seen.state)
  })

  test('turn end without work calls no haiku', async ($, on) => {
    const calls = haiku(on, () => '[{"id":1,"verdict":"verified","reason":"x"}]')
    const seen = await start($, on, seeded([[1, 'open']]))

    await $.tool.call({ tool: 'Read', file_path: '/tmp/a.ts' })
    await endTurn($)

    expect(calls.n).toBe(0)
    expect(seen.state?.plans[0]?.items[0]?.status).toBe('open')
  })

  test('turn end with everything verified calls no haiku', async ($, on) => {
    const calls = haiku(on, () => '[]')
    await start($, on, seeded([[1, 'verified']]))

    await edit($)
    await endTurn($)

    expect(calls.n).toBe(0)
  })

  test('subagent and aborted turns call no haiku', async ($, on) => {
    const calls = haiku(on, () => '[{"id":1,"verdict":"verified","reason":"x"}]')
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
    haiku(on, () => '["x"]')
    approved(on, '# Second plan\n\n1. x\n')
    const seen = await start($, on, seeded([[1, 'open']]))

    await $.tool.call({ tool: 'ExitPlanMode' })

    const t = seen.state
    expect(t?.plans.map(p => p.title)).toEqual(['Second plan', 'Seeded'])
    expect(t?.plans[0]?.items[0]?.id).toBe(2)
    expect(t?.plans[1]?.items[0]?.status).toBe('open')
  })

  test('failed extraction leaves a retry', async ($, on) => {
    haiku(on, () => 'Sorry, I cannot help with that.')
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
})
