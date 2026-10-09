import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { Radio } from '../types'

// The address /radio opens; it redirects to whatever the current YouTube live id is.
export const STREAM_URL = 'https://clau.de/radio'
// The stream has no audio-only format; 360p is the smallest one with AAC-LC audio.
const FORMAT = 'worst[height>=360]/worst'
const TITLE = 'Claude FM'
// pkill -f matches the joined argv, so ffplay's window title marks our player.
// No leading dash, or pkill would read the pattern as a flag.
const MARK = `window_title ${TITLE}`
// The desktop app's PATH may miss Homebrew, so each tool is tried there too.
const BIN_DIRS = ['', '/opt/homebrew/bin/', '/usr/local/bin/']
const PANE = 'claude-fm'
// A resolved HLS address lives for hours; reusing it makes volume changes quick.
const URL_TTL_MS = 30 * 60_000

const OFF: Radio = { status: 'off', note: null, volume: 60, isWindow: false }
const radio = atom({ plugin: 'lofi-radio', key: 'radio' } as const, OFF as Radio)

// Merging over OFF fills fields a value saved by an older version lacks.
const patch = ($: EngineInterface, change: Partial<Radio>) =>
  update($, radio, (prev): Radio => ({ ...OFF, ...prev, ...change }))
const current = async ($: EngineInterface): Promise<Radio> => ({ ...OFF, ...(await read($, radio)) })
const isLive = (s: Radio) => s.status === 'on' || s.status === 'tuning'

const found = new Map<string, string>()
let cached: { url: string; at: number } | null = null
let player: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null
// Bumped on every play and stop, so a stale player loop never overwrites newer state.
let generation = 0

async function bin($: EngineInterface, name: string, versionFlag: string) {
  const known = found.get(name)
  if (known) return known
  for (const dir of BIN_DIRS) {
    const path = dir + name
    const ok = await $.process.run([path, versionFlag], { timeoutMs: 10_000 }).then(
      r => r.exitCode === 0,
      () => false,
    )
    if (ok) {
      found.set(name, path)
      return path
    }
  }
  return null
}

// Last non-empty stderr line, short enough for the band.
export function lastLine(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 80)
}

async function streamUrl($: EngineInterface, ytdlp: string): Promise<{ url: string } | { error: string }> {
  const now = await $.clock.now()
  if (cached && now - cached.at < URL_TTL_MS) return { url: cached.url }
  const r = await $.process
    .run([ytdlp, '--no-update', '--no-warnings', '--no-playlist', '-f', FORMAT, '-g', STREAM_URL], { timeoutMs: 60_000 })
    .catch(() => null)
  const url = r?.exitCode === 0 ? (r.stdout.trim().split('\n')[0] ?? '') : ''
  if (!url) return { error: lastLine(r?.stderr ?? '') || 'yayın bulunamadı' }
  cached = { url, at: now }
  return { url }
}

async function killPlayers($: EngineInterface) {
  await $.process.run(['pkill', '-f', MARK]).catch(() => undefined)
}

async function play($: EngineInterface) {
  const id = ++generation
  await patch($, { status: 'tuning', note: null })

  const ytdlp = await bin($, 'yt-dlp', '--version')
  const ffplay = await bin($, 'ffplay', '-version')
  if (!ytdlp || !ffplay) {
    const missing = !ytdlp ? 'yt-dlp' : 'ffmpeg'
    if (id === generation) await patch($, { status: 'error', note: `${missing} yok: brew install ${missing}` })
    return
  }

  const stream = await streamUrl($, ytdlp)
  if (id !== generation) return
  if ('error' in stream) {
    await patch($, { status: 'error', note: stream.error })
    return
  }

  const { volume, isWindow } = await current($)
  const view = isWindow ? ['-x', '480', '-y', '270', '-alwaysontop'] : ['-nodisp', '-vn']
  // One stream at a time, also across sessions.
  await killPlayers($)
  const child = $.process.spawn({
    argv: [ffplay, ...view, '-loglevel', 'error', '-volume', String(volume), '-window_title', TITLE, stream.url],
  })
  player = child
  await patch($, { status: 'on', note: null })

  let stderr = ''
  let end: ProcessSpawnResult | null = null
  try {
    let step = await child.next()
    while (!step.done) {
      if (step.value.stream === 'stderr') stderr += step.value.text
      step = await child.next()
    }
    end = step.value
  } catch (error) {
    stderr += String(error)
  }
  if (id !== generation) return
  player = null
  const failed = end === null || (end.signal === null && end.code !== 0)
  // An expired address fails here; the next play resolves a fresh one.
  if (failed) cached = null
  await patch($, failed ? { status: 'error', note: lastLine(stderr) || 'ffplay durdu' } : { status: 'off', note: null })
}

async function stop($: EngineInterface) {
  generation++
  const child = player
  player = null
  void child?.return({ code: null, signal: 'SIGTERM' })
  await killPlayers($)
  await patch($, { status: 'off', note: null })
}

async function toggle($: EngineInterface) {
  if (isLive(await current($))) return stop($)
  void play($)
}

// Volume and window are ffplay flags, so a playing stream restarts with them.
async function restart($: EngineInterface) {
  if (!isLive(await current($))) return
  await stop($)
  void play($)
}

async function setVolume($: EngineInterface, volume: number) {
  await patch($, { volume: Math.max(10, Math.min(100, volume)) })
  await restart($)
}

async function toggleWindow($: EngineInterface) {
  const s = await current($)
  await patch($, { isWindow: !s.isWindow })
  if (isLive(s)) await restart($)
  else void play($)
}

const openPlayer = ($: EngineInterface) => void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

// --- the player scene: the stream's own look, a dotted range over water and
// Clawd fishing from a boat, drawn as one SVG. CSS animations run in it as an image.

const CLAY = '#D97757'
const INK = '#1F1E1D'
const MONO = "ui-monospace,'SF Mono',Menlo,monospace"

const SCENE_CSS = `<style>
.d{stroke:#d6d6d6;fill:none}
.on .bob{animation:bob 2.6s ease-in-out infinite alternate}@keyframes bob{to{transform:translateY(2px)}}
.on .w1{animation:sh 1.8s steps(2) infinite}.on .w2{animation:sh 1.8s steps(2) infinite -.9s}@keyframes sh{50%{opacity:.12}}
.on .tw,.on .live{animation:tw 1.6s ease-in-out infinite}@keyframes tw{50%{opacity:.15}}
.rip{opacity:0}.on .rip{transform-box:fill-box;transform-origin:center;animation:rip 2.6s ease-out infinite}
@keyframes rip{0%{transform:scale(.3);opacity:.8}100%{transform:scale(1.8);opacity:0}}
@media (prefers-reduced-motion: reduce){.on *{animation:none!important}}
</style>`

const ridge = (x: number, W: number, base: number, amp: number, seed: number) => {
  const t = (x / W) * Math.PI * 2
  return base - amp * (0.5 * Math.sin(t * 1.1 + seed) + 0.3 * Math.sin(t * 2.7 + seed * 1.9) + 0.2 * Math.sin(t * 6.3 + seed * 3.1))
}

// One path of horizontal runs, a row every `step` px: the dashed stroke turns
// them into the stream's scanline dots.
const rangePath = (W: number, top: number, bottom: number, base: number, amp: number, seed: number) => {
  let d = ''
  for (let y = top; y <= bottom; y += 4) {
    let start = -1
    for (let x = 0; x <= W; x += 3) {
      const inside = x < W && y >= ridge(x, W, base, amp, seed)
      if (inside && start < 0) start = x
      if (!inside && start >= 0) {
        d += `M${start} ${y}H${x}`
        start = -1
      }
    }
  }
  return d
}

type Px = [number, number, number, number, string]

// Pixel Clawd from agent-deck (DockCrab/Clawdy), on a 30×28 grid, with headphones.
const CLAWD: Px[] = [
  [7, 10, 16, 12, CLAY], [3, 14, 4, 4, CLAY], [23, 14, 4, 4, CLAY], [9, 12, 2, 2, INK], [19, 12, 2, 2, INK],
  [8, 6, 14, 1, '#55514C'], [7, 7, 1, 1, '#55514C'], [22, 7, 1, 1, '#55514C'], [6, 8, 1, 1, '#55514C'], [23, 8, 1, 1, '#55514C'],
  [4, 9, 3, 5, '#2B2A28'], [23, 9, 3, 5, '#2B2A28'], [5, 10, 1, 2, '#E8E2D8'], [24, 10, 1, 2, '#E8E2D8'],
]
// The hull hides the body's lower rows and the legs, so Clawd sits in the boat.
const HULL: Px[] = [
  [-2, 19, 34, 1, '#B07A45'], [-1, 20, 32, 1, '#8B5A2B'], [0, 21, 30, 1, '#8B5A2B'], [1, 22, 28, 1, '#74471F'], [3, 23, 24, 1, '#74471F'],
]
const px = (list: Px[]) => list.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('')

const fit = (s: string, max: number) => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

const STATUS_LABEL: Record<Radio['status'], string> = { on: 'CANLI', tuning: 'AÇILIYOR…', off: 'KAPALI', error: 'BAĞLANAMADI' }

export function scene(W: number, H: number, s: Radio): string {
  const wy = Math.round(H * 0.74)
  const far = rangePath(W, 20, wy - 6, H * 0.4, H * 0.26, 1.3)
  const near = rangePath(W, 50, wy - 4, H * 0.6, H * 0.11, 4.2)

  const water: string[] = []
  for (let i = 0, y = wy + 4; y < H - 4; i++, y += 5) {
    water.push(
      `<path class="d w${(i % 2) + 1}" d="M0 ${y}H${W}" stroke-width="1.4" stroke-dasharray="${1 + (i % 3)} ${5 + ((i * 7) % 11)}" stroke-dashoffset="${(i * 13) % 17}" opacity="${0.16 + (i % 3) * 0.08}"/>`,
    )
  }

  const stars: string[] = []
  for (let i = 0; i < 14; i++) {
    const x = (i * 97 + 31) % W
    const y = 8 + ((i * 53) % 34)
    if (y < ridge(x, W, H * 0.4, H * 0.26, 1.3) - 6) {
      stars.push(`<circle class="tw" cx="${x}" cy="${y}" r="0.9" fill="#e8e8e8" style="animation-delay:-${((i * 0.37) % 1.6).toFixed(2)}s"/>`)
    }
  }

  // Clawd's grid scaled by S, the hull's bottom row resting on the waterline.
  const S = Math.max(1.6, H / 95)
  const bx = Math.round(W * 0.47 - 15 * S)
  const by = wy + 2 - 24 * S
  const rodTipX = bx - 6 * S
  const boat = `<g class="bob"><g transform="translate(${bx},${by.toFixed(1)}) scale(${S})" shape-rendering="crispEdges">
${px(CLAWD)}<path d="M4 15L-6 -8" stroke="#bdbdbd" stroke-width=".5"/><path d="M-6 -8V23" stroke="#bdbdbd" stroke-width=".25" opacity=".7"/>${px(HULL)}
</g></g><ellipse class="rip" cx="${rodTipX.toFixed(1)}" cy="${wy + 3}" rx="5" ry="1.4" fill="none" stroke="#dcdcdc" stroke-width=".7"/>`

  const chars = Math.max(8, Math.floor((W * 0.6 - 24) / 7.2))
  const label = fit('♫  Claude FM — music for thinking and building', chars)
  const lw = Math.round(label.length * 7.2 + 24)
  const tag = `<rect x="${W - lw - 12}" y="12" width="${lw}" height="26" rx="3" fill="#1b1b1b" stroke="#363636"/>
<text x="${W - lw}" y="29.5" font-family="${MONO}" font-size="12" fill="#e8e8e8">${label}</text>`

  const statusText = s.status === 'on' ? `${STATUS_LABEL.on} · ses %${s.volume}` : STATUS_LABEL[s.status]
  const sw = Math.round(statusText.length * 6.6 + 34)
  const dot = s.status === 'off' ? '#8a8a8a' : s.status === 'tuning' ? '#e0b44c' : '#ff4e45'
  const status = `<g class="${s.status === 'off' ? '' : 'on'}"><rect x="12" y="${H - 34}" width="${sw}" height="22" rx="3" fill="#1b1b1b" stroke="#363636"/>
<circle class="live" cx="24" cy="${H - 23}" r="3.5" fill="${dot}"/>
<text x="34" y="${H - 19}" font-family="${MONO}" font-size="11" fill="#e8e8e8">${statusText}</text></g>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${SCENE_CSS}
<rect width="${W}" height="${H}" rx="10" fill="#141414"/>
<g class="${s.status === 'on' ? 'on' : ''}" opacity="${s.status === 'on' ? 1 : 0.6}">
${stars.join('')}
<path class="d" d="${far}" stroke-width="1.4" stroke-dasharray="2.2 1.8" opacity=".3"/>
<path class="d" d="${near}" stroke-width="1.6" stroke-dasharray="1.6 2.4" opacity=".55"/>
${water.join('')}
${boat}
</g>
${tag}
${status}
</svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, n) => {
    await $.command.register({ name: 'fm', description: 'Open the Claude FM player and play (/fm stop to stop)' })
    // A reload killed the old module's player; the shared state must not claim it still plays.
    if (!player) await patch($, { status: 'off', note: null })

    return n(e)
  })

  on('command.run', { command: 'fm' }, async ($, e) => {
    if (e.args.trim() === 'stop') {
      await stop($)
      return { text: 'Claude FM durdu.' }
    }
    openPlayer($)
    if (isLive(await current($))) return { text: 'Claude FM çalıyor.' }
    void play($)
    return { text: 'Claude FM açılıyor…' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await current($)
    const ui = $.ui.resolve(e)
    const { Box, Button, Link, Text } = ui

    const controls = (
      <Box key="fm-controls" flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
        <Button key="fm-main" variant="primary" label={isLive(s) ? '■ Durdur' : '▶ Çal'} onPress={() => void toggle($)} />
        <Button key="fm-down" label="−" onPress={() => void setVolume($, s.volume - 10)} />
        <Text dimColor>ses %{s.volume}</Text>
        <Button key="fm-up" label="+" onPress={() => void setVolume($, s.volume + 10)} />
        <Button key="fm-window" label={s.isWindow ? '▣ Pencereyi kapat' : '▣ Mini pencere'} onPress={() => void toggleWindow($)} />
      </Box>
    )
    const note = s.status === 'error' && s.note ? <Text key="fm-note" color="error">{s.note}</Text> : null
    const link = <Link key="fm-yt" href={STREAM_URL} label="YouTube'da aç" />

    if ('Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(300, Math.min(720, (e.props.bodyColumns || 60) * 8 - 8))
      const H = Math.round(Math.max(180, Math.min(300, W * 0.45)))
      return (
        <Box flexDirection="column" gap={1}>
          <Svg key="fm-scene" source={scene(W, H, s)} alt={`Claude FM: ${STATUS_LABEL[s.status]}`} width={W} height={H} />
          {controls}
          {note}
          {link}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text color="claude" bold>
          ♫ Claude FM
        </Text>
        <Text dimColor>music for thinking and building</Text>
        <Text dimColor>{'    .:.        .::.            .:.'}</Text>
        <Text dimColor>{'  .:::::.  .:::::::::.   .:. .:::::.'}</Text>
        <Text dimColor>{' ~ ~ ~ ~ ~ ~ ~ \\__/ ~ ~ ~ ~ ~ ~ ~ ~'}</Text>
        <Text color={s.status === 'on' ? 'claude' : undefined} dimColor={s.status !== 'on'}>
          ● {s.status === 'on' ? `CANLI · ses %${s.volume}` : STATUS_LABEL[s.status]}
        </Text>
        {controls}
        {note}
        {link}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, n) => {
    if (e.props.hasSurvey) return n(e)

    const s = await current($)
    const rest = await n(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const showPlayer = (
      <Button key="fm-open" label="Player" dimColor onPress={() => openPlayer($)} />
    )

    const row =
      s.status === 'on' ? (
        <Box key="fm" gap={1}>
          <Text>♪ Claude FM çalıyor</Text>
          {showPlayer}
          <Button key="fm-stop" label="Durdur" dimColor onPress={() => void stop($)} />
        </Box>
      ) : s.status === 'tuning' ? (
        <Box key="fm" gap={1}>
          <Text dimColor>♪ Claude FM açılıyor…</Text>
          <Button key="fm-stop" label="İptal" dimColor onPress={() => void stop($)} />
        </Box>
      ) : s.status === 'error' ? (
        <Box key="fm" gap={1}>
          <Text dimColor>♪ Claude FM: {s.note}</Text>
          <Button key="fm-play" label="Tekrar dene" dimColor onPress={() => void play($)} />
        </Box>
      ) : (
        <Box key="fm">
          <Button
            key="fm-play"
            label="♪ Claude FM çal"
            dimColor
            plain
            onPress={() => {
              void play($)
              openPlayer($)
            }}
          />
        </Box>
      )

    return (
      <Box flexDirection="column">
        {row}
        {rest}
      </Box>
    )
  })
}
