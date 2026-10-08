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
const NUDGES = 2 // auto-nudges per item before the pane asks for you
const WORK_PROMPT = /^Work on plan items? ((?:#\d+ ?)+):/
let worked = 0 // main-loop WORK calls in the running turn
let planTurn = false // this main turn was plan work: approval, a tracker prompt, or a mark_done
let activePlan: string | undefined // group the nudge targets; falls back to the newest
const queued = new Set<number>() // items whose work prompt waits for an idle session

// ponytail: keyed by the start cwd; follow /cd if it ever matters
let storeKey = ''

const EXTRACT =
  'You extract a checklist from an implementation plan. Return ONLY a JSON array of strings: each one concrete ' +
  'deliverable or verification step a developer ticks off, in plan order, at most 120 characters each. ' +
  'Skip context, background and rejected alternatives.'
const VERIFY =
  "You audit whether a plan item was completed, from the developer's claim and the recent tool calls (file edits, " +
  'commands, outputs). Reply ONLY with JSON {"verdict":"verified"|"unverified","reason":"<at most 100 characters>"}. ' +
  '"verified" only when the tool calls show the work; a claim alone is not evidence.'
const AUDIT =
  'You audit which plan items were completed, from the recent tool calls (file edits, commands, outputs) and the ' +
  "developer's final reply. Reply ONLY with JSON " +
  '{"items":[{"id":<number>,"verdict":"verified"|"unverified","reason":"<at most 100 characters>"}],' +
  '"reply":"done"|"partial"|"blocked","why":"<at most 100 characters>"}, one items entry per item given. ' +
  '"verified" only when the tool calls show the work; a claim alone is not evidence. ' +
  '"reply": "blocked" when the developer asked the user a question, needs a decision, or hit an error they could not fix; ' +
  '"partial" when they stopped with work left or offered to continue; "done" when they say everything is finished.'

type Verdict = { id?: number; verdict: 'verified' | 'unverified'; reason: string }
type Audit = { items: Verdict[]; reply?: 'done' | 'partial' | 'blocked'; why?: string }

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const isVerdict = (v: unknown): v is Verdict =>
  typeof v === 'object' && v !== null && ['verified', 'unverified'].includes(String((v as Verdict).verdict))
const isAudit = (v: unknown): v is Audit => typeof v === 'object' && v !== null && Array.isArray((v as Audit).items)

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

// ponytail: no item cap; 4096 tokens is room for ~100 items, the pane scrolls (engine-owned) past bodyRows
async function extract($: EngineInterface, planText: string) {
  const items = await haiku($, EXTRACT, planText, 4096)
  return isStrings(items) ? items.map(s => s.slice(0, 120)) : undefined
}

const newItems = (t: Tracker, texts: string[]): PlanItem[] => texts.map((text, n) => ({ id: t.nextId + n, text, status: 'open' }))

/** Adds the approved plan as a new group on top; returns its id. */
async function addPlan($: EngineInterface, planText: string, file: string) {
  const title = planText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.split('/').pop() ?? 'Plan'
  const texts = await extract($, planText)
  const id = String(Date.now())
  await save($, t => {
    const items = newItems(t, texts ?? [])
    const group: PlanGroup = { id, title, file, approvedAt: new Date().toISOString(), items }
    if (!texts) group.note = 'could not extract items; press extract again'
    return { ...t, nextId: t.nextId + items.length, plans: [group, ...t.plans] }
  })
  $.ui.toast(texts ? `tracker: ${texts.length} items from "${title}"` : `tracker: could not extract items from "${title}"`)
  return id
}

const setGroupNote = (t: Tracker, planId: string, note: string | undefined): Tracker => ({
  ...t,
  plans: t.plans.map(p => {
    if (p.id !== planId) return p
    const { note: _old, ...rest } = p
    return note === undefined ? rest : { ...rest, note }
  }),
})

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

/** Queues one prompt sending Claude to the given items of `plan`; those already queued are left out. */
async function work($: EngineInterface, plan: PlanGroup, items: PlanItem[], why?: string) {
  const fresh = items.filter(i => !queued.has(i.id))
  if (fresh.length === 0) {
    $.ui.toast(`${items.map(i => `#${i.id}`).join(' ')} already queued`)
    return
  }
  fresh.forEach(i => queued.add(i.id))
  const ids = fresh.map(i => `#${i.id}`).join(' ')
  const rows = fresh.map(i => `#${i.id} ${i.text}${i.note ? ` (audit: ${i.note})` : ''}`).join('\n')
  const text =
    `Work on plan item${fresh.length > 1 ? 's' : ''} ${ids}:\n${rows}\n` +
    `Plan "${plan.title}" (${plan.file}); read it for context if needed.` +
    (why ? ` Your last reply read as: ${why}.` : '') +
    ' Finish each item, then call mark_done with its id and one line of evidence. If one is impossible or already done, say which and why.'
  await $.prompt.submit({ text })
  $.ui.toast(`sent ${ids}`)
}

/**
 * Audits every non-verified item in one haiku call, reading the tool calls and (when given) Claude's final reply;
 * never un-verifies. `quiet` toasts only when something new is verified. Returns what haiku said, or undefined.
 */
async function verifyAll($: EngineInterface, opts: { quiet?: boolean; reply?: string } = {}): Promise<Audit | undefined> {
  const before = await save($, t => ({ ...t, busy: 'verify' }))
  const pending = before.plans.flatMap(p => p.items.filter(i => i.status !== 'verified'))
  const list = pending.map(i => `#${i.id}: ${i.text}${i.status === 'claimed' ? ' (developer claims done)' : ''}`).join('\n')
  const prompt =
    `Items:\n${list}\n\nRecent tool calls:\n${await evidence($, 80)}\n\n` +
    `Developer's final reply:\n${(opts.reply || '(none)').slice(0, 4000)}`
  const answer = await haiku($, AUDIT, prompt, 4096)
  const audit = isAudit(answer) ? answer : undefined
  const verdicts = audit?.items.filter(isVerdict) ?? []
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
  if (opts.quiet) {
    if (newly.length) $.ui.toast(`tracker: ✓ ${newly.join(' ')} · ${status(after) ?? ''}`)
  } else {
    $.ui.toast(verdicts.length ? `verified ${newly.length} of ${pending.length}` : 'verifier unavailable')
  }
  return audit
}

/** After a plan turn's audit: sends the active plan's leftovers back as one prompt, or notes why not. */
async function nudge($: EngineInterface, audit: Audit | undefined) {
  const t = await read($, tracker)
  const plan = t.plans.find(p => p.id === activePlan) ?? t.plans[0]
  if (!plan) return
  const left = plan.items.filter(i => i.status !== 'verified')
  if (left.length === 0 || !audit) return // done, or verifier unavailable: never nudge blind
  const note = async (text: string) => {
    await save($, s => setGroupNote(s, plan.id, text))
    $.ui.toast(`tracker: ${text}`)
  }
  if (audit.reply === 'blocked') return note(`waiting on you: ${audit.why ?? 'Claude asked a question'}`)
  const able = left.filter(i => (i.nudges ?? 0) < NUDGES)
  if (able.length === 0) return note(`${left.map(i => `#${i.id}`).join(' ')} need you (auto-nudge limit); press ▶ or ✓`)
  await save($, s => able.reduce((next, i) => setItem(next, i.id, { nudges: (i.nudges ?? 0) + 1 }), setGroupNote(s, plan.id, undefined)))
  await work($, plan, able, audit.why)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    storeKey = `tracker:${e.cwd}`
    planTurn = false
    activePlan = undefined
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

  on('turn.start', async ($, e, next) => {
    worked = 0
    planTurn = false
    const ids = (WORK_PROMPT.exec(e.text)?.[1]?.match(/\d+/g) ?? []).map(Number)
    if (ids.length) {
      planTurn = true
      ids.forEach(id => queued.delete(id))
      activePlan = findItem(await read($, tracker), ids[0] ?? -1)?.plan.id ?? activePlan
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined && WORK.has(e.tool)) worked += 1
    return next(e)
  })

  // ponytail: awaited, not fire-and-forget; work left running after a hook returns may be dropped with its dispatch
  // A plan turn audits even without file work: Claude approving then stopping ("I'll start with…") is the hanging case.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || (worked === 0 && !planTurn)) return r
    const t = await read($, tracker)
    if (t.busy || !t.plans.some(p => p.items.some(i => i.status !== 'verified'))) return r
    const audit = await verifyAll($, { quiet: true, reply: e.answer })
    if (planTurn) await nudge($, audit)
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
      if (text) {
        activePlan = await addPlan($, text, file)
        planTurn = true
      }
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
    if (e.agentId === undefined) {
      planTurn = true
      activePlan = found.plan.id
    }
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
    const lines = open.map(i =>
      i.status === 'claimed' ? `#${i.id} [claimed, unverified: ${i.note ?? ''}] ${i.text}` : `#${i.id} [open] ${i.text}`,
    )
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
            <Text color={color[item.status]} wrap="truncate">{`${glyph[item.status]} #${item.id}${item.nudges ? ` ↻${item.nudges}` : ''} ${item.text}`}</Text>
          </Box>
          {item.status !== 'verified' && (
            <Button key={`work:${item.id}`} plain onPress={() => work($, plan, [item])}>▶</Button>
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
          {!done && plan.note !== undefined && <Text dimColor wrap="truncate">{plan.note}</Text>}
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
          <Button key="verify-all" variant="primary" onPress={() => void verifyAll($)}>{t.busy === 'verify' ? 'verifying…' : 'Verify all'}</Button>
        )}
      </Box>
    )
  })
}
