import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { DesignConfig } from '../types'

const CWD = '/repo'
const CFG = `${CWD}/.claude/design-tracker.json`
const URL = 'https://claude.ai/artifact/abc'
const LIB = 'https://claude.ai/artifact/lib1'
const MARK = 'mcp__design-tracker__mark_board'
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE = {
  title: 'Design', isFocused: false, bodyColumns: 48, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 }, view: {},
}

const board = (title: string, page?: string) => ({ x: 0, y: 0, w: 390, h: 844, title, ...(page ? { page } : {}) })

/** Two pages; b has no page (so the first), c is a draft, d is retired. */
const CANVAS = {
  v: 3,
  title: 'Syphonr flows',
  pages: [{ id: 'f07', name: 'F07 Conversation' }, { id: 'dat', name: 'DAT' }],
  boards: {
    'a.dc.html': board('A home', 'f07'),
    'b.dc.html': board('B picker'),
    'c.dc.html': board('C file [Draft]', 'dat'),
    'd.dc.html': board('D old (retired 2026-10-02)', 'dat'),
    'e.dc.html': board('E sheet', 'dat'),
  } as Record<string, ReturnType<typeof board>>,
  order: ['a.dc.html', 'b.dc.html', 'c.dc.html', 'd.dc.html', 'e.dc.html'],
  notes: {},
  designSystems: [{ title: 'Syphonr', namespace: 'syphonr', artifact: LIB, version: null, copiedAt: '2026-10-02T04:40:00Z' }],
}

const CONFIG: DesignConfig = {
  canvas: URL,
  boards: { 'a.dc.html': { status: 'done', files: ['x.vue'] }, 'e.dc.html': { status: 'started' } },
}

/** The project linked to CANVAS with CONFIG, and a's file on disk. */
const linked = (): Record<string, string> => ({ [CFG]: JSON.stringify(CONFIG), [`${CWD}/x.vue`]: 'x' })

type Canvas = typeof CANVAS | 'error'

/** Starts the session with a fake disk (`files`) and a fake Artifact tool answering `canvas`; both may change mid-test. */
async function start($: Engine, on: On, files: Record<string, string> = {}, canvas: Canvas = CANVAS) {
  const seen = {
    files: new Map(Object.entries(files)),
    writes: [] as string[],
    reads: [] as Array<{ url: unknown; path: unknown }>,
    submitted: [] as string[],
    models: 0,
    canvas,
  }
  on('fs.exists', (_$, e) => ({ value: seen.files.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    seen.writes.push(e.path)
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Artifact' }, (_$, e) => {
    seen.reads.push({ url: e.url, path: e.path })
    if (seen.canvas === 'error') return { isError: true as const, result: 'boom', text: 'Artifact read failed: boom' }
    const content = JSON.stringify(seen.canvas)
    return {
      result: {
        file_read: { path: 'project/canvas.json', saved_to: '/tmp/canvas.json', ver: '1', size_bytes: content.length, content_type: 'application/json', sha256: '0', content },
      } as never,
    }
  })
  on('model.complete', () => {
    seen.models += 1
    return { value: { isAnswered: true as const, text: '', usage: USAGE } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__design-tracker__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: { ok: true } }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  return seen
}

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'design-tracker', surface: 'terminal', component: 'Pane', requestId: 'design-tracker', props: PANE })

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'design-tracker', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

const config = (seen: { files: Map<string, string> }) => JSON.parse(seen.files.get(CFG) ?? '{}') as DesignConfig

describe('design-tracker', () => {
  test('unlinked_project_shows_link_hint', async ($, on) => {
    const seen = await start($, on)

    const pane = await mount($)

    expect(await pane.find({ type: 'Text', text: /Not linked/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /\/design-tracker <canvas url>/ })).toBeDefined()
    expect(seen.reads).toHaveLength(0)
  })

  test('link_command_writes_config_and_reads_canvas', async ($, on) => {
    const seen = await start($, on)

    await run($, URL)

    expect(config(seen)).toEqual({ canvas: URL, boards: {} })
    expect(seen.reads).toEqual([{ url: URL, path: 'project/canvas.json' }])
  })

  test('link_command_bad_url_writes_nothing', async ($, on) => {
    const seen = await start($, on)

    const ran = await run($, 'foo')

    expect(JSON.stringify(ran)).toContain('https://claude.ai/artifact/')
    expect(seen.writes).toHaveLength(0)
  })

  test('pane_lists_boards_by_page_and_state', async ($, on) => {
    await start($, on, linked())

    const pane = await mount($)

    expect((await pane.find({ key: 'head' }))?.text).toContain('Syphonr flows')
    expect((await pane.findAll({ type: 'Link' })).map(l => l.props.href)).toEqual([URL, LIB])
    expect((await pane.find({ key: 'lib' }))?.text).toContain('✓1 ◐1 ○2')
    const order = (await pane.findAll({ type: 'Box' })).map(n => n.key).filter(k => /^(page|board):/.test(k ?? ''))
    expect(order).toEqual(['page:f07', 'board:b.dc.html', 'board:a.dc.html', 'page:dat', 'board:e.dc.html', 'board:c.dc.html'])
    expect((await pane.find({ key: 'board:b.dc.html' }))?.text).toContain('○')
    expect(await pane.find({ key: 'build:b.dc.html' })).toBeDefined()
    expect((await pane.find({ key: 'board:a.dc.html' }))?.text).toContain('✓')
    expect((await pane.find({ type: 'Text', text: 'A home' }))?.props.dimColor).toBe(true)
    expect((await pane.find({ key: 'board:e.dc.html' }))?.text).toContain('◐')
    const draft = (await pane.find({ key: 'board:c.dc.html' }))?.text ?? ''
    expect(draft).toContain('C file')
    expect(draft).toContain('draft')
    expect(draft).not.toContain('[Draft]')
    expect(await pane.find({ key: 'build:c.dc.html' })).toBeUndefined()
    expect(await pane.find({ key: 'board:d.dc.html' })).toBeUndefined()
  })

  test('done_board_with_missing_files_shows_started', async ($, on) => {
    const files = linked()
    delete files[`${CWD}/x.vue`]
    await start($, on, files)

    const pane = await mount($)

    expect((await pane.find({ key: 'board:a.dc.html' }))?.text).toContain('◐')
  })

  test('mark_board_writes_each_status', async ($, on) => {
    const seen = await start($, on, linked())
    seen.files.set(`${CWD}/y.vue`, 'y')

    const r1 = await $.tool.call({ tool: MARK, board: 'b.dc.html', status: 'started' })
    const r2 = await $.tool.call({ tool: MARK, board: 'b.dc.html', status: 'done', files: ['y.vue'] })
    const r3 = await $.tool.call({ tool: MARK, board: 'e.dc.html', status: 'none' })

    expect([r1.result, r2.result, r3.result].every(r => typeof r === 'string')).toBe(true)
    expect(String(r2.result)).toContain('b.dc.html')
    expect(String(r3.result)).toContain('e.dc.html')
    expect(config(seen).boards).toEqual({ 'a.dc.html': { status: 'done', files: ['x.vue'] }, 'b.dc.html': { status: 'done', files: ['y.vue'] } })
    const pane = await mount($)
    expect((await pane.find({ key: 'lib' }))?.text).toContain('✓2 ◐0 ○2')
  })

  test('mark_board_refuses_unknown_retired_or_fileless', async ($, on) => {
    const seen = await start($, on, linked())

    const unknown = await $.tool.call({ tool: MARK, board: 'zz.dc.html', status: 'done', files: ['y.vue'] })
    const retired = await $.tool.call({ tool: MARK, board: 'd.dc.html', status: 'done', files: ['y.vue'] })
    const fileless = await $.tool.call({ tool: MARK, board: 'b.dc.html', status: 'done' })

    expect(String(unknown.result)).toContain('zz.dc.html')
    expect(String(retired.result)).toContain('d.dc.html')
    expect(String(fileless.result)).toContain('files')
    expect(seen.writes).toHaveLength(0)
  })

  test('build_and_audit_buttons_submit_prompts', async ($, on) => {
    const seen = await start($, on, linked())
    const pane = await mount($)

    await pane.press({ key: 'build:b.dc.html' })
    await pane.press({ key: 'audit' })

    expect(seen.submitted).toHaveLength(2)
    const [build = '', audit = ''] = seen.submitted
    expect(build).toContain('B picker')
    expect(build).toContain('project/b.dc.html')
    expect(build).toContain(URL)
    expect(build).toContain('mark_board')
    expect(audit).toContain(URL)
    expect(audit).toContain('mark_board')
    expect(audit).toContain('Change no code')
    expect(await pane.find({ key: 'build:a.dc.html' })).toBeUndefined()
  })

  test('build_turn_edit_marks_started', async ($, on) => {
    const seen = await start($, on, linked())
    const pane = await mount($)
    await pane.press({ key: 'build:b.dc.html' })

    await $.turn.start({ text: seen.submitted[0] ?? '', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/b.vue`, old_string: 'a', new_string: 'b' })
    const afterBuild = config(seen).boards['b.dc.html']
    const writes = seen.writes.length
    await $.turn.start({ text: 'fix the z typo', turnId: 't2' })
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/z.vue`, old_string: 'a', new_string: 'b' })

    expect(afterBuild).toEqual({ status: 'started' })
    expect(seen.writes).toHaveLength(writes)
  })

  test('unreadable_canvas_shows_error', async ($, on) => {
    const seen = await start($, on, linked(), 'error')

    const pane = await mount($)

    expect(await pane.find({ type: 'Text', text: /Canvas unreadable/ })).toBeDefined()
    expect(seen.writes).toHaveLength(0)
  })

  test('compose_lists_link_and_tool_not_deferred', async ($, on) => {
    await start($, on, linked())

    const { sections } = await $.prompt.compose({
      model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'],
      tools: ['Read', MARK], outputStyle: null, traits: [],
    })
    const described = await $.tool.describe({ tool: MARK, description: 'd', isDeferred: true, provider: { plugin: 'design-tracker', tier: 'user' } })

    const text = sections.find(s => s.id === 'design-tracker')?.text ?? ''
    expect(text).toContain(URL)
    expect(text).toContain(LIB)
    expect(text).toContain('✓1 ◐1 ○2')
    expect(text).toContain('mark_board')
    expect(described.isDeferred).toBe(false)
  })

  test('refresh_button_rereads_canvas', async ($, on) => {
    const seen = await start($, on, linked())
    const pane = await mount($)
    seen.canvas = {
      ...CANVAS,
      boards: {
        ...CANVAS.boards,
        'b.dc.html': board('B picker v2'),
        'c.dc.html': board('C file', 'dat'),
        'f.dc.html': board('F new', 'f07'),
      },
    }

    await pane.press({ key: 'refresh' })

    expect(seen.reads).toHaveLength(2)
    expect((await pane.find({ key: 'board:b.dc.html' }))?.text).toContain('B picker v2')
    expect(await pane.find({ key: 'build:f.dc.html' })).toBeDefined()
    expect((await pane.find({ key: 'board:c.dc.html' }))?.text).not.toContain('draft')
    expect(await pane.find({ key: 'build:c.dc.html' })).toBeDefined()
    expect(seen.models).toBe(0)
  })
})
