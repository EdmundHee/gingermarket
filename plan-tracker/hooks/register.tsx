import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolUseSummary } from 'claude-code'

import type { PlanGroup, PlanItem, Tracker } from '../types'

const PANE = 'plan-tracker'
const DOCK_COLUMNS = 48 // width when docked beside a fullscreen transcript; inline ignores it
const MARK = 'mcp__plan-tracker__mark_done'
const EMPTY: Tracker = { nextId: 1, plans: [] }
const tracker = atom({ plugin: 'plan-tracker', key: 'tracker' } as const, EMPTY)
/** Tools whose call could finish an item; a turn with none ends without an audit. */
const WORK = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
let worked = 0 // main-loop WORK calls in the running turn
const queued = new Set<number>() // items whose work prompt waits for an idle session

// ponytail: keyed by the start cwd; follow /cd if it ever matters
let storeKey = ''

const EXTRACT =
  'You extract a checklist from an implementation plan. Return ONLY a JSON array of strings: each one concrete ' +
  'deliverable or verification step a developer ticks off, in plan order, at most 120 characters each, at most 25 ' +
  'items. Skip context, background and rejected alternatives.'
const VERIFY =
  "You audit whether a plan item was completed, from the developer's claim and the recent tool calls (file edits, " +
  'commands, outputs). Reply ONLY with JSON {"verdict":"verified"|"unverified","reason":"<at most 100 characters>"}. ' +
  '"verified" only when the tool calls show the work; a claim alone is not evidence.'
const VERIFY_ALL =
  'You audit which plan items were completed, from the recent tool calls (file edits, commands, outputs). Reply ONLY ' +
  'with a JSON array [{"id":<number>,"verdict":"verified"|"unverified","reason":"<at most 100 characters>"}], one ' +
  'entry per item given. "verified" only when the tool calls show the work; a claim alone is not evidence.'

type Verdict = { id?: number; verdict: 'verified' | 'unverified'; reason: string }

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const isVerdict = (v: unknown): v is Verdict =>
  typeof v === 'object' && v !== null && ['verified', 'unverified'].includes(String((v as Verdict).verdict))

/** One haiku call, parsed as JSON; undefined when it did not answer or answered prose. */
async function haiku($: EngineInterface, system: string, prompt: string, maxTokens = 1024): Promise<unknown> {
  const r = await $.model.complete({ model: 'haiku', system, prompt, maxTokens, effort: 'low', timeoutMs: 30000 })
  if (!r.isAnswered) return undefined
  try {
    return JSON.parse(r.text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim())
  } catch {
    return undefined
  }
}

function status(t: Tracker) {
  const items = t.plans.flatMap(p => p.items)
  return items.length ? `plan ${items.filter(i => i.status === 'verified').length}/${items.length}` : undefined
}

/** Every change goes through here: state for the pane, store for the next session, status line for the eye. */
async function save($: EngineInterface, change: (t: Tracker) => Tracker) {
  const next = await update($, tracker, change)
  await $.store.set(storeKey, next)
  $.ui.status(status(next))
  return next
}

const setItem = (t: Tracker, id: number, patch: Partial<PlanItem>): Tracker => ({
  ...t,
  plans: t.plans.map(p => ({ ...p, items: p.items.map(i => (i.id === id ? { ...i, ...patch } : i)) })),
})

function findItem(t: Tracker, id: number) {
  for (const plan of t.plans) {
    const item = plan.items.find(i => i.id === id)
    if (item) return { plan, item }
  }
  return undefined
}

/** The recent tool calls as the verifier's evidence, the tracker's own left out. */
// ponytail: transcript tool uses, not git diff; add `git diff --stat` when the verifier misses file work
async function evidence($: EngineInterface, last: number) {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return '(transcript unavailable)'
  const uses: ToolUseSummary[] = messages.flatMap(m => m.toolUses).filter(u => !u.tool.startsWith('mcp__plan-tracker__'))
  const lines = uses.slice(-last).map(u => {
    const out = (u.text ?? '').replace(/\s+/g, ' ').slice(0, 300)
    return `${u.tool} ${JSON.stringify(u.input).slice(0, 200)} → ${out}${u.isError ? ' [error]' : ''}`
  })
  return lines.join('\n').slice(-12000) || '(no tool calls yet)'
}

async function extract($: EngineInterface, planText: string) {
  const items = await haiku($, EXTRACT, planText, 2048)
  return isStrings(items) ? items.slice(0, 25).map(s => s.slice(0, 120)) : undefined
}

const newItems = (t: Tracker, texts: string[]): PlanItem[] => texts.map((text, n) => ({ id: t.nextId + n, text, status: 'open' }))

async function addPlan($: EngineInterface, planText: string, file: string) {
  const title = planText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.split('/').pop() ?? 'Plan'
  const texts = await extract($, planText)
  await save($, t => {
    const items = newItems(t, texts ?? [])
    const group: PlanGroup = { id: String(Date.now()), title, file, approvedAt: new Date().toISOString(), items }
    if (!texts) group.note = 'could not extract items; press extract again'
    return { ...t, nextId: t.nextId + items.length, plans: [group, ...t.plans] }
  })
  $.ui.toast(texts ? `tracker: ${texts.length} items from "${title}"` : `tracker: could not extract items from "${title}"`)
}

async function reextract($: EngineInterface, plan: PlanGroup) {
  await save($, t => ({ ...t, busy: 'extract' }))
  const text = await $.fs.read(plan.file).catch(() => '')
  const texts = text ? await extract($, text) : undefined
  await save($, ({ busy: _busy, ...t }) => {
    const items = newItems(t, texts ?? [])
    const plans = t.plans.map(p => {
      if (p.id !== plan.id) return p
      const { note: _note, ...rest } = p
      return texts ? { ...rest, items } : { ...rest, note: 'extraction failed again' }
    })
    return { ...t, nextId: t.nextId + items.length, plans }
  })
}

async function work($: EngineInterface, plan: PlanGroup, item: PlanItem) {
  if (queued.has(item.id)) {
    $.ui.toast(`#${item.id} already queued`)
    return
  }
  queued.add(item.id)
  const text =
    `Work on plan item #${item.id}: ${item.text}\n` +
    `Plan "${plan.title}" (${plan.file}); read it for context if needed. ` +
    `When finished, call mark_done with id ${item.id} and one line of evidence.`
  await $.prompt.submit({ text })
  $.ui.toast(`sent #${item.id}`)
}

/** Audits every non-verified item in one haiku call; never un-verifies. `quiet` toasts only when something new is verified. */
async function verifyAll($: EngineInterface, quiet = false) {
  const before = await save($, t => ({ ...t, busy: 'verify' }))
  const pending = before.plans.flatMap(p => p.items.filter(i => i.status !== 'verified'))
  const list = pending.map(i => `#${i.id}: ${i.text}${i.status === 'claimed' ? ' (developer claims done)' : ''}`).join('\n')
  const answer = await haiku($, VERIFY_ALL, `Items:\n${list}\n\nRecent tool calls:\n${await evidence($, 80)}`, 2048)
  const verdicts = Array.isArray(answer) ? answer.filter(isVerdict) : []
  const after = await save($, ({ busy: _busy, ...t }) => {
    let next: Tracker = t
    for (const v of verdicts) {
      const found = findItem(next, Number(v.id))
      if (!found || found.item.status === 'verified') continue
      next = setItem(next, found.item.id, v.verdict === 'verified' ? { status: 'verified', note: v.reason } : { note: v.reason })
    }
    return next
  })
  const newly = verdicts.filter(v => v.verdict === 'verified' && pending.some(i => i.id === Number(v.id))).map(v => `#${v.id}`)
  if (quiet) {
    if (newly.length) $.ui.toast(`tracker: ✓ ${newly.join(' ')} · ${status(after) ?? ''}`)
    return
  }
  $.ui.toast(verdicts.length ? `verified ${newly.length} of ${pending.length}` : 'verifier unavailable')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    storeKey = `tracker:${e.cwd}`
    const { busy: _busy, ...stored } = ((await $.store.get(storeKey)) as Tracker | undefined) ?? EMPTY
    await update($, tracker, () => stored)
    $.ui.status(status(stored))
    await $.tool.register({
      name: 'mark_done',
      description:
        'Mark a plan-tracker item finished: its id from the open-items list and one line of evidence (what you ' +
        'edited, ran or saw). A small model checks the claim against the recent tool calls.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'the item id, as #<id> in the list' },
          evidence: { type: 'string', description: 'one line: what was done and how you know' },
        },
        required: ['id', 'evidence'],
      },
    })
    await $.command.register({ name: 'plan-tracker', description: 'Open the plan tracker pane', argumentHint: '[reset]' })
    void $.ui.open({ id: PANE, title: 'Plan', columns: DOCK_COLUMNS })
    return next(e)
  })

  // The engine puts a plugin's tool behind ToolSearch; in front, Claude can mark without loading it first.
  on('tool.describe', { tool: MARK }, (_$, e) => ({ description: e.description, isDeferred: false }))

  on('turn.start', ($, e, next) => {
    worked = 0
    const m = /^Work on plan item #(\d+):/.exec(e.text)
    if (m) queued.delete(Number(m[1]))
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined && WORK.has(e.tool)) worked += 1
    return next(e)
  })

  // ponytail: awaited, not fire-and-forget; work left running after a hook returns may be dropped with its dispatch
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || worked === 0) return r
    const t = await read($, tracker)
    if (t.busy || !t.plans.some(p => p.items.some(i => i.status !== 'verified'))) return r
    await verifyAll($, true)
    return r
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    // smoke-check only, removed once the rejection shape is confirmed as isError
    $.ui.log(`plan-tracker: ExitPlanMode ${ran.isError ? 'isError' : 'ok'} ${JSON.stringify(ran.result ?? null).slice(0, 160)}`, { to: 'debug' })
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran
    try {
      const result = ran.result as { plan?: string | null; filePath?: string } | undefined
      const file = result?.filePath ?? ''
      const text = result?.plan ?? (file ? await $.fs.read(file) : '')
      if (text) await addPlan($, text, file)
    } catch (err) {
      $.ui.log(`plan-tracker: ${String(err)}`, { to: 'debug' })
    }
    return ran
  })

  on('tool.call', { tool: MARK }, async ($, e) => {
    const id = Number(e.id)
    const found = findItem(await read($, tracker), id)
    // a registered tool answers as an MCP tool does: a string or content blocks, never an object
    if (!found) return { result: `No plan item #${id}.` }
    const prompt = `Item #${id}: ${found.item.text}\nDeveloper's claim: ${String(e.evidence ?? '')}\n\nRecent tool calls:\n${await evidence($, 40)}`
    const verdict = await haiku($, VERIFY, prompt)
    const checked = isVerdict(verdict)
    const status = checked && verdict.verdict === 'verified' ? 'verified' : 'claimed'
    const reason = checked ? verdict.reason : 'verifier unavailable'
    await save($, t => setItem(t, id, { status, note: reason }))
    const message =
      status === 'verified'
        ? `Item #${id} verified.`
        : `Item #${id} marked but NOT verified: ${reason}. Finish it, then mark again with better evidence.`
    return { result: message }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(e.tools ?? []).includes(MARK)) return r
    const t = await read($, tracker)
    const open = t.plans.flatMap(p => p.items.filter(i => i.status !== 'verified'))
    if (open.length === 0) return r
    const lines = open
      .slice(0, 30)
      .map(i => (i.status === 'claimed' ? `#${i.id} [claimed, unverified: ${i.note ?? ''}] ${i.text}` : `#${i.id} [open] ${i.text}`))
    const text = [
      '# Plan tracker',
      'Items from approved plans still open in this project:',
      ...lines,
      'Call mark_done right after you finish each item, before starting the next, with its id and one line of evidence. Never mark what you have not done.',
    ].join('\n')
    return { sections: [...r.sections, { id: 'plan-tracker:open', text, scope: 'session' }] }
  })

  on('command.run', { command: 'plan-tracker' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      const answer = await $.ui.ask('Wipe the plan tracker for this project?', ['Wipe', 'Keep']).catch(() => 'Keep')
      if (answer !== 'Wipe') return { text: 'Kept.' }
      await save($, () => EMPTY)
      return { text: 'Plan tracker wiped.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Plan', columns: DOCK_COLUMNS })
    return { text: opened.isPlaced ? 'Plan tracker pane opened.' : `Plan tracker pane waits: ${opened.reason}` }
  })

  let seatLogged = false
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!seatLogged) {
      // smoke-check only: where the surface seated the pane
      seatLogged = true
      $.ui.log(`plan-tracker: placement=${e.props.placement} fullscreen=${String(e.viewport?.isFullscreen)} columns=${String(e.viewport?.columns)} body=${e.props.bodyColumns}`)
    }
    const t = await read($, tracker)
    if (t.plans.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No approved plan yet. Approve one in plan mode.</Text>
        </Box>
      )
    }
    const glyph = { open: '○', claimed: '⚠', verified: '✓' } as const
    const color = { open: 'text', claimed: 'warning', verified: 'success' } as const
    const pending = t.plans.flatMap(p => p.items).some(i => i.status !== 'verified')

    const row = (plan: PlanGroup, item: PlanItem) => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Text color={color[item.status]} wrap="truncate">{`${glyph[item.status]} #${item.id} ${item.text}`}</Text>
          </Box>
          {item.status !== 'verified' && (
            <Button key={`work:${item.id}`} plain onPress={() => work($, plan, item)}>▶</Button>
          )}
          {item.status !== 'verified' && (
            <Button key={`done:${item.id}`} plain onPress={() => save($, s => setItem(s, item.id, { status: 'verified', note: 'by you' }))}>✓</Button>
          )}
        </Box>
        {item.status === 'claimed' && item.note !== undefined && (
          <Text dimColor wrap="truncate">{`     ${item.note}`}</Text>
        )}
      </Box>
    )

    const group = (plan: PlanGroup) => {
      const done = plan.items.length > 0 && plan.items.every(i => i.status === 'verified')
      const count = `${plan.items.filter(i => i.status === 'verified').length}/${plan.items.length}`
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text bold={!done} dimColor={done} wrap="truncate">{`${done ? '✓ ' : ''}${plan.title}`}</Text>
            </Box>
            <Text dimColor>{count}</Text>
            <Button key={`remove:${plan.id}`} plain dimColor onPress={() => save($, s => ({ ...s, plans: s.plans.filter(p => p.id !== plan.id) }))}>x</Button>
          </Box>
          {!done && plan.items.map(item => row(plan, item))}
          {plan.items.length === 0 && plan.note !== undefined && <Text dimColor>{plan.note}</Text>}
          {plan.items.length === 0 && (
            <Button key="extract-again" onPress={() => reextract($, plan)}>{t.busy === 'extract' ? 'extracting…' : 'extract again'}</Button>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {t.plans.map(group)}
        {pending && (
          <Button key="verify-all" variant="primary" onPress={() => verifyAll($)}>{t.busy === 'verify' ? 'verifying…' : 'Verify all'}</Button>
        )}
      </Box>
    )
  })
}
