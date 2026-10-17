import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardEntry, BoardRow, Build, DesignConfig, DesignView, PageRows } from '../types'

const PANE = 'design-tracker'
const DOCK_COLUMNS = 48 // plan-tracker's dock width, so the tabs match
const MARK = 'mcp__design-tracker__mark_board'
const CANVAS_URL = /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/
/** Claude Design has no approval field: a `[Draft]` tag in the title is a draft, no tag is approved. */
const DRAFT = /\s*\[Draft\]/i
const RETIRED = /\(retired\b/i
/** The ▶ prompt's head: a main turn that starts with it is building that board. */
const BUILD_PROMPT = /^Build artboard ".*" \((\S+\.dc\.html)\) of Claude Design canvas /
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const RANK: Record<Build, number> = { started: 0, none: 1, done: 2 }
const EMPTY: DesignView = { isLinked: false, pages: [] }
const view = atom({ plugin: 'design-tracker', key: 'view' } as const, EMPTY)

let cwd = ''
let activeBoard: string | undefined // the board a ▶ turn builds, until its first repo edit

/** The parts of the canvas's `project/canvas.json` read here; the rest is the editor's. */
type Canvas = {
  title?: string
  pages?: Array<{ id: string; name: string }>
  boards?: Record<string, { title?: string; page?: string }>
  designSystems?: Array<{ title?: string; artifact?: string }>
}

const configPath = () => `${cwd}/.claude/design-tracker.json`

async function readConfig($: EngineInterface): Promise<DesignConfig | undefined> {
  if (!(await $.fs.exists(configPath()))) return undefined
  try {
    return JSON.parse(String(await $.fs.read(configPath()))) as DesignConfig
  } catch (err) {
    throw new Error(`Bad .claude/design-tracker.json: ${String(err)}`)
  }
}

const writeConfig = ($: EngineInterface, cfg: DesignConfig) => $.fs.write(configPath(), `${JSON.stringify(cfg, null, 2)}\n`)

/** Through the Artifact tool, so the person's claude.ai login and permission rules apply. */
async function readCanvas($: EngineInterface, url: string): Promise<Canvas> {
  const r = await $.tool.call({ tool: 'Artifact', action: 'read', url, path: 'project/canvas.json' }).catch((err: unknown) => {
    throw new Error(`Canvas unreadable: ${String(err)}`)
  })
  if (r.deny !== undefined || r.isError) throw new Error(`Canvas unreadable: ${r.deny ?? r.text ?? 'the Artifact tool failed'}`)
  const file = (r.result as { file_read?: { content?: string; saved_to?: string } } | undefined)?.file_read
  const text = file?.content ?? (file?.saved_to ? String(await $.fs.read(file.saved_to)) : '')
  try {
    return JSON.parse(text) as Canvas
  } catch {
    throw new Error('Canvas unreadable: project/canvas.json is not JSON')
  }
}

/** Done needs one of its files still on disk; done with every file gone is back in progress. */
async function buildOf($: EngineInterface, entry: BoardEntry | undefined): Promise<Build> {
  if (entry === undefined) return 'none'
  if (entry.status === 'started') return 'started'
  const found = await Promise.all((entry.files ?? []).map(f => $.fs.exists(f.startsWith('/') ? f : `${cwd}/${f}`)))
  return found.some(Boolean) ? 'done' : 'started'
}

const sorted = (boards: BoardRow[]) => [...boards].sort((a, b) => RANK[a.build] - RANK[b.build] || a.title.localeCompare(b.title))

/** Boards under their page in the canvas's page order, retired ones left out; a board with no page is on the first. */
async function pagesOf($: EngineInterface, canvas: Canvas, cfg: DesignConfig): Promise<PageRows[]> {
  const pages: PageRows[] = (canvas.pages?.length ? canvas.pages : [{ id: '', name: 'Artboards' }]).map(p => ({ id: p.id, name: p.name, boards: [] }))
  for (const [file, b] of Object.entries(canvas.boards ?? {})) {
    const title = b.title ?? file.replace(/\.dc\.html$/, '')
    if (RETIRED.test(title)) continue
    const page = pages.find(p => p.id === b.page) ?? pages[0]
    page?.boards.push({ file, title: title.replace(DRAFT, '').trim(), isDraft: DRAFT.test(title), build: await buildOf($, cfg.boards[file]) })
  }
  return pages.map(p => ({ ...p, boards: sorted(p.boards) }))
}

async function load($: EngineInterface) {
  try {
    const cfg = await readConfig($)
    if (cfg === undefined) return void (await update($, view, () => EMPTY))
    const canvas = await readCanvas($, cfg.canvas)
    const lib = canvas.designSystems?.[0]
    const pages = await pagesOf($, canvas, cfg)
    await update($, view, () => ({
      isLinked: true,
      canvas: { url: cfg.canvas, title: canvas.title ?? 'Untitled canvas' },
      library: lib?.artifact ? { url: lib.artifact, title: lib.title ?? 'Library' } : undefined,
      pages,
    }))
  } catch (err) {
    await update($, view, () => ({ isLinked: true, pages: [], error: err instanceof Error ? err.message : String(err) }))
  }
}

let running: Promise<void> | undefined
let again = false // a call that came mid-run: one more run covers every such call

/** Single-flight, as git-tracker's: a call during a run waits for that run plus one more. */
function refresh($: EngineInterface): Promise<void> {
  if (running !== undefined) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await load($)
    } while (again)
  })().finally(() => {
    running = undefined
  })
  return running
}

/** Writes one board's entry (none clears it) and redraws build states without reading the canvas again. */
async function setBoard($: EngineInterface, file: string, entry: BoardEntry | undefined) {
  const cfg = await readConfig($)
  if (cfg === undefined) return
  const boards = { ...cfg.boards }
  if (entry === undefined) delete boards[file]
  else boards[file] = entry
  await writeConfig($, { ...cfg, boards })
  const v = await read($, view)
  const pages = await Promise.all(v.pages.map(async p => ({
    ...p,
    boards: sorted(await Promise.all(p.boards.map(async b => ({ ...b, build: await buildOf($, boards[b.file]) })))),
  })))
  await update($, view, old => ({ ...old, pages }))
}

const count = (boards: BoardRow[], build: Build) => boards.filter(b => b.build === build).length
const tally = (boards: BoardRow[]) => `✓${count(boards, 'done')} ◐${count(boards, 'started')} ○${count(boards, 'none')}`
const allBoards = (v: DesignView) => v.pages.flatMap(p => p.boards)

const buildPrompt = (v: DesignView, b: BoardRow) =>
  `Build artboard "${b.title}" (${b.file}) of Claude Design canvas ${v.canvas?.url ?? ''} in this project. ` +
  `Read it with the Artifact tool (action read, url ${v.canvas?.url ?? ''}, path project/${b.file}).` +
  (v.library ? ` Library: ${v.library.url}.` : '') +
  ' Call mark_board started now, and done with the files you wrote once it works.'

const auditPrompt = (url: string) =>
  `Audit design build status: read project/canvas.json of ${url} with the Artifact tool, compare each non-retired ` +
  "artboard to this repo's code, and call mark_board for each: done with its files if fully built, started if partly. " +
  'Change no code.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    activeBoard = undefined
    await $.command.register({
      name: PANE,
      description: 'Open the Design pane; with a canvas link, tie this project to that Claude Design canvas',
      argumentHint: '[canvas url]',
    })
    await $.tool.register({
      name: 'mark_board',
      description:
        "Record the build state of an artboard of this project's Claude Design canvas (design-tracker pane). " +
        'board = the artboard\'s .dc.html file name. status: "started" when you begin building it, "done" once it ' +
        'works (files = the source files that implement it, relative to the project root), "none" to clear.',
      inputSchema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'the artboard file name, e.g. Main.dc.html' },
          status: { type: 'string', enum: ['started', 'done', 'none'] },
          files: { type: 'array', items: { type: 'string' }, description: 'done only: the files that implement it' },
        },
        required: ['board', 'status'],
      },
    })
    void $.ui.open({ id: PANE, title: 'Design', columns: DOCK_COLUMNS })
    await refresh($)
    return next(e)
  })

  // The engine puts a plugin's tool behind ToolSearch; in front, Claude can mark without loading it first.
  on('tool.describe', { tool: MARK }, (_$, e) => ({ description: e.description, isDeferred: false }))

  on('command.run', { command: PANE }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== '' && !CANVAS_URL.test(arg)) return { text: `Expected a canvas link like https://claude.ai/artifact/<id>, got "${arg}".` }
    if (arg !== '') {
      const old = await readConfig($).catch(() => undefined)
      const wrote = await writeConfig($, { canvas: arg, boards: old?.boards ?? {} }).then(() => true, (err: unknown) => String(err))
      if (wrote !== true) return { text: `Could not write .claude/design-tracker.json: ${wrote}` }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Design', columns: DOCK_COLUMNS })
    await refresh($)
    const v = await read($, view)
    const what = v.error ?? (v.canvas ? `${v.canvas.title}${v.library ? `, library ${v.library.title}` : ''}` : 'not linked')
    return { text: opened.isPlaced ? `Design pane: ${what}.` : `Design pane waits: ${opened.reason}` }
  })

  on('tool.call', { tool: MARK }, async ($, e) => {
    const board = String(e.board ?? '')
    const status = String(e.status ?? '')
    const files = Array.isArray(e.files) ? e.files.map(String).filter(Boolean) : []
    const v = await read($, view)
    // a registered tool answers as an MCP tool does: a string or content blocks, never an object
    if (v.canvas === undefined) return { result: 'No Claude Design canvas is linked: the person runs /design-tracker <canvas url> first.' }
    if (!allBoards(v).some(b => b.file === board)) {
      return { result: `No artboard ${board} on "${v.canvas.title}" (unknown or retired). board is the artboard's .dc.html file name.` }
    }
    if (!['started', 'done', 'none'].includes(status)) return { result: `status must be started, done or none, not "${status}".` }
    if (status === 'done' && files.length === 0) return { result: `Marking ${board} done needs the files that implement it.` }
    try {
      await setBoard($, board, status === 'none' ? undefined : status === 'done' ? { status, files } : { status: 'started' })
    } catch (err) {
      return { result: `Could not record ${board}: ${String(err)}` }
    }
    return { result: `${board}: ${status === 'none' ? 'not started' : status === 'done' ? `done (${files.join(', ')})` : 'in progress'}.` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) activeBoard = BUILD_PROMPT.exec(e.text)?.[1]
    return next(e)
  })

  // A ▶ turn's first edit of a project file puts its board in progress, unless Claude already marked it.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (activeBoard === undefined || e.agentId !== undefined || !EDITS.has(e.tool) || r.deny !== undefined || r.isError) return r
    const path = String('file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : '')
    if (!path.startsWith(`${cwd}/`) || path.startsWith(`${cwd}/.claude/`)) return r
    const board = activeBoard
    activeBoard = undefined
    try {
      const cfg = await readConfig($)
      if (cfg !== undefined && cfg.boards[board] === undefined) await setBoard($, board, { status: 'started' })
    } catch (err) {
      $.ui.log(`design-tracker: could not mark ${board} started: ${String(err)}`, { to: 'debug' })
    }
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(e.tools ?? []).includes(MARK)) return r
    const v = await read($, view)
    if (v.canvas === undefined) return r
    const lib = v.library ? `, design library "${v.library.title}" (${v.library.url})` : ''
    const text = [
      '# Design tracker',
      `This project builds the Claude Design canvas "${v.canvas.title}" (${v.canvas.url})${lib}. Artboards: ${tally(allBoards(v))}.`,
      'Building or finishing an artboard of this canvas: call mark_board (board = its .dc.html file name): started when you begin, done with the files once it works.',
    ].join('\n')
    return { sections: [...r.sections, { id: 'design-tracker', text, scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const v = await read($, view)
    if (!v.isLinked) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Not linked to a Claude Design canvas.</Text>
          <Text dimColor>{'Run /design-tracker <canvas url>'}</Text>
        </Box>
      )
    }
    const refreshButton = <Button key="refresh" plain onPress={() => refresh($)}>↻</Button>
    if (v.error !== undefined || v.canvas === undefined) {
      return (
        <Box key="head" flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Text color={v.error === undefined ? undefined : 'error'} dimColor={v.error === undefined}>{v.error ?? 'Reading canvas…'}</Text>
          </Box>
          {refreshButton}
        </Box>
      )
    }
    const canvasUrl = v.canvas.url

    // `✓4 ◐1 ○25`, each count in its state's color
    const counts = (boards: BoardRow[]) => (
      <Text>
        <Text color="success">{`✓${count(boards, 'done')}`}</Text>
        {' '}
        <Text color="warning">{`◐${count(boards, 'started')}`}</Text>
        {' '}
        <Text dimColor>{`○${count(boards, 'none')}`}</Text>
      </Text>
    )

    const row = (b: BoardRow) => (
      <Box key={`board:${b.file}`} flexDirection="row" gap={1} marginLeft={2}>
        <Text color={b.build === 'done' ? 'success' : b.build === 'started' ? 'warning' : undefined} dimColor={b.build === 'none'}>
          {b.build === 'done' ? '✓' : b.build === 'started' ? '◐' : '○'}
        </Text>
        <Box flexGrow={1}>
          <Text dimColor={b.build === 'done'} wrap="truncate">{b.title}</Text>
        </Box>
        {b.isDraft && <Text dimColor>draft</Text>}
        {!b.isDraft && b.build !== 'done' && (
          <Button key={`build:${b.file}`} plain onPress={() => $.prompt.submit({ text: buildPrompt(v, b) })}>▶</Button>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box key="head" flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Link href={canvasUrl} label={v.canvas.title} />
            </Box>
            <Button key="audit" plain onPress={() => $.prompt.submit({ text: auditPrompt(canvasUrl) })}>audit</Button>
            {refreshButton}
          </Box>
          <Box key="lib" flexDirection="row" gap={1}>
            <Box flexGrow={1} flexDirection="row">
              {v.library ? <Text dimColor>{'lib '}</Text> : <Text dimColor>no library</Text>}
              {v.library && <Link href={v.library.url} label={v.library.title} />}
            </Box>
            {counts(allBoards(v))}
          </Box>
        </Box>
        {v.pages.filter(p => p.boards.length > 0).map(p => (
          <Box key={`page:${p.id}`} flexDirection="column">
            <Box key={`pagehead:${p.id}`} flexDirection="row" gap={1}>
              <Box flexGrow={1}>
                <Text bold wrap="truncate">{p.name}</Text>
              </Box>
              {counts(p.boards)}
            </Box>
            {p.boards.map(row)}
          </Box>
        ))}
      </Box>
    )
  })
}
