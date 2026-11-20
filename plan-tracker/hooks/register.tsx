import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolUseSummary } from 'claude-code'

import type { Clock, Phase, PlanGroup, PlanItem, Times, Tracker } from '../types'

const PANE = 'plan-tracker'
const DOCK_COLUMNS = 48 // width when docked beside a fullscreen transcript; inline ignores it
const MARK = 'mcp__plan-tracker__mark_done'
const EMPTY: Tracker = { nextId: 1, plans: [] }
const tracker = atom({ plugin: 'plan-tracker', key: 'tracker' } as const, EMPTY)
/** Ids of the groups whose items are shown; every group starts collapsed. Not stored: a session's view only. */
const expanded = atom({ plugin: 'plan-tracker', key: 'expanded' } as const, [] as string[])
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
let ticking: { cancel: () => void } | undefined // redraws the pane each second while a clock runs
let sessionId = '' // a clock stamped with another session's id skips the gap since then
let turnAt = 0 // when the running main turn started: a typed task's clock starts there

/** The pane's phase rows, in order. */
const PHASES: ReadonlyArray<readonly [Phase, string]> = [
  ['plan', 'Plan'], ['review', 'Codex review'], ['dev', 'Dev'], ['fixes', 'Review fixes'],
  ['test', 'Test'], ['verify', 'Codex verify'],
]
const CODEX = /\bcodex\s+exec\b/
// ponytail: phase from the command text; a test behind a script name (`make check`) switches nothing, add a pattern when it matters
const TEST_CMD = /\bclaude plugin (test|validate)\b|\b(npm|pnpm|yarn|bun)( run)? test\b|\b(pytest|vitest|jest)\b|\b(go|cargo) test\b|tests\/screen\/|\btmux (send-keys|capture-pane)\b/

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
async function save($: EngineInterface, change: (t: Tracker, now: number) => Tracker) {
  const now = await $.clock.now()
  const next = await update($, tracker, t => stopIfDone(change(t, now), now))
  await $.store.set(storeKey, next)
  $.ui.status(status(next))
  tick($, next)
  return next
}

/** `save` only while a clock runs: a turn with no timing writes nothing. */
async function onClock($: EngineInterface, change: (t: Tracker, now: number) => Tracker) {
  if ((await read($, tracker)).clock) await save($, change)
}

const groupOf = (t: Tracker, id: string | undefined) => t.plans.find(p => p.id === id)
const isDone = (p: PlanGroup) => p.items.length > 0 && p.items.every(i => i.status === 'verified')
const isPlanning = (t: Tracker) => t.clock !== undefined && t.clock.group === undefined
/** A repo file, not a spec or plan doc, a vault note, a memory file or a plan-mode draft. */
const isRepo = (path: string) => path.startsWith(`${cwd}/`) && !path.includes('/docs/superpowers/')

/** The user has the floor: the clock is paused and nothing counts. */
const paused = (c?: Clock) => c?.phase === 'waiting'

/** Keeps one 1 s redraw going while a clock runs, none otherwise (paused included). */
function tick($: EngineInterface, t: Tracker) {
  if (t.clock && !paused(t.clock)) ticking ??= $.clock.every(1000, () => $.ui.invalidate('ui.render'))
  else {
    ticking?.cancel()
    ticking = undefined
  }
}

const add = (times: Times | undefined, phase: Phase, ms: number): Times => ({ ...times, [phase]: (times?.[phase] ?? 0) + ms })
/** The shown phases only: a 0.4.6 store's `waiting` bucket stays out of every total. */
const sum = (times: Times) => PHASES.reduce((a, [p]) => a + (times[p] ?? 0), 0)

/** The time since the clock's last move lands in its phase: `pending`, or its group's `time` (dropped when that group is gone). Paused time lands nowhere. */
function flush(t: Tracker, now: number): Tracker {
  const c = t.clock
  if (!c) return t
  const ms = Math.max(0, now - c.since)
  const clock: Clock = { ...c, since: Math.max(now, c.since) }
  if (paused(c)) return { ...t, clock }
  if (c.group === undefined) return { ...t, clock, pending: add(t.pending, c.phase, ms) }
  return { ...t, clock, plans: t.plans.map(p => (p.id === c.group ? { ...p, time: add(p.time, c.phase, ms) } : p)) }
}

/** Flushes, then runs `phase` (on `group` when given). Without a clock nothing runs. */
function switchTo(t: Tracker, now: number, phase: Phase, group?: string): Tracker {
  if (!t.clock) return t
  const next = flush(t, now)
  const { resume: _resume, ...clock } = next.clock ?? t.clock
  return { ...next, clock: { ...clock, phase, ...(group === undefined ? {} : { group }) } }
}

/** Paused while the user has the floor; nothing counts. `resume` keeps the phase to go back to. */
function wait(t: Tracker, now: number): Tracker {
  if (!t.clock || paused(t.clock)) return t
  const next = switchTo(t, now, 'waiting')
  return { ...next, clock: { ...(next.clock ?? t.clock), resume: t.clock.phase } }
}

/** Back from a pause to the phase before it. */
const resume = (t: Tracker, now: number): Tracker => (t.clock && paused(t.clock) ? switchTo(t, now, t.clock.resume ?? 'dev') : t)

/** Starts timing group `id` at `at`, never before the clock's last move; a planning run's buckets move into it. */
function attach(t: Tracker, at: number, id: string, phase: Phase = 'dev'): Tracker {
  const when = Math.max(at, t.clock?.since ?? at)
  const { pending, ...next } = flush(t, when)
  const moved = isPlanning(t) ? pending : undefined
  const plans = next.plans.map(p => (p.id === id && moved ? { ...p, time: PHASES.reduce((acc, [ph]) => add(acc, ph, moved[ph] ?? 0), p.time) } : p))
  const keep = isPlanning(t) || pending === undefined ? {} : { pending }
  return { ...next, ...keep, plans, clock: { group: id, phase, since: when, session: sessionId } }
}

/** A clock whose group is gone, or has items all verified, stops; its time up to `now` stays with the group. */
function stopIfDone(t: Tracker, now: number): Tracker {
  const id = t.clock?.group
  if (id === undefined) return t
  const g = groupOf(t, id)
  if (g && !isDone(g)) return t
  const { clock: _clock, ...rest } = flush(t, now)
  return rest
}

/** Dev work on a group that has had a Codex verify is Review fixes. */
const devOf = (t: Tracker, id: string | undefined): Phase => ((groupOf(t, id)?.time?.verify ?? 0) > 0 ? 'fixes' : 'dev')

/** Points the clock at group `id`; with no clock, starts one there when that group still has work. A planning run stays. */
function retarget(t: Tracker, now: number, id: string | undefined): Tracker {
  const g = groupOf(t, id)
  if (!g || isDone(g) || t.clock?.group === g.id || isPlanning(t)) return t
  if (t.clock) return switchTo(t, now, t.clock.phase, g.id)
  return { ...t, clock: { group: g.id, phase: devOf(t, g.id), since: now, session: sessionId } }
}

/** The phase a Bash command starts, or undefined for one that switches nothing. */
function bashPhase(command: string, planning: boolean): Phase | undefined {
  if (CODEX.test(command)) {
    if (/MODE: plan-review/.test(command)) return 'review'
    if (/MODE: acceptance/.test(command)) return 'verify'
    return planning ? 'review' : 'verify'
  }
  return TEST_CMD.test(command) ? 'test' : undefined
}

/** A tool call started `phase`: the clock moves there, first onto the active group when none runs. Dev after a Codex verify is Review fixes. */
async function enter($: EngineInterface, phase: Phase, bg = false) {
  const t = await read($, tracker)
  // the target counts a verify still running into the group, so the first edit after it is already Review fixes
  const target = (s: Tracker) => (phase === 'dev' && (s.clock?.phase === 'verify' || devOf(s, s.clock?.group) === 'fixes') ? 'fixes' : phase)
  if (t.clock && !bg && t.clock.phase === target(t)) return
  if (!t.clock && !retarget(t, 0, activePlan).clock) return // nothing to time: write nothing
  await save($, (s, now) => {
    const on = flush(s.clock ? s : retarget(s, now, activePlan), now)
    if (!on.clock) return s
    const next = switchTo(on, now, target(on))
    const { bg: _bg, ...clock } = next.clock ?? on.clock
    return { ...next, clock: bg ? { ...clock, bg: true } : clock }
  })
}

/** `45s`, `3m 05s`, `1h 02m`; never negative. */
function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  return s < 3600 ? `${Math.floor(s / 60)}m ${two(s % 60)}s` : `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`
}

/** The `▸/▾` button: shows or hides a group's items. */
async function toggle($: EngineInterface, id: string) {
  await update($, expanded, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
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
    const isFailed = (p: PlanGroup) => p.hash === hash && p.items.length === 0 // a failed copy of this plan
    const failed = t.plans.find(isFailed)
    const group: PlanGroup = { id, title, file, hash, approvedAt: new Date().toISOString(), items, ...(failed?.time ? { time: failed.time } : {}) }
    if (!texts) group.note = 'could not extract items; press extract again'
    // in this same change, or stopIfDone sees the clock's group gone and drops it
    const clock = t.clock && failed && t.clock.group === failed.id ? { clock: { ...t.clock, group: id } } : {}
    return { ...t, ...clock, nextId: t.nextId + items.length, plans: [group, ...t.plans.filter(p => !isFailed(p))] }
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
    await save($, t => attach(t, turnAt, id))
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

/**
 * A session's start (`fresh`), or a /clear (no session.start, $.state back to EMPTY): turn state reset, store loaded.
 * A clock from another session restarts now, so the time with no session running is not counted; a reload or a
 * /clear keeps it running.
 */
async function load($: EngineInterface, fresh: boolean) {
  planTurn = false
  prompt = ''
  lastDoc = undefined
  queued.clear() // ponytail: a prompt pulled back with Up keeps its ids queued until then; no event frees them sooner
  sessionId = String(await $.session.id())
  const saved = ((await $.store.get(storeKey)) as (Tracker & { timing?: unknown }) | undefined) ?? EMPTY
  const { busy: _busy, timing: _timing, ...rest } = saved // timing: the 0.4.6 card's run, gone
  const c = rest.clock
  const gap = fresh && c !== undefined && c.session !== sessionId
  // ponytail: `--resume` keeps the session id, so its gap counts; a stored heartbeat would fix that if it matters
  const stored: Tracker = c ? { ...rest, clock: { ...c, session: sessionId, ...(gap ? { since: await $.clock.now() } : {}) } } : rest
  if (c && c.session !== sessionId) await $.store.set(storeKey, stored)
  activePlan = stored.clock?.group
  await update($, tracker, () => stored)
  $.ui.status(status(stored))
  ticking?.cancel() // a /clear or reload drops the old timer
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
    cwd = e.cwd
    storeKey = `tracker:${cwd}`
    await load($, true)
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
    if (e.source === 'clear') await load($, false)
    return next(e)
  })

  // No event marks the plan-mode toggle itself; the first prompt sent in plan mode is the earliest sign of it.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode !== 'plan') return next(e)
    if (isPlanning(await read($, tracker))) {
      await save($, (t, now) => switchTo(t, now, 'plan'))
      return next(e)
    }
    // a new run: the group timed so far keeps its time and stops
    await save($, (t, now) => ({ ...flush(t, now), pending: {}, clock: { phase: 'plan', since: now, session: sessionId } }))
    // focus is a request: the engine gives the keys only over an empty composer, with no dialog up
    void $.ui.open({ id: PANE, title: 'Plan', columns: DOCK_COLUMNS, focus: true })
    return next(e)
  })

  // The engine puts a plugin's tool behind ToolSearch; in front, Claude can mark without loading it first.
  on('tool.describe', { tool: MARK }, (_$, e) => ({ description: e.description, isDeferred: false }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // a subagent's run belongs to the main turn that spawned it
    worked = 0
    sinceMark = 0
    planTurn = false
    turnAt = await $.clock.now()
    // ponytail: bg ends at any turn start; a prompt typed while Codex still runs ends its Codex time early
    await onClock($, (t, now) => {
      const back = resume(t, now)
      const { bg: _bg, ...clock } = back.clock ?? {}
      return back.clock ? { ...back, clock: clock as Clock } : back
    })
    const ids = (WORK_PROMPT.exec(e.text)?.[1]?.match(/\d+/g) ?? []).map(Number)
    prompt = ids.length || !e.text.trim() ? '' : e.text // the tracker's own prompts and continuations never count
    if (ids.length) {
      planTurn = true
      ids.forEach(id => queued.delete(id))
      activePlan = findItem(await read($, tracker), ids[0] ?? -1)?.plan.id ?? activePlan
      await save($, (t, now) => retarget(t, now, activePlan))
    }
    return next(e)
  })

  // The system prompt alone does not get marks mid-turn; a line after the tool result, as a PostToolUse reminder, does.
  // Subagents' calls count for timing too: a delegated test run is Test. Bash switches before it runs, as a long
  // test or Codex run belongs to its phase from the start; an edit switches after, once a typed task has its group.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') {
      const input = e as { command?: unknown; run_in_background?: unknown }
      const phase = bashPhase(String(input.command ?? ''), isPlanning(await read($, tracker)))
      if (phase) await enter($, phase, phase !== 'test' && input.run_in_background === true)
    }
    const r = await next(e)
    if (EDITS.has(e.tool) && r.deny === undefined) {
      const path = String('file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : '')
      if (e.agentId === undefined) {
        if (PLAN_DOC.test(path)) lastDoc = path
        if (prompt && isRepo(path)) await trackPrompt($)
      }
      if (isRepo(path)) await enter($, 'dev')
      else if (isPlanning(await read($, tracker))) await enter($, 'plan')
    }
    if (e.agentId !== undefined || !WORK.has(e.tool)) return r
    worked += 1
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
    if (e.agentId !== undefined) return r
    // any end, Esc included: the user has the floor; a background Codex run still counts as Codex
    await onClock($, (t, now) => (t.clock?.bg && (t.clock.phase === 'review' || t.clock.phase === 'verify') ? t : wait(t, now)))
    if (e.reason !== 'answer' || (worked === 0 && !planTurn)) return r
    const t = await read($, tracker)
    if (t.busy || !t.plans.some(p => p.items.some(i => i.status !== 'verified'))) return r
    const audit = await verifyAll($, { quiet: true, reply: e.answer })
    if (planTurn) await nudge($, audit)
    return r
  })

  // The approval dialog is the user's time.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    if (e.agentId === undefined) await onClock($, wait)
    const ran = await next(e)
    if (e.agentId === undefined) await onClock($, resume)
    // smoke-check only, removed once the rejection shape is confirmed as isError
    $.ui.log(`plan-tracker: ExitPlanMode ${ran.isError ? 'isError' : 'ok'} ${JSON.stringify(ran.result ?? null).slice(0, 160)}`, { to: 'debug' })
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran
    try {
      const result = ran.result as { plan?: string | null; filePath?: string } | undefined
      const file = result?.filePath ?? ''
      const text = result?.plan ?? (file ? await $.fs.read(file) : '')
      if (text) {
        const at = await $.clock.now() // before the extraction: its seconds are Dev, not Plan
        const id = await addPlan($, text, file)
        activePlan = id
        planTurn = true
        prompt = ''
        if (id) await save($, t => attach(t, at, id))
      }
    } catch (err) {
      $.ui.log(`plan-tracker: ${String(err)}`, { to: 'debug' })
    }
    return ran
  })

  // A question dialog is the user's time; another plugin's `$.ui.ask` runs this same tool call.
  // One asked while already paused (the reset confirm, an idle `$.ui.ask`) leaves the pause alone.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const idle = paused((await read($, tracker)).clock)
    if (!idle) await onClock($, wait)
    try {
      return await next(e)
    } finally {
      if (!idle) await onClock($, resume)
    }
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
        const id = await addPlan($, text, file)
        activePlan = id
        planTurn = true
        prompt = ''
        if (id) await save($, (t, now) => attach(t, now, id))
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
    const main = e.agentId === undefined
    await save($, (t, now) => {
      const { note: _note, ...item } = found.item
      const claimed: PlanItem = { ...item, status: 'claimed', claim: String(e.evidence ?? '').slice(0, 300) }
      const next = { ...t, plans: t.plans.map(p => ({ ...p, items: p.items.map(i => (i.id === id ? claimed : i)) })) }
      return main ? retarget(next, now, found.plan.id) : next // the clock follows the group Claude works on
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
    const shown = await read($, expanded)
    const now = t.clock ? await $.clock.now() : 0
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

    const verified = (items: PlanItem[]) => items.filter(i => i.status === 'verified').length

    /** `times` with the running clock's live part added when `key` is the one it times. */
    const live = (key: string, times: Times | undefined): Times | undefined => {
      const c = t.clock
      const runs = c !== undefined && (c.group ?? 'pending') === key
      return runs ? add(times, c.phase, Math.max(0, now - c.since)) : times
    }

    /** One row per phase with time (`●` on the running one) and Total; nothing for a group never timed. */
    const phaseRows = (key: string, times: Times | undefined) => {
      const all = live(key, times)
      const running = t.clock !== undefined && (t.clock.group ?? 'pending') === key ? t.clock.phase : undefined
      if (!all || (sum(all) === 0 && running === undefined)) return null
      const rows = PHASES.filter(([p]) => (all[p] ?? 0) > 0 || p === running)
      return (
        <Box flexDirection="column" marginLeft={2}>
          {rows.map(([p, label]) => (
            <Box key={`time:${key}:${p}`} flexDirection="row" gap={1}>
              <Box flexGrow={1}>
                <Text dimColor={p !== running} wrap="truncate">{label}</Text>
              </Box>
              {p === running && <Text color="success">●</Text>}
              <Text dimColor={p !== running}>{fmt(all[p] ?? 0)}</Text>
            </Box>
          ))}
          <Box key={`time:${key}:total`} flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text bold>Total</Text>
            </Box>
            <Text bold>{fmt(sum(all))}</Text>
          </Box>
        </Box>
      )
    }

    const group = (plan: PlanGroup, n: number) => {
      const done = isDone(plan)
      const ok = verified(plan.items)
      const filled = plan.items.length ? Math.round((ok / plan.items.length) * 10) : 0
      const isOpen = shown.includes(plan.id)
      const total = sum(live(plan.id, plan.time) ?? {})
      const remove = <Button key={`remove:${plan.id}`} plain dimColor onPress={() => save($, s => ({ ...s, plans: s.plans.filter(p => p.id !== plan.id) }))}>x</Button>
      if (done) {
        return (
          <Box key={`head:${plan.id}`} flexDirection="row" gap={1} marginLeft={2} marginTop={n > 0 ? 1 : 0}>
            <Box flexGrow={1}>
              <Text dimColor wrap="truncate">{`✓ ${plan.title}`}</Text>
            </Box>
            <Text dimColor>{`${ok}/${plan.items.length}${total > 0 ? ` ${fmt(total)}` : ''}`}</Text>
            {remove}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={n > 0 ? 1 : 0}>
          <Box key={`head:${plan.id}`} flexDirection="row" gap={1}>
            <Button key={`toggle:${plan.id}`} plain onPress={() => toggle($, plan.id)}>{isOpen ? '▾' : '▸'}</Button>
            <Box flexGrow={1}>
              <Text bold wrap="truncate">{plan.title}</Text>
            </Box>
            <Text dimColor>{`${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${ok}/${plan.items.length}`}</Text>
            {remove}
          </Box>
          {phaseRows(plan.id, plan.time)}
          {plan.note !== undefined && <Text dimColor wrap="truncate">{plan.note}</Text>}
          {isOpen && plan.file !== '' && (
            <Text dimColor wrap="truncate-start">{plan.file.startsWith(`${cwd}/`) ? plan.file.slice(cwd.length + 1) : plan.file}</Text>
          )}
          {isOpen && <Box flexDirection="column" marginLeft={2}>{plan.items.map(item => row(plan, item))}</Box>}
          {plan.items.length === 0 && (
            <Button key="extract-again" onPress={() => reextract($, plan)}>{t.busy === 'extract' ? 'extracting…' : 'extract again'}</Button>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {isPlanning(t) && (
          <Box key="pending" flexDirection="column">
            <Text bold>Planning (not approved yet)</Text>
            {phaseRows('pending', t.pending)}
          </Box>
        )}
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
      </Box>
    )
  })
}
