import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolUseSummary } from 'claude-code'

import type { PlanGroup, PlanItem, Timing, Tracker } from '../types'

const PANE = 'plan-tracker'
const DOCK_COLUMNS = 48 // width when docked beside a fullscreen transcript; inline ignores it
const MARK = 'mcp__plan-tracker__mark_done'
const EMPTY: Tracker = { nextId: 1, plans: [] }
const tracker = atom({ plugin: 'plan-tracker', key: 'tracker' } as const, EMPTY)
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tools whose call could finish an item; a turn with none ends without an audit. Agent: subagent-driven runs. */
const WORK = new Set([...EDITS, 'Bash', 'Agent'])
/** Skills that run a superpowers plan doc; their start is the doc's approval. */
const EXECUTE = /(^|:)(executing-plans|subagent-driven-development)$/
const DOCS = 'docs/superpowers/plans'
const PLAN_DOC = /\/docs\/superpowers\/plans\/[^/]+\.md$/
/** The pane's sections, in order; a group's source follows from its file. */
const SOURCES = [['docs', 'PLAN DOCS'], ['mode', 'PLAN MODE'], ['tasks', 'TASKS']] as const
const sourceOf = (p: PlanGroup) => (p.file === '' ? 'tasks' : PLAN_DOC.test(p.file) ? 'docs' : 'mode')
const NUDGES = 2 // auto-nudges per item before the pane asks for you
const WORK_PROMPT = /^Work on plan items? ((?:#\d+ ?)+):/
let worked = 0 // main-loop WORK calls in the running turn
const REMIND_EVERY = 3 // ponytail: one reminder per 3 work calls; drop to 1 if marks still arrive late
let sinceMark = 0 // main-loop WORK calls since the last mark_done or reminder
let planTurn = false // this main turn was plan work: approval, a tracker prompt, or a mark_done
let activePlan: string | undefined // group the nudge targets; falls back to the newest
const queued = new Set<number>() // items whose work prompt waits for an idle session

// ponytail: keyed by the start cwd; follow /cd if it ever matters
let storeKey = ''
let cwd = ''
let prompt = '' // the typed text of the running turn, until its first repo edit tracks it
let lastDoc: string | undefined // the plan doc last written this session
let ticking: { cancel: () => void } | undefined // redraws the timing card each second while a run is live

const EXTRACT =
  "You extract a checklist from an implementation plan or a developer's task request. Return ONLY a JSON array of " +
  'strings: each one concrete deliverable or verification step a developer ticks off, in order, at most 120 ' +
  'characters each. Skip context, background and rejected alternatives. Return [] when it asks for no new change.'
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

/** One model call, parsed as JSON; undefined when it did not answer or answered prose. */
async function ask($: EngineInterface, model: 'opus' | 'sonnet', system: string, prompt: string, maxTokens = 1024): Promise<unknown> {
  const r = await $.model.complete({ model, system, prompt, maxTokens, effort: 'low', timeoutMs: 60000 })
  if (!r.isAnswered) return undefined
  try {
    return JSON.parse(r.text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim())
  } catch {
    return undefined
  }
}

const openItems = (t: Tracker) => t.plans.flatMap(p => p.items.filter(i => i.status !== 'verified'))
/** Marked this turn, not yet audited: nothing more for Claude to do on it. */
const isPending = (i: PlanItem) => i.status === 'claimed' && i.note === undefined

// ponytail: 32-bit string hash, enough to spot the same plan text approved twice
const hashOf = (s: string) => String([...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 0))

function status(t: Tracker) {
  const items = t.plans.flatMap(p => p.items)
  return items.length ? `plan ${items.filter(i => i.status === 'verified').length}/${items.length}` : undefined
}

/** Every change goes through here: state for the pane, store for the next session, status line for the eye. */
async function save($: EngineInterface, change: (t: Tracker) => Tracker) {
  const next = await update($, tracker, change)
  await $.store.set(storeKey, next)
  $.ui.status(status(next))
  tick($, next)
  return next
}

const timedGroup = (t: Tracker) => t.plans.find(p => p.id === t.timing?.plan)

/** A run is live until its last item is verified; one whose group was removed has nothing left to time. */
const isLive = (t: Tracker) =>
  t.timing !== undefined && t.timing.endedAt === undefined && (t.timing.planAt === undefined || timedGroup(t) !== undefined)

/** Keeps one 1 s redraw going while a run is live, none otherwise. */
function tick($: EngineInterface, t: Tracker) {
  if (isLive(t)) ticking ??= $.clock.every(1000, () => $.ui.invalidate('ui.render'))
  else {
    ticking?.cancel()
    ticking = undefined
  }
}

/** `patch` on item `id`, stamped with the time it was first marked or verified. */
const finish = (t: Tracker, id: number, now: number, patch: Partial<PlanItem>): Tracker =>
  setItem(t, id, { ...patch, doneAt: findItem(t, id)?.item.doneAt ?? now })

/** Ends the run once every item of its group is verified. */
function ended(t: Tracker, now: number): Tracker {
  const items = timedGroup(t)?.items ?? []
  if (!t.timing || t.timing.endedAt !== undefined || items.length === 0 || items.some(i => i.status !== 'verified')) return t
  return { ...t, timing: { ...t.timing, endedAt: now } }
}

/** `45s`, `3m 05s`, `1h 02m`; never negative. */
function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  return s < 3600 ? `${Math.floor(s / 60)}m ${two(s % 60)}s` : `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`
}

/** The timing card's rows as [key, label, time, isRunning]: Planning, the timed group's items, Total. */
function timeRows(t: Tracker, timing: Timing, now: number): Array<[string, string, string, boolean]> {
  const items = timedGroup(t)?.items ?? []
  const approved = timing.planAt !== undefined
  const marks = [timing.planAt ?? timing.startedAt, ...items.flatMap(i => (i.doneAt === undefined ? [] : [i.doneAt]))]
  const last = Math.max(...marks)
  const next = items.find(i => i.doneAt === undefined && i.status !== 'verified') // ponytail: list order; out-of-order work shows its running time on this row until marked
  const glyph = { open: '○', claimed: '⚠', verified: '✓' } as const
  const end = timing.endedAt ?? (approved && items.length === 0 && !timedGroup(t) ? timing.planAt ?? now : now)
  return [
    ['planning', 'Planning', fmt((timing.planAt ?? now) - timing.startedAt), !approved],
    ...items.map((i): [string, string, string, boolean] => {
      const label = `${glyph[i.status]} #${i.id} ${i.text}`
      if (i.doneAt !== undefined) return [`item:${i.id}`, label, fmt(i.doneAt - Math.max(...marks.filter(m => m < (i.doneAt ?? 0)), timing.planAt ?? timing.startedAt)), false]
      return i === next ? [`item:${i.id}`, label, fmt(now - last), true] : [`item:${i.id}`, label, '–', false]
    }),
    ['total', 'Total', fmt(end - timing.startedAt), isLive(t)],
  ]
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

/** Head and tail of a long output: commands echo at the start, failures and summaries land at the end. */
const clip = (s: string, head = 200, tail = 600) => (s.length > head + tail ? `${s.slice(0, head)} … ${s.slice(-tail)}` : s)

/** The recent tool calls as the verifier's evidence, the tracker's own left out. */
// ponytail: transcript tool uses, not git diff; add `git diff --stat` when the verifier misses file work
// ponytail: 800 chars per output, 24000 in all (oldest dropped); a failure mid-way through a huge log is still cut
async function evidence($: EngineInterface, last: number) {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return '(transcript unavailable)'
  const uses: ToolUseSummary[] = messages.flatMap(m => m.toolUses).filter(u => !u.tool.startsWith('mcp__plan-tracker__'))
  const lines = uses.slice(-last).map(u => {
    const out = clip((u.text ?? '').replace(/\s+/g, ' '))
    return `${u.tool} ${JSON.stringify(u.input).slice(0, 200)} → ${out}${u.isError ? ' [error]' : ''}`
  })
  return lines.join('\n').slice(-24000) || '(no tool calls yet)'
}

// ponytail: no item cap; 4096 tokens is room for ~100 items, the pane scrolls (engine-owned) past bodyRows
async function extract($: EngineInterface, planText: string) {
  const items = await ask($, 'opus', EXTRACT, planText, 4096)
  return isStrings(items) ? items.map(s => s.slice(0, 120)) : undefined
}

/** A superpowers plan's `### Task N: name` headings, one item each; any other text goes to opus. */
async function itemsOf($: EngineInterface, text: string) {
  const tasks = [...text.matchAll(/^###\s+(Task\s+\d+:.+)$/gm)].map(m => (m[1] ?? '').trim().slice(0, 120))
  return tasks.length ? tasks : extract($, text)
}

const newItems = (t: Tracker, texts: string[]): PlanItem[] => texts.map((text, n) => ({ id: t.nextId + n, text, status: 'open' }))

/**
 * Adds a plan (or, with no `file`, a typed task) as a new group on top; returns its id. `extra` goes to the
 * extractor only. A task with nothing to track adds no group and returns undefined.
 */
async function addPlan(
  $: EngineInterface,
  planText: string,
  file: string,
  title = planText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.split('/').pop() ?? 'Plan',
  extra = '',
) {
  const hash = hashOf(planText)
  // the same text approved again (re-shown after /compact) keeps its group, so Claude's ids stay valid
  const same = (await read($, tracker)).plans.find(p => p.hash === hash && p.items.length > 0)
  if (same) {
    $.ui.toast(`tracker: "${title}" already tracked`)
    return same.id
  }
  const texts = await itemsOf($, planText + extra)
  if (!file && !texts?.length) return undefined // no file to extract again from
  const id = String(Date.now())
  await save($, t => {
    const items = newItems(t, texts ?? [])
    const group: PlanGroup = { id, title, file, hash, approvedAt: new Date().toISOString(), items }
    if (!texts) group.note = 'could not extract items; press extract again'
    const plans = t.plans.filter(p => !(p.hash === hash && p.items.length === 0)) // a failed copy of this plan
    return { ...t, nextId: t.nextId + items.length, plans: [group, ...plans] }
  })
  $.ui.toast(texts ? `tracker: ${texts.length} items from "${title}"` : `tracker: could not extract items from "${title}"`)
  return id
}

/** Tracks the running turn's typed task as its own group, told what is already tracked so it adds only new work. */
async function trackPrompt($: EngineInterface) {
  const text = prompt
  prompt = ''
  const open = openItems(await read($, tracker)).map(i => `#${i.id} ${i.text}`)
  const extra = open.length ? `\n\nAlready tracked, leave these out:\n${open.join('\n')}` : ''
  // ponytail: one opus call (~5-15 s) holds this edit's result; move it to turn.complete if that delay bites
  const id = await addPlan($, text, '', text.trim().split('\n')[0]?.slice(0, 60), extra)
  if (id) {
    activePlan = id
    planTurn = true
  }
}

/** The newest `.md` in the superpowers plans folder, for an execution skill started without a path. */
async function newestDoc($: EngineInterface) {
  const entries = await $.fs.list(`${cwd}/${DOCS}`).catch(() => [])
  const newest = entries.filter(f => f.kind === 'file' && f.name.endsWith('.md')).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest && `${cwd}/${DOCS}/${newest.name}`
}

const setGroupNote =(t: Tracker, planId: string, note: string | undefined): Tracker => ({
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
  const texts = text ? await itemsOf($, text) : undefined
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

/** The `✓` button: verified by the user. */
async function byHand($: EngineInterface, id: number) {
  const now = await $.clock.now()
  await save($, t => ended(finish(t, id, now, { status: 'verified', note: 'by you' }), now))
}

/** The plan's approval ends Planning; with no plan-mode prompt seen, the run starts here. */
async function planned($: EngineInterface, plan: string | undefined) {
  if (!plan) return
  const now = await $.clock.now()
  await save($, t => (t.timing && t.timing.planAt === undefined ? { ...t, timing: { ...t.timing, planAt: now, plan } } : t.timing ? t : { ...t, timing: { startedAt: now, planAt: now, plan } }))
}

/** A session's start, or a /clear (no session.start, $.state back to EMPTY): turn state reset, store loaded. */
async function load($: EngineInterface) {
  planTurn = false
  activePlan = undefined
  prompt = ''
  lastDoc = undefined
  queued.clear() // ponytail: a prompt pulled back with Up keeps its ids queued until then; no event frees them sooner
  const { busy: _busy, ...stored } = ((await $.store.get(storeKey)) as Tracker | undefined) ?? EMPTY
  await update($, tracker, () => stored)
  $.ui.status(status(stored))
  ticking?.cancel() // a /clear drops the old session's timer
  ticking = undefined
  tick($, stored)
  void $.ui.open({ id: PANE, title: 'Plan', columns: DOCK_COLUMNS })
}

/**
 * Audits every non-verified item in one sonnet call, reading the tool calls, each mark_done claim and (when given)
 * Claude's final reply; the only check there is, a mark_done alone verifies nothing. Never un-verifies. `quiet` toasts only when something new is verified. Returns what sonnet said, or undefined.
 */
async function verifyAll($: EngineInterface, opts: { quiet?: boolean; reply?: string } = {}): Promise<Audit | undefined> {
  const before = await save($, t => ({ ...t, busy: 'verify' }))
  const pending = openItems(before)
  const list = pending.map(i => `#${i.id}: ${i.text}${i.status === 'claimed' ? ` (developer claims done: ${i.claim ?? ''})` : ''}`).join('\n')
  const prompt =
    `Items:\n${list}\n\nRecent tool calls:\n${await evidence($, 80)}\n\n` +
    `Developer's final reply:\n${(opts.reply || '(none)').slice(0, 4000)}`
  const answer = await ask($, 'sonnet', AUDIT, prompt, 4096)
  const audit = isAudit(answer) ? answer : undefined
  const verdicts = audit?.items.filter(isVerdict) ?? []
  const now = await $.clock.now()
  const after = await save($, ({ busy: _busy, ...t }) => {
    let next: Tracker = t
    for (const v of verdicts) {
      const found = findItem(next, Number(v.id))
      if (!found || found.item.status === 'verified') continue
      next = v.verdict === 'verified' ? finish(next, found.item.id, now, { status: 'verified', note: v.reason }) : setItem(next, found.item.id, { note: v.reason })
    }
    return ended(next, now)
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
    cwd = e.cwd
    storeKey = `tracker:${cwd}`
    await load($)
    await $.tool.register({
      name: 'mark_done',
      description:
        'Mark a plan-tracker item finished: its id from the open-items list and one line of evidence (what you ' +
        'edited, ran or saw). The claim is checked against your tool calls when the turn ends.',
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
    return next(e)
  })

  // /clear starts a new session id with no session.start; unloaded, the next save would write EMPTY over the store
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await load($)
    return next(e)
  })

  // No event marks the plan-mode toggle itself; the first prompt sent in plan mode is the earliest sign of it.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const t = await read($, tracker)
    if (e.permission_mode === 'plan' && (!t.timing || t.timing.planAt !== undefined)) {
      const startedAt = await $.clock.now()
      await save($, s => ({ ...s, timing: { startedAt } }))
      // focus is a request: the engine gives the keys only over an empty composer, with no dialog up
      void $.ui.open({ id: PANE, title: 'Plan', columns: DOCK_COLUMNS, focus: true })
    }
    return next(e)
  })

  // The engine puts a plugin's tool behind ToolSearch; in front, Claude can mark without loading it first.
  on('tool.describe', { tool: MARK }, (_$, e) => ({ description: e.description, isDeferred: false }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // a subagent's run belongs to the main turn that spawned it
    worked = 0
    sinceMark = 0
    planTurn = false
    const ids = (WORK_PROMPT.exec(e.text)?.[1]?.match(/\d+/g) ?? []).map(Number)
    prompt = ids.length || !e.text.trim() ? '' : e.text // the tracker's own prompts and continuations never count
    if (ids.length) {
      planTurn = true
      ids.forEach(id => queued.delete(id))
      activePlan = findItem(await read($, tracker), ids[0] ?? -1)?.plan.id ?? activePlan
    }
    return next(e)
  })

  // The system prompt alone does not get marks mid-turn; a line after the tool result, as a PostToolUse reminder, does.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || !WORK.has(e.tool)) return r
    worked += 1
    if (EDITS.has(e.tool) && r.deny === undefined) {
      const path = String('file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : '')
      if (PLAN_DOC.test(path)) lastDoc = path
      // a repo file, not a spec or plan doc, a vault note, a memory file or a plan-mode draft
      if (prompt && path.startsWith(`${cwd}/`) && !path.includes('/docs/superpowers/')) await trackPrompt($)
    }
    if (r.deny !== undefined || ++sinceMark < REMIND_EVERY) return r
    const open = openItems(await read($, tracker)).filter(i => !isPending(i))
    if (open.length === 0) return r
    sinceMark = 0
    const rows = open.slice(0, 10).map(i => `#${i.id} ${i.text.slice(0, 60)}`).join(' · ')
    const more = open.length > 10 ? ` +${open.length - 10} more` : ''
    const line =
      `plan-tracker: still open: ${rows}${more}. If this call finished one of them, call mark_done now ` +
      '(its id + one line of evidence) before the next step. Never batch marks at the end of the turn.'
    return { ...r, context: [...(r.context ?? []), line] }
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
        prompt = ''
        await planned($, activePlan)
      }
    } catch (err) {
      $.ui.log(`plan-tracker: ${String(err)}`, { to: 'debug' })
    }
    return ran
  })

  // A superpowers plan doc is tracked when the skill that runs it starts: by then the doc is final.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError || !EXECUTE.test(String(e.skill))) return ran
    try {
      const found = String(e.args ?? '').match(/[\w./-]+\.md\b/)?.[0] ?? lastDoc ?? (await newestDoc($))
      const file = found && (found.startsWith('/') ? found : `${cwd}/${found}`)
      const text = file ? await $.fs.read(file) : ''
      if (file && text) {
        activePlan = await addPlan($, text, file)
        planTurn = true
        prompt = ''
      }
    } catch (err) {
      $.ui.log(`plan-tracker: ${String(err)}`, { to: 'debug' })
    }
    return ran
  })

  on('tool.call', { tool: MARK }, async ($, e) => {
    const id = Number(e.id)
    const t = await read($, tracker)
    const found = findItem(t, id)
    // a registered tool answers as an MCP tool does: a string or content blocks, never an object
    if (!found) {
      const open = openItems(t).map(i => `#${i.id} ${i.text}`)
      return { result: `No plan item #${id}.${open.length ? ` Open items:\n${open.join('\n')}` : ''}` }
    }
    if (e.agentId === undefined) {
      planTurn = true
      sinceMark = 0
      activePlan = found.plan.id
    }
    if (found.item.status === 'verified') return { result: `Item #${id} is already verified.` }
    // no model call here: the turn-end audit checks every claim in its one call
    const now = await $.clock.now()
    await save($, t => {
      const { note: _note, ...item } = found.item
      const claimed: PlanItem = { ...item, status: 'claimed', claim: String(e.evidence ?? '').slice(0, 300), doneAt: item.doneAt ?? now }
      return { ...t, plans: t.plans.map(p => ({ ...p, items: p.items.map(i => (i.id === id ? claimed : i)) })) }
    })
    return { result: `Item #${id} noted. The audit at the end of this turn checks it against your tool calls.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(e.tools ?? []).includes(MARK)) return r
    const t = await read($, tracker)
    const open = openItems(t)
    if (open.length === 0) return r
    const lines = open.map(i =>
      isPending(i) ? `#${i.id} [claimed, audit pending] ${i.text}`
        : i.status === 'claimed' ? `#${i.id} [claimed, unverified: ${i.note}] ${i.text}`
        : `#${i.id} [open] ${i.text}`,
    )
    const text = [
      '# Plan tracker',
      'Items from tracked plans and tasks still open in this project:',
      ...lines,
      'Call mark_done right after you finish each item, before starting the next, with its id and one line of evidence. Never mark what you have not done.',
    ].join('\n')
    return { sections: [...r.sections, { id: 'plan-tracker:open', text, scope: 'session' }] }
  })

  on('command.run', { command: 'plan-tracker' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      const answer = await $.ui.ask('Wipe the plan tracker for this project?', ['Wipe', 'Keep']).catch(() => 'Keep')
      if (answer !== 'Wipe') return { text: 'Kept.' }
      await save($, t => ({ ...EMPTY, nextId: t.nextId })) // old ids stay in the transcript; new items never reuse them
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
    const now = t.timing ? await $.clock.now() : 0
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
            <Button key={`done:${item.id}`} plain onPress={() => byHand($, item.id)}>✓</Button>
          )}
        </Box>
        {item.status === 'claimed' && item.note !== undefined && (
          <Text dimColor wrap="truncate">{`     ${item.note}`}</Text>
        )}
      </Box>
    )

    const verified = (items: PlanItem[]) => items.filter(i => i.status === 'verified').length

    const group = (plan: PlanGroup, n: number) => {
      const done = plan.items.length > 0 && plan.items.every(i => i.status === 'verified')
      const ok = verified(plan.items)
      const filled = plan.items.length ? Math.round((ok / plan.items.length) * 10) : 0
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={n > 0 ? 1 : 0}>
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text bold={!done} dimColor={done} wrap="truncate">{`${done ? '✓ ' : ''}${plan.title}`}</Text>
            </Box>
            <Text dimColor>{`${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${ok}/${plan.items.length}`}</Text>
            <Button key={`remove:${plan.id}`} plain dimColor onPress={() => save($, s => ({ ...s, plans: s.plans.filter(p => p.id !== plan.id) }))}>x</Button>
          </Box>
          {plan.file !== '' && !done && (
            <Text dimColor wrap="truncate-start">{plan.file.startsWith(`${cwd}/`) ? plan.file.slice(cwd.length + 1) : plan.file}</Text>
          )}
          {!done && <Box flexDirection="column" marginLeft={2}>{plan.items.map(item => row(plan, item))}</Box>}
          {!done && plan.note !== undefined && <Text dimColor wrap="truncate">{plan.note}</Text>}
          {plan.items.length === 0 && (
            <Button key="extract-again" onPress={() => reextract($, plan)}>{t.busy === 'extract' ? 'extracting…' : 'extract again'}</Button>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {t.plans.length === 0 && (
          <Text dimColor>No plan tracked yet. Run a superpowers plan, approve one in plan mode, or give Claude a task.</Text>
        )}
        {SOURCES.map(([source, label]) => {
          const plans = t.plans.filter(p => sourceOf(p) === source)
          if (plans.length === 0) return null
          const items = plans.flatMap(p => p.items)
          return (
            <Box flexDirection="column">
              <Box key={`section:${source}`} flexDirection="row" gap={1}>
                <Box flexGrow={1}>
                  <Text bold>{label}</Text>
                </Box>
                <Text dimColor>{`${verified(items)}/${items.length}`}</Text>
              </Box>
              {plans.map(group)}
            </Box>
          )
        })}
        {pending && (
          <Button key="verify-all" variant="primary" onPress={() => void verifyAll($)}>{t.busy === 'verify' ? 'verifying…' : 'Verify all'}</Button>
        )}
        {t.timing && (
          <Box key="time" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text bold>TIME</Text>
            {timeRows(t, t.timing, now).map(([key, label, time, isRunning]) => (
              <Box key={`time:${key}`} flexDirection="row" gap={1}>
                <Box flexGrow={1}>
                  <Text bold={key === 'total'} wrap="truncate">{label}</Text>
                </Box>
                <Text bold={isRunning} dimColor={!isRunning}>{time}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
