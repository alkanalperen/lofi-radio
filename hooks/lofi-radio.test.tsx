import { expect, test } from 'claude-code/testing'

import { lastLine, scene } from './register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, bodyColumns: 100 } } as const
const PANE = {
  component: 'Pane',
  requestId: 'claude-fm',
  props: { title: 'Claude FM', isFocused: false, bodyColumns: 70, placement: 'dock' },
} as const

function engine(on: Parameters<Parameters<typeof test>[1]>[1], opts: { hasYtdlp: boolean; ffplayError: string }) {
  const spawned: string[][] = []
  on('command.register', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: 1_000 }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  on('process.run', (_$, e) => {
    const [cmd] = e.argv
    const ok = (out: string) => ({ value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd.endsWith('yt-dlp') && !opts.hasYtdlp) return { deny: 'ENOENT' } as never
    if (cmd.endsWith('yt-dlp') && e.argv.includes('-g')) return ok('https://stream.example/a.m3u8\n') as never
    return ok('') as never
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    if (opts.ffplayError) yield { stream: 'stderr' as const, text: opts.ffplayError }
    return { value: { code: opts.ffplayError ? 1 : 0, signal: null } }
  } as never)
  return spawned
}

test('lastLine keeps the last non-empty line', () => {
  expect(lastLine('a\n\nHTTP error 403\n\n')).toBe('HTTP error 403')
  expect(lastLine('')).toBe('')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band offers play and composes with the bands beneath (${surface})`, async ($, on) => {
    engine(on, { hasYtdlp: true, ffplayError: '' })
    await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
    const ui = await $.ui.mount({ plugin: 'lofi-radio', surface, ...BAND } as never)
    expect(await ui.find({ key: 'fm-play' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
  })

  test(`play hands ffplay the resolved stream and shows its error (${surface})`, async ($, on) => {
    const spawned = engine(on, { hasYtdlp: true, ffplayError: 'HTTP error 403 Forbidden\n' })
    await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
    const ui = await $.ui.mount({ plugin: 'lofi-radio', surface, ...BAND } as never)
    await ui.press({ key: 'fm-play' })
    expect(spawned.length).toBe(1)
    expect(spawned[0]).toContain('https://stream.example/a.m3u8')
    expect(spawned[0]).toContain('-nodisp')
    expect(await ui.find({ type: 'Text', text: /HTTP error 403 Forbidden/ })).toBeDefined()
  })

  test(`a missing yt-dlp says how to install it (${surface})`, async ($, on) => {
    const spawned = engine(on, { hasYtdlp: false, ffplayError: '' })
    await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
    const ui = await $.ui.mount({ plugin: 'lofi-radio', surface, ...BAND } as never)
    await ui.press({ key: 'fm-play' })
    expect(spawned.length).toBe(0)
    expect(await ui.find({ type: 'Text', text: /brew install yt-dlp/ })).toBeDefined()
  })
}

test('the scene stays a small SVG and animates only while playing', () => {
  const on = scene(560, 252, { status: 'on', note: null, volume: 60, isWindow: false })
  const off = scene(560, 252, { status: 'off', note: null, volume: 60, isWindow: false })
  expect(on.length).toBeLessThan(131072)
  expect(on).toContain('CANLI · ses %60')
  expect(on).toContain('<g class="on"')
  expect(off).toContain('KAPALI')
  expect(off).not.toContain('<g class="on"')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the player pane changes the volume (${surface})`, async ($, on) => {
    engine(on, { hasYtdlp: true, ffplayError: '' })
    await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
    const ui = await $.ui.mount({ plugin: 'lofi-radio', surface, ...PANE } as never)
    expect(await ui.find({ key: 'fm-main' })).toBeDefined()
    await ui.press({ key: 'fm-up' })
    expect(await ui.find({ type: 'Text', text: /ses %70/ })).toBeDefined()
  })

  test(`the mini window plays the video in an ffplay window (${surface})`, async ($, on) => {
    const spawned = engine(on, { hasYtdlp: true, ffplayError: '' })
    await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
    const ui = await $.ui.mount({ plugin: 'lofi-radio', surface, ...PANE } as never)
    await ui.press({ key: 'fm-window' })
    expect(spawned.length).toBe(1)
    expect(spawned[0]).toContain('-alwaysontop')
    expect(spawned[0]).not.toContain('-nodisp')
  })
}
