import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { Pond, Radio } from '../types'

// The address /radio opens; it redirects to whatever the current YouTube live id is.
export const STREAM_URL = 'https://clau.de/radio'
// The stream has no audio-only format; 360p is the smallest one with AAC-LC audio.
const FORMAT = 'worst[height>=360]/worst'
// 720p for reading the now-playing box: lower resolutions misread it.
const OCR_FORMAT = '95/best'
const TITLE = 'Claude FM'
// pkill -f matches the joined argv, so ffplay's window title marks our player.
// No leading dash, or pkill would read the pattern as a flag.
const MARK = `window_title ${TITLE}`
// The desktop app's PATH may miss Homebrew, so each tool is tried there too.
const BIN_DIRS = ['', '/opt/homebrew/bin/', '/usr/local/bin/']
const PANE = 'claude-fm'
const CHECK_MS = 90_000
const BACKOFF_MS = 300_000
// A resolved HLS address goes stale within minutes and ffplay then retries its 403s
// forever, so a stalled stream is resolved afresh this many times before giving up.
const MAX_RESTARTS = 2
const HEALTHY_MS = 120_000
// ffplay logs this when it gives up on a segment. A lone 403 is routine (keepalive
// retries recover); a run of skipped segments means no sound and a stale address.
const SKIP = /failed too many times, skipping/g
const STALL_SKIPS = 3
const STALL_WINDOW_MS = 30_000
// ffplay traps SIGINT and SIGTERM and exits 123, so another session's pkill is a stop, not a failure.
const FFPLAY_KILLED = 123
const NP_SOURCE = 'bin/nowplaying.swift'
const NP_VERSION = 1
// The Command Line Tools' own compiler; /usr/bin/swiftc is a shim that offers to install them.
const CLT_SWIFTC = '/Library/Developer/CommandLineTools/usr/bin/swiftc'

// --- language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English unless one of them says Turkish.

type Lang = 'en' | 'tr'

const EN = {
  live: 'LIVE',
  tuning: 'TUNING IN…',
  off: 'OFF',
  error: 'NO SIGNAL',
  boxTuning: 'tuning in…',
  boxOff: 'Claude FM · off',
  boxError: 'no signal',
  tagline: 'music for thinking and building',
  minutes: (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`),
  volume: (v: number) => `vol ${v}%`,
  volumeShort: 'vol',
  fishToday: (n: number) => `${n} fish today`,
  play: '▶ Play',
  stop: '■ Stop',
  cancel: '■ Cancel',
  retry: '↻ Retry',
  mini: '▣ Mini window',
  closeMini: '▣ Close window',
  unofficial: 'unofficial, not affiliated with Anthropic',
  bandPlay: '♪ Play Claude FM',
  bandTuning: '♪ Claude FM tuning in…',
  bandCancel: 'Cancel',
  bandRetry: 'Retry',
  player: 'Player',
  stopped: 'Claude FM stopped.',
  playing: 'Claude FM is playing.',
  starting: 'Claude FM tuning in…',
  missing: (tool: string) => `${tool} missing: brew install ${tool}`,
  notFound: 'stream not found',
  ffplayStopped: 'ffplay stopped',
  stalled: 'stream address expired',
  command: 'Open the Claude FM player and play (/lofi stop to stop)',
}
type Strings = typeof EN

const TR: Strings = {
  live: 'CANLI',
  tuning: 'AÇILIYOR…',
  off: 'KAPALI',
  error: 'BAĞLANAMADI',
  boxTuning: 'ayar çekiliyor…',
  boxOff: 'Claude FM · kapalı',
  boxError: 'bağlanamadı',
  tagline: 'music for thinking and building',
  minutes: m => (m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : `${m} dk`),
  volume: v => `ses %${v}`,
  volumeShort: 'ses',
  fishToday: n => `bugün ${n} balık`,
  play: '▶ Çal',
  stop: '■ Durdur',
  cancel: '■ İptal',
  retry: '↻ Tekrar dene',
  mini: '▣ Mini pencere',
  closeMini: '▣ Pencereyi kapat',
  unofficial: 'resmi değil, Anthropic ile bağı yok',
  bandPlay: '♪ Claude FM çal',
  bandTuning: '♪ Claude FM açılıyor…',
  bandCancel: 'İptal',
  bandRetry: 'Tekrar dene',
  player: 'Çalar',
  stopped: 'Claude FM durdu.',
  playing: 'Claude FM çalıyor.',
  starting: 'Claude FM açılıyor…',
  missing: tool => `${tool} yok: brew install ${tool}`,
  notFound: 'yayın bulunamadı',
  ffplayStopped: 'ffplay durdu',
  stalled: 'yayın adresi eskidi',
  command: 'Claude FM çaları aç ve çal (/lofi stop durdurur)',
}

export const STRINGS: Record<Lang, Strings> = { en: EN, tr: TR }

// Module scope is fine: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const t = () => STRINGS[lang]

const isTurkish = (v: unknown) => typeof v === 'string' && /^(tr([-_.]|$)|turk|türk)/i.test(v.trim())

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'tr') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return isTurkish(settings.language) ? 'tr' : 'en'
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return isTurkish(locale) ? 'tr' : 'en'
}

// --- state

const OFF: Radio = { status: 'off', note: null, volume: 60, isWindow: false, track: null, onSince: null, minute: 0 }
const radio = atom({ plugin: 'lofi-radio', key: 'radio' } as const, OFF as Radio)
const EMPTY_POND: Pond = { day: '', gold: [], lastAt: 0 }
const pond = atom({ plugin: 'lofi-radio', key: 'pond' } as const, EMPTY_POND as Pond)

// Merging over OFF fills fields a value saved by an older version lacks.
const patch = ($: EngineInterface, change: Partial<Radio>) =>
  update($, radio, (prev): Radio => ({ ...OFF, ...prev, ...change }))
const current = async ($: EngineInterface): Promise<Radio> => ({ ...OFF, ...(await read($, radio)) })
const isLive = (s: Radio) => s.status === 'on' || s.status === 'tuning'
const clampVolume = (v: number) => Math.max(10, Math.min(100, v))

const pad = (n: number) => String(n).padStart(2, '0')
export const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const todaysFish = async ($: EngineInterface): Promise<Pond> => {
  const p = { ...EMPTY_POND, ...(await read($, pond)) }
  const day = dayOf(await $.clock.now())
  return p.day === day ? p : { ...EMPTY_POND, day }
}

// Volume and window outlive the session; so does today's catch.
async function savePrefs($: EngineInterface) {
  const { volume, isWindow } = await current($)
  await $.store.set('prefs', { volume, isWindow }).catch(() => undefined)
}

async function restoreSaved($: EngineInterface) {
  const prefs = (await $.store.get('prefs').catch(() => undefined)) as Partial<Radio> | undefined
  if (prefs && typeof prefs.volume === 'number') {
    await patch($, { volume: clampVolume(prefs.volume), isWindow: prefs.isWindow === true })
  }
  const saved = (await $.store.get('pond').catch(() => undefined)) as Pond | undefined
  if (saved && Array.isArray(saved.gold) && saved.day === dayOf(await $.clock.now())) {
    await update($, pond, (): Pond => ({ ...EMPTY_POND, ...saved, lastAt: 0 }))
  }
}

// --- the player

const found = new Map<string, string>()
let player: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null
// Bumped on every play, restart and stop: a player loop whose number is old writes nothing.
let generation = 0
// One listen runs from play to stop and survives quiet restarts. Its timers and
// now-playing reads carry its number and stop as soon as it changes.
let listen = 0
let minuteTimer: Timer | null = null
let firstRead: Timer | null = null
let readTimer: Timer | null = null

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

// Always a fresh address: one resolved a few minutes ago already answers 403.
async function resolveUrl($: EngineInterface, ytdlp: string, format: string): Promise<{ url: string } | { error: string }> {
  const r = await $.process
    .run([ytdlp, '--no-update', '--no-warnings', '--no-playlist', '-f', format, '-g', STREAM_URL], { timeoutMs: 30_000 })
    .catch(() => null)
  const url = r?.exitCode === 0 ? (r.stdout.trim().split('\n')[0] ?? '') : ''
  return url ? { url } : { error: lastLine(r?.stderr ?? '') || t().notFound }
}

async function killPlayers($: EngineInterface) {
  await $.process.run(['pkill', '-f', MARK]).catch(() => undefined)
}

function stopTimers() {
  minuteTimer?.cancel()
  firstRead?.cancel()
  readTimer?.cancel()
  minuteTimer = firstRead = readTimer = null
  failures = 0
  isSlow = false
}

async function play($: EngineInterface) {
  const id = ++generation
  const l = ++listen
  stopTimers()
  rawTrack = null
  await patch($, { status: 'tuning', note: null, track: null })

  const ytdlp = await bin($, 'yt-dlp', '--version')
  const ffplay = await bin($, 'ffplay', '-version')
  if (id !== generation) return
  if (!ytdlp || !ffplay) {
    await patch($, { status: 'error', note: t().missing(!ytdlp ? 'yt-dlp' : 'ffmpeg') })
    return
  }

  const stream = await resolveUrl($, ytdlp, FORMAT)
  if (id !== generation) return
  if ('error' in stream) {
    await patch($, { status: 'error', note: stream.error })
    return
  }
  await runPlayer($, id, l, ffplay, stream.url, false, 0)
}

// Volume and window are ffplay flags. A playing stream restarts with them quietly: the old
// player keeps going while the new address resolves, then hands over within a second.
async function restart($: EngineInterface) {
  const s = await current($)
  if (s.status === 'tuning') return void play($)
  if (s.status !== 'on') return
  const ytdlp = found.get('yt-dlp')
  const ffplay = found.get('ffplay')
  if (!ytdlp || !ffplay) return void play($)
  const id = ++generation
  const stream = await resolveUrl($, ytdlp, FORMAT)
  if (id !== generation) return
  const old = player
  player = null
  void old?.return({ code: null, signal: 'SIGTERM' })
  if ('error' in stream) {
    await killPlayers($)
    return void play($)
  }
  await runPlayer($, id, listen, ffplay, stream.url, true, 0)
}

async function runPlayer($: EngineInterface, id: number, l: number, ffplay: string, url: string, isRestart: boolean, restarts: number) {
  const s = await current($)
  const view = s.isWindow ? ['-x', '480', '-y', '270', '-alwaysontop'] : ['-nodisp', '-vn']
  // One stream at a time, also across sessions.
  await killPlayers($)
  if (id !== generation) return
  const child = $.process.spawn({
    argv: [ffplay, ...view, '-loglevel', 'warning', '-volume', String(s.volume), '-window_title', TITLE, url],
  })
  player = child
  const spawnedAt = await $.clock.now()

  if (!isRestart) {
    const startedAt = spawnedAt
    if (id !== generation) return
    // Checked inside the updater too: a retried write must not put "on" back over a stop's "off".
    await update($, radio, (prev): Radio =>
      id === generation ? { ...OFF, ...prev, status: 'on', note: null, onSince: startedAt, minute: 0 } : { ...OFF, ...prev })
    if (id !== generation) return
    startTimers($, l)
  }

  let stderr = ''
  let end: ProcessSpawnResult | null = null
  let isStalled = false
  let skips: number[] = []
  try {
    let step = await child.next()
    while (!step.done) {
      if (step.value.stream === 'stderr') {
        stderr = (stderr + step.value.text).slice(-4_000)
        const skipped = step.value.text.match(SKIP)?.length ?? 0
        if (skipped) {
          const now = await $.clock.now()
          skips = [...skips, ...Array<number>(skipped).fill(now)].filter(at => now - at < STALL_WINDOW_MS)
          if (skips.length >= STALL_SKIPS) {
            isStalled = true
            void child.return({ code: null, signal: 'SIGTERM' })
            break
          }
        }
      }
      step = await child.next()
    }
    if (step.done) end = step.value
  } catch (error) {
    stderr += String(error)
  }
  if (id !== generation) return
  player = null

  if (isStalled) {
    // ffplay would retry the dead address forever: make sure it is gone, then resolve afresh.
    await killPlayers($)
    const ytdlp = found.get('yt-dlp')
    // A stream that played for a while before stalling gets a fresh budget.
    const budget = (await $.clock.now()) - spawnedAt > HEALTHY_MS ? 0 : restarts
    if (budget < MAX_RESTARTS && ytdlp) {
      const stream = await resolveUrl($, ytdlp, FORMAT)
      if (id !== generation) return
      if (!('error' in stream)) return runPlayer($, id, l, ffplay, stream.url, true, budget + 1)
    }
  }

  const wasKilled = end !== null && (end.signal !== null || end.code === FFPLAY_KILLED)
  const failed = isStalled || (!wasKilled && (end === null || end.code !== 0))
  // The listen is over: its timers and any read still running stop here.
  listen++
  stopTimers()
  await patch($, failed
    ? { status: 'error', note: isStalled ? t().stalled : lastLine(stderr) || t().ffplayStopped, onSince: null, minute: 0 }
    : { status: 'off', note: null, track: null, onSince: null, minute: 0 })
}

async function stop($: EngineInterface) {
  generation++
  listen++
  stopTimers()
  rawTrack = null
  const child = player
  player = null
  void child?.return({ code: null, signal: 'SIGTERM' })
  await killPlayers($)
  await patch($, { status: 'off', note: null, track: null, onSince: null, minute: 0 })
}

async function toggle($: EngineInterface) {
  if (isLive(await current($))) return stop($)
  void play($)
}

// Read and write in one update, so two quick presses both count.
async function stepVolume($: EngineInterface, delta: number) {
  let changed = false
  await update($, radio, (prev): Radio => {
    const s = { ...OFF, ...prev }
    const volume = clampVolume(s.volume + delta)
    changed = volume !== s.volume
    return { ...s, volume }
  })
  if (!changed) return
  await savePrefs($)
  await restart($)
}

async function toggleWindow($: EngineInterface) {
  const next = await update($, radio, (prev): Radio => {
    const s = { ...OFF, ...prev }
    return { ...s, isWindow: !s.isWindow }
  })
  await savePrefs($)
  if (isLive({ ...OFF, ...next })) await restart($)
  else void play($)
}

const openPlayer = ($: EngineInterface) => void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

// --- now playing: the track name exists only burned into the video's top-right box.
// A compiled macOS Vision helper reads a 28 s burst of that crop and stitches the marquee.

const CROP = 'crop=iw*0.2219:ih*0.0611:iw*0.7438:ih*0.0347,scale=852:132:flags=lanczos,format=gray'
// perl alarm + exec is a hard wall clock around ffmpeg, which otherwise retries a 403 forever.
const FULL_SH = `/usr/bin/perl -e 'alarm 30; exec @ARGV' "$3" -nostdin -loglevel error -live_start_index -14 -i "$1" -an -t 28 -vf 'fps=2,${CROP}' -f rawvideo -pix_fmt gray - 2>/dev/null | "$2" --raw 852 132`
const CHECK_SH = `/usr/bin/perl -e 'alarm 15; exec @ARGV' "$3" -nostdin -loglevel error -i "$1" -an -frames:v 1 -vf '${CROP}' -f rawvideo -pix_fmt gray - 2>/dev/null | "$2" --raw 852 132 --debug`
// Compiles to a temporary name first, so a timed-out build never passes for a finished one.
const COMPILE_SH = 'mkdir -p "$4" && "$1" -O "$2" -o "$3.$$.tmp" && mv "$3.$$.tmp" "$3"'

let helper: Promise<string | null> | null = null
// The marquee's own text ("Artist — 01 - Title"), which one-frame checks are matched against.
let rawTrack: string | null = null
// The listen whose read is running, so a stale read never blocks or is blamed on a new one.
let readingListen: number | null = null
let failures = 0
let isSlow = false

// A real compiler only: never the /usr/bin shim, which would open an install dialog.
async function findSwiftc($: EngineInterface) {
  if (await $.fs.exists(CLT_SWIFTC).catch(() => false)) return CLT_SWIFTC
  const r = await $.process.run(['/usr/bin/xcode-select', '-p'], { timeoutMs: 5_000 }).catch(() => null)
  const dev = r?.exitCode === 0 ? r.stdout.trim() : ''
  if (!dev) return null
  for (const path of [`${dev}/usr/bin/swiftc`, `${dev}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc`]) {
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return null
}

// Compiled once per machine into ~/.cache; without a compiler the feature stays off.
function nowPlayingHelper($: EngineInterface) {
  helper ??= (async () => {
    const home = await $.env.get('HOME')
    if (!home) return null
    const dir = `${home}/.cache/lofi-radio`
    const out = `${dir}/nowplaying-v${NP_VERSION}`
    if (await $.fs.exists(out).catch(() => false)) return out
    const swiftc = await findSwiftc($)
    if (!swiftc) return null
    const r = await $.process
      .run(['/bin/sh', '-c', COMPILE_SH, 'sh', swiftc, `${$.plugin.root}/${NP_SOURCE}`, out, dir], { timeoutMs: 180_000 })
      .catch(() => null)
    return r?.exitCode === 0 ? out : null
  })()
  return helper
}

const norm = (s: string) => s.toLowerCase().replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim()

// "Kyle Preston — 01 - We Made It" shows as "Kyle Preston — We Made It".
export function cleanTrack(artist: string, title: string): string {
  const t = title.replace(/^\d{1,2}\s*-\s*/, '').trim()
  return artist ? `${artist.trim()} — ${t}` : t
}

// True when a one-frame fragment still fits inside the known track's looping marquee.
export function stillPlaying(track: string, fragment: string): boolean {
  const f = norm(fragment)
  const inner = f.length > 8 ? f.slice(1, -1) : f
  return inner.length >= 4 && norm(`${track} ${track}`).includes(inner)
}

type HelperOut = { track?: string; artist?: string; title?: string; complete?: boolean; fragments?: string[] }
function parseHelper(stdout: string | undefined): HelperOut | null {
  try {
    return stdout ? (JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as HelperOut) : null
  } catch {
    return null
  }
}

async function readTrack($: EngineInterface, l: number, full: boolean) {
  if (l !== listen || readingListen === l) return
  readingListen = l
  try {
    const [helperPath, ytdlp, ffmpeg] = await Promise.all([
      nowPlayingHelper($),
      bin($, 'yt-dlp', '--version'),
      bin($, 'ffmpeg', '-version'),
    ])
    // Missing tools turn the feature off; that is not a miss.
    if (l !== listen || !helperPath || !ytdlp || !ffmpeg) return
    const ocr = await resolveUrl($, ytdlp, OCR_FORMAT)
    if (l !== listen) return
    if ('error' in ocr) return fail($, l)

    const known = (await current($)).track
    if (!full && known && rawTrack) {
      const r = await $.process.run(['/bin/sh', '-c', CHECK_SH, 'sh', ocr.url, helperPath, ffmpeg], { timeoutMs: 25_000 }).catch(() => null)
      if (l !== listen) return
      const fragment = parseHelper(r?.stdout)?.fragments?.[0] ?? ''
      if (!fragment) return fail($, l)
      if (stillPlaying(rawTrack, fragment)) return recovered($, l)
    }

    const r = await $.process.run(['/bin/sh', '-c', FULL_SH, 'sh', ocr.url, helperPath, ffmpeg], { timeoutMs: 45_000 }).catch(() => null)
    if (l !== listen) return
    const out = parseHelper(r?.stdout)
    if (!out?.complete) return fail($, l)
    recovered($, l)
    rawTrack = out.track ?? null
    const track = cleanTrack(out.artist ?? '', out.title ?? '')
    await update($, radio, (prev): Radio => (l === listen ? { ...OFF, ...prev, track } : { ...OFF, ...prev }))
  } finally {
    if (readingListen === l) readingListen = null
  }
}

function setCadence($: EngineInterface, l: number, ms: number) {
  readTimer?.cancel()
  readTimer = $.clock.every(ms, () => void readTrack($, l, false))
}

// Three misses in a row slow the checks to every five minutes; the last known track stays shown.
function fail($: EngineInterface, l: number) {
  if (l !== listen || !readTimer) return
  failures++
  if (failures >= 3 && !isSlow) {
    isSlow = true
    setCadence($, l, BACKOFF_MS)
  }
}

function recovered($: EngineInterface, l: number) {
  failures = 0
  if (isSlow && l === listen && readTimer) {
    isSlow = false
    setCadence($, l, CHECK_MS)
  }
}

function startTimers($: EngineInterface, l: number) {
  stopTimers()
  minuteTimer = $.clock.every(60_000, () => {
    void (async () => {
      if (l !== listen) return
      const s = await current($)
      if (s.status === 'on' && s.onSince !== null) {
        const minute = Math.floor(((await $.clock.now()) - s.onSince) / 60_000)
        if (l === listen) await patch($, { minute })
      }
    })()
  })
  firstRead = $.clock.after(5_000, () => void readTrack($, l, true))
  setCadence($, l, CHECK_MS)
}

// --- the player scene: a small window onto the stream. Dot-matrix sky, ranges and
// treeline, drifting water and Clawd fishing from a boat, drawn as one SVG. At most
// three slow loops move (water drift, boat bob, status dot) and only while playing.

const CLAY = '#D97757'
const INK = '#1E1E1E'
const MONO = "ui-monospace,'SF Mono',Menlo,monospace"

type Px = [number, number, number, number, string]
const px = (list: Px[]) => list.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('')

// Pixel Clawd after johnnyvizz's savvy-progress (MIT, see LICENSE) by way of agent-deck,
// posed for the stream: rod in the left claw, the hull hiding his legs. The character is Anthropic's.
const BODY: Px[] = [[7, 10, 16, 12, CLAY], [3, 14, 4, 4, CLAY], [23, 14, 4, 4, CLAY]]
const EYES: Record<Radio['status'], Px[]> = {
  on: [[9, 12, 2, 2, INK], [19, 12, 2, 2, INK]],
  tuning: [[9, 12, 2, 2, INK], [19, 12, 2, 2, INK]],
  off: [[9, 13, 2, 1, INK], [19, 13, 2, 1, INK]],
  error: [
    [8, 11, 1, 1, INK], [10, 11, 1, 1, INK], [9, 12, 1, 1, INK], [8, 13, 1, 1, INK], [10, 13, 1, 1, INK],
    [18, 11, 1, 1, INK], [20, 11, 1, 1, INK], [19, 12, 1, 1, INK], [18, 13, 1, 1, INK], [20, 13, 1, 1, INK],
  ],
}
const SLEEP_Z: Px[] = [[24, 4, 3, 1, '#8A8A8A'], [25, 5, 1, 1, '#8A8A8A'], [24, 6, 3, 1, '#8A8A8A']]
const ROD: Px[] = [[4, 4, 1, 10, '#9390B9'], [3, 3, 2, 1, '#E8E8E8']]
const HULL: Px[] = [
  [-3, 18, 3, 1, '#B07A45'], [30, 18, 3, 1, '#B07A45'],
  [-2, 19, 34, 1, '#B07A45'], [-1, 20, 32, 1, '#8B6123'], [0, 21, 30, 1, '#8B6123'], [1, 22, 28, 1, '#6D4119'], [3, 23, 24, 1, '#6D4119'],
]
// 5×3, facing left; gold for a turn of ten minutes or more.
const fishPx = (x: number, y: number, gold: boolean): Px[] => {
  const body = gold ? '#F0A27F' : '#6699D4'
  const tail = gold ? '#D9825F' : '#4D7FBF'
  return [[x + 1, y, 2, 1, body], [x, y + 1, 4, 1, body], [x + 1, y + 2, 2, 1, body], [x + 4, y, 1, 3, tail], [x + 1, y + 1, 1, 1, INK]]
}
const FISH_SPOTS = [[28, 16], [33, 16], [30.5, 13], [35.5, 13]] as const
// A 9×9 pixel ♫.
const NOTE: Px[] = [[2, 0, 7, 2, CLAY], [2, 2, 1, 5, CLAY], [8, 2, 1, 4, CLAY], [0, 6, 3, 3, CLAY], [6, 5, 3, 3, CLAY]]

const ridge = (x: number, W: number, base: number, amp: number, seed: number) => {
  const t = (x / W) * Math.PI * 2
  return base - amp * (0.5 * Math.sin(t * 1.1 + seed) + 0.3 * Math.sin(t * 2.7 + seed * 1.9) + 0.2 * Math.sin(t * 6.3 + seed * 3.1))
}
// Deterministic 0..1 noise, so the same size always draws the same scene.
const noise = (i: number, seed: number) => {
  const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453
  return s - Math.floor(s)
}
const f1 = (n: number) => Math.round(n * 10) / 10

export const fit = (s: string, max: number) => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

export const elapsed = (minute: number, ts: Strings = t()) => ts.minutes(minute)
const statusLabel = (status: Radio['status'], ts: Strings) => ({ on: ts.live, tuning: ts.tuning, off: ts.off, error: ts.error })[status]
const ROOT_CLASS: Record<Radio['status'], string> = { on: 'on', tuning: 'tune', off: 'off', error: 'err' }

export function altText(s: Radio, fishCount: number, ts: Strings = t()): string {
  const parts = [`Claude FM: ${statusLabel(s.status, ts)}`]
  if (s.status === 'on' && s.track) parts.push(s.track)
  if (s.status === 'on') parts.push(elapsed(s.minute, ts))
  parts.push(ts.volume(s.volume))
  if (fishCount > 0) parts.push(ts.fishToday(fishCount))
  if (s.status === 'error' && s.note) parts.push(s.note)
  return parts.join(' · ')
}

export function scene(W: number, H: number, s: Radio, gold: boolean[], now: number, popFish = false, ts: Strings = t()): string {
  const k = W / 480
  const p = Math.max(3, Math.round(3.3 * k))
  const S = Math.max(2, Math.round(H / 95))
  const wy = Math.round(H * 0.74)
  const phase = (period: number) => `animation-delay:-${((now % period) / 1000).toFixed(2)}s`

  const css = `<style>
.on .w{animation:drift 24s linear infinite}.on .wr{animation:drift 24s linear infinite reverse}
@keyframes drift{to{stroke-dashoffset:-24}}
.on .bob{animation:bob 6s infinite}@keyframes bob{0%,49.9%{transform:translateY(0)}50%,100%{transform:translateY(1px)}}
.on .dot{animation:breathe 4s ease-in-out infinite}.tune .dot{animation:breathe 1.2s ease-in-out infinite}
@keyframes breathe{50%{opacity:.5}}
.tune .seg{animation:slide 1.6s ease-in-out infinite alternate}@keyframes slide{to{transform:translateX(${f1((W - 24) * 0.7)}px)}}
.pop{transform-box:fill-box;transform-origin:center;animation:pop .6s ease-out both}@keyframes pop{from{transform:scale(.6)}}
@media (prefers-color-scheme: light){.card{stroke:rgba(0,0,0,.10)}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}
</style>`

  const defs = `<defs>
<pattern id="p0" width="${2 * p}" height="${2 * p}" patternUnits="userSpaceOnUse"><rect x="${p}" y="${p}" width="1" height="1" fill="#5C5C5C"/></pattern>
<pattern id="p1" width="${p}" height="${p}" patternUnits="userSpaceOnUse"><rect x="1" y="1" width="1" height="1" fill="#8B8B8B"/></pattern>
<pattern id="p2" width="${2 * p}" height="${2 * p}" patternUnits="userSpaceOnUse"><rect y="1" width="${2 * p}" height="${f1(0.4 * p)}" fill="#B8B8B8"/><rect x="1" y="${p + 1}" width="1" height="1" fill="#8B8B8B"/><rect x="${p + 1}" y="${p + 1}" width="1" height="1" fill="#8B8B8B"/></pattern>
<pattern id="p3" width="${2 * p}" height="${2 * p}" patternUnits="userSpaceOnUse"><rect y="1" width="${f1(1.6 * p)}" height="${f1(0.45 * p)}" fill="#D0D0D0"/></pattern>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".6" stop-color="#000"/></linearGradient>
<mask id="mfade" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#fade)"/></mask>
<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient>
<clipPath id="card"><rect width="${W}" height="${H}" rx="10"/></clipPath>
</defs>`

  // Each shape is laid opaque first, so nearer layers hide farther ones.
  const layer = (d: string, fill: string, bright?: string) =>
    `<path d="${d}" fill="${INK}"/><path d="${d}" fill="url(#${fill})"/>${bright ? `<path d="${d}" fill="url(#${bright})" mask="url(#mfade)"/>` : ''}`

  const stars: string[] = []
  for (let i = 0; i < 18; i++) {
    const x = Math.round(noise(i, 1) * W)
    const y = Math.round(noise(i, 2) * H * 0.28)
    stars.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="#8B8B8B"/>`)
  }

  // The stream's big bright cloud bank hangs from the top left.
  const cw = W * 0.55
  const ch = H * 0.3
  let cloud = `M0 0H${f1(cw)}`
  for (let x = cw; x >= 0; x -= 6) {
    const env = 1 - (x / cw) ** 2
    cloud += `L${f1(x)} ${f1(ch * env * (0.8 + 0.2 * Math.sin(x * 0.025 + 1.3)))}`
  }
  cloud += 'Z'

  let far = `M0 ${wy}`
  for (let x = 0; x <= W; x += 4) far += `L${x} ${f1(ridge(x, W, H * 0.45, H * 0.2, 1.3))}`
  far += `L${W} ${wy}Z`

  // Pines: seeded spikes along 0.66H.
  const base = H * 0.66
  let trees = `M0 ${wy}L0 ${f1(base)}`
  for (let x = 0, i = 0; x < W; i++) {
    const step = (5 + noise(i, 3) * 7) * k
    const h = (6 + noise(i, 4) * 16) * k
    trees += `L${f1(x + step / 2)} ${f1(base - h)}L${f1(x + step)} ${f1(base)}`
    x += step
  }
  trees += `L${W} ${wy}Z`

  const water: string[] = []
  const rows = 12
  const gap = (H - 30 - (wy + 4)) / (rows - 1)
  for (let i = 0; i < rows; i++) {
    const y = f1(wy + 4 + i * gap)
    const opacity = (0.14 + (0.24 * i) / (rows - 1)).toFixed(2)
    water.push(
      `<path class="${i % 2 ? 'wr' : 'w'}" style="${phase(24_000)}" d="M0 ${y}H${W}" stroke="#D6D6D6" stroke-width="1.2" stroke-dasharray="${1 + (i % 3)} ${4 + ((i * 7) % 9)}" stroke-dashoffset="${(i * 13) % 17}" opacity="${opacity}" fill="none"/>`,
    )
  }

  // Clawd's grid scaled by S: hull centred on x 0.5W, its bottom row on 0.85H.
  const bx = Math.round(W * 0.5 - 15 * S)
  const by = Math.round(H * 0.85 - 24 * S)
  const shown = gold.slice(-4)
  const fish = shown.flatMap((g, i) => fishPx(FISH_SPOTS[i]![0], FISH_SPOTS[i]![1], g))
  const lastFish = shown.length ? fishPx(FISH_SPOTS[shown.length - 1]![0], FISH_SPOTS[shown.length - 1]![1], shown.at(-1)!) : []
  const fishSvg = popFish && shown.length
    ? px(fish.slice(0, -lastFish.length)) + `<g class="pop">${px(lastFish)}</g>`
    : px(fish)
  const more = gold.length > 4
    ? `<text x="${bx + 41.5 * S}" y="${by + 15.5 * S}" font-family="${MONO}" font-size="10" fill="#8B8B8B">+${gold.length - 4}</text>`
    : ''
  const line = `<path d="M3.5 3.5L-1.5 3.5V${f1((wy - by) / S + 1)}" stroke="#E8E8E8" stroke-width=".3" opacity=".6" fill="none"/>`
  const boat = `<g class="bob" style="${phase(6_000)}"><g transform="translate(${bx},${by}) scale(${S})" shape-rendering="crispEdges">
${line}${px(ROD)}${px(BODY)}${px(EYES[s.status])}${s.status === 'off' ? px(SLEEP_Z) : ''}${px(HULL)}${fishSvg}
</g>${more}</g>`

  // Now-playing box, top right.
  const label =
    s.status === 'on' && s.track ? { text: s.track, color: '#D6D6D6' }
    : s.status === 'on' ? { text: `Claude FM — ${ts.tagline}`, color: '#8F8F8F' }
    : s.status === 'tuning' ? { text: ts.boxTuning, color: '#E0B44C' }
    : s.status === 'error' ? { text: s.note ?? ts.boxError, color: '#FF8A80' }
    : { text: ts.boxOff, color: '#7A7A7A' }
  const maxChars = Math.floor((W * 0.62 - 38) / 7.2)
  const text = fit(label.text, maxChars)
  const bw = Math.round(Math.min(W * 0.62, text.length * 7.2 + 38))
  const boxX = W - 12 - bw
  const boxStroke = s.status === 'error' ? 'stroke="#FF4E45" stroke-opacity=".6"' : 'stroke="#FFFFFF" stroke-opacity=".08"'
  const box = `<rect x="${boxX}" y="12" width="${bw}" height="26" rx="3" fill="#131313" fill-opacity=".92" ${boxStroke}/>
<g transform="translate(${boxX + 10},20.5)" shape-rendering="crispEdges">${px(NOTE)}</g>
<text x="${boxX + 26}" y="29.5" font-family="${MONO}" font-size="12" fill="${label.color}">${esc(text)}</text>`

  // YouTube-style live bar.
  const barW = W - 24
  const bar =
    s.status === 'on' ? `<rect x="12" y="${H - 24}" width="${barW}" height="3" rx="1.5" fill="#FF0033"/><circle cx="${W - 12}" cy="${H - 22.5}" r="5" fill="#FF0033"/>`
    : s.status === 'tuning' ? `<rect x="12" y="${H - 24}" width="${barW}" height="3" rx="1.5" fill="#FFFFFF" fill-opacity=".15"/><rect class="seg" x="12" y="${H - 24}" width="${f1(barW * 0.3)}" height="3" rx="1.5" fill="#E0B44C"/>`
    : s.status === 'error' ? `<line x1="12" y1="${H - 22.5}" x2="${W - 12}" y2="${H - 22.5}" stroke="#7A2A26" stroke-width="3" stroke-dasharray="6 4"/>`
    : `<rect x="12" y="${H - 24}" width="${barW}" height="3" rx="1.5" fill="#FFFFFF" fill-opacity=".12"/>`

  // Info row: status and listening time left, catch and volume right.
  const dotColor = s.status === 'on' ? '#FF4E45' : s.status === 'tuning' ? '#E0B44C' : s.status === 'error' ? '#FF4E45' : '#8A8A8A'
  const statusText = s.status === 'on' ? `${ts.live} · ${elapsed(s.minute, ts)}` : statusLabel(s.status, ts)
  const meterRight = W - 12 - 20
  const meter: string[] = []
  for (let i = 0; i < 10; i++) {
    const h = 3 + (i * 5) / 9
    const x = meterRight - 38 + i * 4
    meter.push(`<rect x="${x}" y="${f1(H - 8 - h)}" width="2" height="${f1(h)}" fill="#FFFFFF" fill-opacity="${i < s.volume / 10 ? 1 : 0.18}"/>`)
  }
  const catchText = gold.length > 0 && s.status !== 'off' && W >= 360
    ? `<text x="${meterRight - 46}" y="${H - 8}" text-anchor="end" font-family="${MONO}" font-size="10" fill="#8B8B8B">&gt;&lt;&gt; ×${gold.length}</text>`
    : ''
  const info = `<circle class="dot" style="${phase(s.status === 'tuning' ? 1_200 : 4_000)}" cx="18" cy="${H - 12}" r="3.5" fill="${dotColor}"/>
<text x="28" y="${H - 8}" font-family="${MONO}" font-size="11" fill="#E8E8E8">${statusText}</text>
${catchText}${meter.join('')}
<text x="${W - 12}" y="${H - 8}" text-anchor="end" font-family="${MONO}" font-size="10" fill="#8B8B8B">${s.volume}</text>`

  const sceneOpacity = { on: 1, tuning: 0.6, off: 0.55, error: 0.45 }[s.status]

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${css}${defs}
<rect class="card" width="${W}" height="${H}" rx="10" fill="${INK}" stroke="none"/>
<g class="${ROOT_CLASS[s.status]}" clip-path="url(#card)">
<g opacity="${sceneOpacity}">
${stars.join('')}
${layer(cloud, 'p1', 'p3')}
${layer(far, 'p1', 'p3')}
<g opacity=".75">${layer(trees, 'p2')}</g>
${water.join('')}
${boat}
</g>
<rect y="${H - 44}" width="${W}" height="44" fill="url(#scrim)"/>
${box}
${bar}
${info}
</g>
</svg>`
}

export const register: Register = (on, options) => {
  // The option may arrive as a boolean or as its string form.
  const isPlayButtonShown = options.playButton !== false && options.playButton !== 'false'

  on('session.start', async ($, e, n) => {
    lang = await detectLang($, options.language)
    await $.command.register({ name: 'lofi', description: t().command })
    // A reload killed the old module's player; the shared state must not claim it still plays.
    if (!player) await patch($, { status: 'off', note: null, track: null, onSince: null, minute: 0 })
    await restoreSaved($)

    return n(e)
  })

  // One fish per finished main-loop turn while the radio plays. The store is the
  // count of record, so sessions on the same day add to one catch.
  on('turn.complete', async ($, e, n) => {
    if (!e.agentId && e.reason === 'answer' && (await current($)).status === 'on') {
      const now = await $.clock.now()
      const day = dayOf(now)
      const saved = (await $.store.get('pond').catch(() => undefined)) as Pond | undefined
      const base = saved && saved.day === day && Array.isArray(saved.gold) ? saved.gold : []
      const next: Pond = { day, gold: [...base, e.durationMs >= 600_000].slice(-500), lastAt: now }
      await $.store.set('pond', next).catch(() => undefined)
      await update($, pond, (): Pond => next)
    }

    return n(e)
  })

  on('command.run', { command: 'lofi' }, async ($, e) => {
    if (e.args.trim() === 'stop') {
      await stop($)
      return { text: t().stopped }
    }
    openPlayer($)
    if (isLive(await current($))) return { text: t().playing }
    void play($)
    return { text: t().starting }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await current($)
    const fish = await todaysFish($)
    const now = await $.clock.now()
    const ts = t()
    const ui = $.ui.resolve(e)
    const { Box, Button, Link, Text } = ui
    const W = Math.max(300, Math.min(720, (e.props.bodyColumns || 60) * 8 - 8))

    const main = { on: ts.stop, tuning: ts.cancel, off: ts.play, error: ts.retry }[s.status]
    const controls = (
      <Box key="fm-controls" flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
        <Button key="fm-main" variant="primary" hotkey="p" label={main} onPress={() => void toggle($)} />
        <Button key="fm-down" hotkey="j" label="−" dimColor={s.volume <= 10} onPress={() => void stepVolume($, -10)} />
        <Button key="fm-up" hotkey="k" label="+" dimColor={s.volume >= 100} onPress={() => void stepVolume($, 10)} />
        <Button
          key="fm-window"
          hotkey="m"
          label={W < 420 ? '▣' : s.isWindow ? ts.closeMini : ts.mini}
          onPress={() => void toggleWindow($)}
        />
        <Link key="fm-yt" href={STREAM_URL} label="YouTube ↗" />
      </Box>
    )
    const note = s.status === 'error' && s.note ? <Text key="fm-note" color="error">{s.note}</Text> : null
    const foot = <Text key="fm-foot" dimColor>{ts.unofficial}</Text>

    // The terminal's table may still name Svg; only the remote surfaces draw it.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const H = Math.round(Math.max(190, Math.min(320, W * 0.5625)))
      const isNewFish = now - fish.lastAt < 2_000
      return (
        <Box flexDirection="column" gap={1}>
          <Svg key="fm-scene" source={scene(W, H, s, fish.gold, now, isNewFish, ts)} alt={altText(s, fish.gold.length, ts)} width={W} height={H} />
          {controls}
          {note}
          {foot}
        </Box>
      )
    }

    const meter = '▮'.repeat(s.volume / 10) + '▯'.repeat(10 - s.volume / 10)
    const status = [s.status === 'on' ? `${ts.live} · ${elapsed(s.minute, ts)}` : statusLabel(s.status, ts), `${ts.volumeShort} ${meter}`]
    if (fish.gold.length) status.push(`><> ×${fish.gold.length}`)
    return (
      <Box flexDirection="column">
        <Text color="claude" bold>
          ♫ Claude FM
        </Text>
        {s.status === 'on' && s.track ? <Text>♪ {s.track}</Text> : <Text dimColor>{ts.tagline}</Text>}
        <Text dimColor>{'    .:.        .::.            .:.'}</Text>
        <Text dimColor>{'  .:::::.  .:::::::::.   .:. .:::::.'}</Text>
        <Text dimColor>{' ~ ~ ~ ~ ~ ~ ~ \\__/ ~ ~ ~ ~ ~ ~ ~ ~'}</Text>
        <Text color={s.status === 'on' ? 'claude' : undefined} dimColor={s.status !== 'on'}>
          ● {status.join(' · ')}
        </Text>
        {controls}
        {note}
        {foot}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, n) => {
    if (e.props.hasSurvey) return n(e)

    const s = await current($)
    const ts = t()
    const rest = await n(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    const row =
      s.status === 'on' ? (
        <Box key="fm" gap={1}>
          <Text color="claude">♪ {fit(s.track ?? 'Claude FM', Math.max(12, (e.props.bodyColumns || 80) - 28))}</Text>
          <Text dimColor>· {elapsed(s.minute, ts)}</Text>
          <Button key="fm-open" label={ts.player} plain dimColor onPress={() => openPlayer($)} />
          <Button key="fm-stop" label="■" plain dimColor onPress={() => void stop($)} />
        </Box>
      ) : s.status === 'tuning' ? (
        <Box key="fm" gap={1}>
          <Text dimColor>{ts.bandTuning}</Text>
          <Button key="fm-stop" label={ts.bandCancel} dimColor onPress={() => void stop($)} />
        </Box>
      ) : s.status === 'error' ? (
        <Box key="fm" gap={1}>
          <Text dimColor>♪ Claude FM: {s.note}</Text>
          <Button key="fm-play" label={ts.bandRetry} dimColor onPress={() => void play($)} />
        </Box>
      ) : isPlayButtonShown ? (
        <Box key="fm">
          <Button
            key="fm-play"
            label={ts.bandPlay}
            dimColor
            plain
            onPress={() => {
              void play($)
              openPlayer($)
            }}
          />
        </Box>
      ) : null

    return (
      <Box flexDirection="column">
        {row}
        {rest}
      </Box>
    )
  })
}
