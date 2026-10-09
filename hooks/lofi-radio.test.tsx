import { expect, mock, test } from 'claude-code/testing'

import { altText, cleanTrack, elapsed, lastLine, scene, stillPlaying, STRINGS } from './register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, bodyColumns: 100 } } as const
const PANE = {
  component: 'Pane',
  requestId: 'claude-fm',
  props: { title: 'Claude FM', isFocused: false, bodyColumns: 70, placement: 'dock' },
} as const
const EN = { options: { language: 'en' } }
const TR = { options: { language: 'tr' } }
const SURFACES = ['terminal', 'desktop'] as const

type Spawn = { stderr?: string; code?: number; hangMs?: number }
type World = { hasYtdlp?: boolean; spawn?: Spawn; clock?: { sleep: (ms: number) => Promise<void> } }

// The engine beneath the mod: yt-dlp answers an address, ffplay writes `stderr` and exits with `code`.
function engine(on: any, w: World = {}) {
  const calls = { spawned: [] as string[][], sh: 0, resolves: 0 }
  on('command.register', () => ({ value: undefined }) as never)
  if (!w.clock) on('clock.now', () => ({ value: 1_000 }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  on('process.run', (_$: any, e: any) => {
    const [cmd] = e.argv
    const ok = (out: string) => ({ value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (String(cmd).endsWith('yt-dlp') && w.hasYtdlp === false) return { deny: 'ENOENT' } as never
    if (cmd === '/bin/sh') calls.sh++
    if (String(cmd).endsWith('yt-dlp') && e.argv.includes('-g')) {
      calls.resolves++
      return ok('https://stream.example/a.m3u8\n') as never
    }
    return ok('') as never
  })
  on('process.spawn', async function* (_$: any, e: any) {
    calls.spawned.push([...e.argv])
    if (w.spawn?.stderr) yield { stream: 'stderr' as const, text: w.spawn.stderr }
    if (w.spawn?.hangMs && w.clock) await w.clock.sleep(w.spawn.hangMs)
    return { value: { code: w.spawn?.code ?? 0, signal: null } }
  } as never)
  return calls
}

async function start($: any, surface: (typeof SURFACES)[number], component: typeof BAND | typeof PANE) {
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  return $.ui.mount({ plugin: 'lofi-radio', surface, ...component } as never)
}

test('lastLine keeps the last non-empty line', () => {
  expect(lastLine('a\n\nHTTP error 403\n\n')).toBe('HTTP error 403')
  expect(lastLine('')).toBe('')
})

const RADIO = { status: 'on', note: null, volume: 60, isWindow: false, track: 'Astor — Forest Park', onSince: 0, minute: 42 } as const

test('the scene stays a small SVG and animates only while playing', () => {
  const on = scene(720, 320, { ...RADIO }, Array(50).fill(true), 0, true, STRINGS.en)
  const off = scene(560, 315, { ...RADIO, status: 'off', track: null, minute: 0 }, [], 0, false, STRINGS.en)
  expect(on.length).toBeLessThan(131072)
  expect(on).toContain('LIVE · 42 min')
  expect(on).toContain('Astor — Forest Park')
  expect(on).toContain('<g class="on"')
  expect(off).toContain('OFF')
  expect(off).toContain('<g class="off"')
  expect(scene(300, 190, { ...RADIO }, [], 0, false, STRINGS.tr)).toContain('CANLI · 42 dk')
})

test('track helpers clean titles and spot a changed track', () => {
  expect(cleanTrack('Kyle Preston', '01 - We Made It')).toBe('Kyle Preston — We Made It')
  expect(stillPlaying('Astor — Forest Park (Ft. Farnell Newton)', 'est Park (Ft. Farnell Newton')).toBe(true)
  expect(stillPlaying('Astor — Forest Park (Ft. Farnell Newton)', 'Ardley - 01 - Dawn Hour')).toBe(false)
  expect(stillPlaying('Siren and the Sea — 10 - The Large Floating Vessel', 'e Large Floating Vessel Sir')).toBe(true)
  expect(stillPlaying('Siren and the Sea — 10 - The Large Floating Vessel', 'Sea — 10 - The Lar')).toBe(true)
  expect(elapsed(75, STRINGS.en)).toBe('1 h 15 min')
  expect(elapsed(75, STRINGS.tr)).toBe('1 sa 15 dk')
  expect(altText({ ...RADIO }, 3, STRINGS.en)).toBe('Claude FM: LIVE · Astor — Forest Park · 42 min · vol 60% · 3 fish today')
})

for (const surface of SURFACES) {
  test(`the band offers play and composes with the bands beneath (${surface})`, EN, async ($, on) => {
    engine(on)
    const ui = await start($, surface, BAND)
    expect((await ui.find({ key: 'fm-play' }))?.props.label).toBe('♪ Play Claude FM')
    expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
  })

  test(`the band speaks Turkish when asked (${surface})`, TR, async ($, on) => {
    engine(on)
    const ui = await start($, surface, BAND)
    expect((await ui.find({ key: 'fm-play' }))?.props.label).toBe('♪ Claude FM çal')
  })

  test(`play hands ffplay the resolved stream and shows its error (${surface})`, EN, async ($, on) => {
    const calls = engine(on, { spawn: { stderr: 'Invalid data found when processing input\n', code: 1 } })
    const ui = await start($, surface, BAND)
    await ui.press({ key: 'fm-play' })
    expect(calls.spawned.length).toBe(1)
    expect(calls.spawned[0]).toContain('https://stream.example/a.m3u8')
    expect(calls.spawned[0]).toContain('-nodisp')
    expect(await ui.find({ type: 'Text', text: /Invalid data found/ })).toBeDefined()
  })

  test(`a stalled stream is resolved afresh, then reported (${surface})`, EN, async ($, on) => {
    const skips = 'Segment 1 of playlist 0 failed too many times, skipping\n'.repeat(3)
    const calls = engine(on, { spawn: { stderr: skips } })
    const ui = await start($, surface, BAND)
    await ui.press({ key: 'fm-play' })
    expect(calls.spawned.length).toBe(3)
    expect(calls.resolves).toBe(3)
    expect(await ui.find({ type: 'Text', text: /stream address expired/ })).toBeDefined()
  })

  test(`a player killed elsewhere (exit 123) is a stop, not an error (${surface})`, EN, async ($, on) => {
    engine(on, { spawn: { code: 123 } })
    const ui = await start($, surface, BAND)
    await ui.press({ key: 'fm-play' })
    expect(await ui.find({ key: 'fm-play' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude FM:/ })).toBeUndefined()
  })

  test(`a missing yt-dlp says how to install it (${surface})`, EN, async ($, on) => {
    const calls = engine(on, { hasYtdlp: false })
    const ui = await start($, surface, BAND)
    await ui.press({ key: 'fm-play' })
    expect(calls.spawned.length).toBe(0)
    expect(await ui.find({ type: 'Text', text: /brew install yt-dlp/ })).toBeDefined()
  })

  test(`the player pane steps the volume (${surface})`, EN, async ($, on) => {
    engine(on)
    const ui = await start($, surface, PANE)
    expect(await ui.find({ key: 'fm-main' })).toBeDefined()
    await ui.press({ key: 'fm-up' })
    await ui.press({ key: 'fm-up' })
    if (surface === 'desktop') expect(String((await ui.find({ type: 'Svg' }))?.props.alt)).toContain('vol 80%')
    else expect(await ui.find({ type: 'Text', text: /▮{8}▯{2}/ })).toBeDefined()
  })

  test(`the mini window plays the video in an ffplay window (${surface})`, EN, async ($, on) => {
    const calls = engine(on)
    const ui = await start($, surface, PANE)
    await ui.press({ key: 'fm-window' })
    expect(calls.spawned.length).toBe(1)
    expect(calls.spawned[0]).toContain('-alwaysontop')
    expect(calls.spawned[0]).not.toContain('-nodisp')
  })
}

// Regression: a stop right after play used to leave read timers running (and could
// leave the state "on" with nothing playing).
test('a stop right after play leaves no reads and no "on" behind', EN, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/h' })
  on('fs.exists', () => ({ value: true }) as never)
  const calls = engine(on, { clock, spawn: { hangMs: 10 * 3_600_000 } })
  const band = await start($, 'terminal', BAND)
  await band.press({ key: 'fm-play' })
  await band.press({ key: 'fm-stop' })
  await clock.advance(1_000)
  const before = calls.sh
  await clock.advance(30 * 60_000)
  expect(calls.sh).toBe(before)
  expect(await band.find({ key: 'fm-play' })).toBeDefined()
})
