import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileChange, GitView, Pr } from '../types'

const PANE = 'git-tracker'
const DOCK_COLUMNS = 48 // plan-tracker's dock width, so the two tabs match
const TRUNKS = ['main', 'master', 'develop', 'dev'] // never "cut from" anything; ties prefer them as parent
const GRAPH_LINES = 12
const UNTRACKED_MAX = 30 // ponytail: first 30 untracked files only; page them if a branch ever has more
/** Tools that can change the working tree; each refreshes the pane after it ran. */
const WATCH = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
/** Bash commands that can create or move a PR, so gh is asked again mid-turn. */
const PR_CHANGE = /\bgh\s+pr\b|\bgit\s+push\b/
const EMPTY: GitView = { branch: '', ahead: 0, behind: 0, graph: [], files: [] }
const view = atom({ plugin: 'git-tracker', key: 'view' } as const, EMPTY)

const lines = (s: string) => s.split('\n').filter(Boolean)

async function run($: EngineInterface, ...argv: string[]) {
  const r = await $.process.run(argv)
  return { ok: r.exitCode === 0, out: r.stdout }
}

/** The branch HEAD was most likely cut from: fewest commits of HEAD's that it lacks. */
async function parentOf($: EngineInterface, branch: string) {
  if (TRUNKS.includes(branch)) return undefined
  const refs = lines((await run($, 'git', 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes')).out)
    .map(ref => ({ name: ref.replace(/^refs\/(heads|remotes)\//, ''), isLocal: ref.startsWith('refs/heads/') }))
    .filter(r => r.name !== branch && !r.name.endsWith('/HEAD') && !(!r.isLocal && r.name.endsWith(`/${branch}`)))
  // ponytail: one rev-list per ref; cache per branch if a repo has hundreds of refs
  const counted = await Promise.all(refs.map(async r => {
    const { ok, out } = await run($, 'git', 'rev-list', '--left-right', '--count', `HEAD...${r.name}`)
    const [ahead = 0, behind = 0] = out.trim().split(/\s+/).map(Number)
    const base = r.isLocal ? r.name : r.name.slice(r.name.indexOf('/') + 1)
    return ok ? [{ ...r, ahead, behind, isTrunk: TRUNKS.includes(base) }] : []
  }))
  return counted.flat().sort((a, b) =>
    a.ahead - b.ahead || Number(b.isTrunk) - Number(a.isTrunk) || Number(b.isLocal) - Number(a.isLocal) || a.behind - b.behind,
  )[0]
}

const counts = (numstat: string) => {
  const [added = '0', removed = '0'] = numstat.split('\t')
  return added === '-' ? { added: 0, removed: 0, isBinary: true } : { added: Number(added), removed: Number(removed), isBinary: false }
}

/** Working tree against the fork point, plus untracked files; both kinds of new file are `isNew`. */
async function changes($: EngineInterface, fork: string): Promise<FileChange[]> {
  // ponytail: paths git quotes (spaces, unicode) show quoted; switch to -z if that matters
  const out = lines((await run($, 'git', 'diff', '--numstat', '--summary', '--no-renames', fork)).out)
  const created = new Set(out.filter(l => l.startsWith(' create mode ')).map(l => l.replace(/^ create mode \d+ /, '')))
  const tracked = out.filter(l => !l.startsWith(' ')).map(l => {
    const path = l.split('\t').slice(2).join('\t')
    return { path, ...counts(l), isNew: created.has(path) }
  })
  const untracked = lines((await run($, 'git', 'ls-files', '--others', '--exclude-standard')).out).slice(0, UNTRACKED_MAX)
  const fresh = await Promise.all(untracked.map(async path => ({
    path,
    ...counts((await run($, 'git', 'diff', '--no-index', '--numstat', '--', '/dev/null', path)).out),
    isNew: true,
  })))
  return [...tracked, ...fresh].sort((a, b) => a.path.localeCompare(b.path))
}

async function snapshot($: EngineInterface): Promise<GitView> {
  const head = await run($, 'git', 'rev-parse', '--abbrev-ref', 'HEAD')
  if (!head.ok) return { ...EMPTY, error: 'Not a git repository.' }
  const branch = head.out.trim()
  const parent = await parentOf($, branch)
  const fork = parent ? (await run($, 'git', 'merge-base', 'HEAD', parent.name)).out.trim() || 'HEAD' : 'HEAD'
  const log = parent
    ? await run($, 'git', 'log', '--graph', '--oneline', '--decorate', '--boundary', '--color=never', '-n', `${GRAPH_LINES}`, `${parent.name}...HEAD`)
    : await run($, 'git', 'log', '--graph', '--oneline', '--decorate', '--color=never', '-n', `${GRAPH_LINES}`)
  return {
    branch,
    parent: parent?.name,
    ahead: parent?.ahead ?? 0,
    behind: parent?.behind ?? 0,
    graph: lines(log.out).slice(0, GRAPH_LINES),
    files: await changes($, fork),
  }
}

/** The current branch's PR, or none: no PR, no gh, or gh not signed in. */
async function prOf($: EngineInterface): Promise<Pr | undefined> {
  const r = await run($, 'gh', 'pr', 'view', '--json', 'number,url,state,isDraft').catch(() => undefined)
  if (!r?.ok) return undefined
  try {
    return JSON.parse(r.out) as Pr
  } catch {
    return undefined
  }
}

async function load($: EngineInterface, withPr: boolean) {
  try {
    const next = await snapshot($)
    const pr = withPr && next.error === undefined ? await prOf($) : undefined
    await update($, view, old => ({ ...next, pr: withPr ? pr : old.pr }))
  } catch (err) {
    $.ui.log(`git-tracker: refresh failed: ${String(err)}`, { to: 'debug' })
  }
}

let running: Promise<void> | undefined
let again: boolean | undefined // a call that came mid-run (its withPr): one more run covers every such call

/** Single-flight: a call during a run waits for that run plus one more, never a run of its own. */
function refresh($: EngineInterface, withPr: boolean): Promise<void> {
  if (running !== undefined) {
    again = (again ?? false) || withPr
    return running
  }
  running = (async () => {
    for (let pr: boolean | undefined = withPr; pr !== undefined; pr = again) {
      again = undefined
      await load($, pr)
    }
  })().finally(() => {
    running = undefined
  })
  return running
}

const stat = (f: { added: number; removed: number; isBinary?: boolean }) =>
  f.isBinary ? 'bin' : [f.added || !f.removed ? `+${f.added}` : '', f.removed ? `−${f.removed}` : ''].filter(Boolean).join(' ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PANE, description: 'Open the Git pane: parent branch graph, changed and new files, PR link' })
    void $.ui.open({ id: PANE, title: 'Git', columns: DOCK_COLUMNS })
    await refresh($, true)
    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Git', columns: DOCK_COLUMNS })
    void refresh($, true)
    return { text: opened.isPlaced ? 'Git pane opened.' : `Git pane waits: ${opened.reason}` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (WATCH.has(e.tool)) await refresh($, e.tool === 'Bash' && PR_CHANGE.test(e.command))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($, true)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const v = await read($, view)
    if (v.error !== undefined || v.branch === '') {
      return (
        <Box flexDirection="column">
          <Text dimColor>{v.error ?? 'Reading git…'}</Text>
        </Box>
      )
    }

    const section = (id: string, label: string, files: FileChange[]) =>
      files.length > 0 && (
        <Box flexDirection="column">
          <Box key={`section:${id}`} flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text bold>{`${label} ${files.length}`}</Text>
            </Box>
            <Text dimColor>{stat({ added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) })}</Text>
          </Box>
          {files.map(f => (
            <Box key={`file:${f.path}`} flexDirection="row" gap={1} marginLeft={2}>
              <Box flexGrow={1}>
                <Text wrap="truncate-start">{f.path}</Text>
              </Box>
              <Text dimColor>{stat(f)}</Text>
            </Box>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="head" flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Text bold wrap="truncate">{v.parent === undefined ? v.branch : `${v.branch} ← ${v.parent}  ${v.ahead}↑ ${v.behind}↓`}</Text>
          </Box>
          <Button key="refresh" plain onPress={() => refresh($, true)}>↻</Button>
        </Box>
        <Box flexDirection="column">
          {v.graph.map(line => (
            <Text dimColor wrap="truncate">{line}</Text>
          ))}
        </Box>
        {v.files.length === 0 && <Text dimColor>{`No changes since ${v.parent ?? 'HEAD'}.`}</Text>}
        {section('changed', 'CHANGED', v.files.filter(f => !f.isNew))}
        {section('new', 'NEW', v.files.filter(f => f.isNew))}
        {v.pr !== undefined && (
          <Box key="pr" flexDirection="column">
            <Text bold>{`PR #${v.pr.number} ${v.pr.isDraft ? 'draft' : v.pr.state.toLowerCase()}`}</Text>
            <Link href={v.pr.url} />
          </Box>
        )}
      </Box>
    )
  })
}
