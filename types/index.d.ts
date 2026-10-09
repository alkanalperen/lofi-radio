export type Radio = {
  status: 'off' | 'tuning' | 'on' | 'error'
  note: string | null
  // ffplay's -volume, 10 to 100.
  volume: number
  // Video in a small always-on-top ffplay window instead of audio only.
  isWindow: boolean
  // "Artist — Title" read from the stream's now-playing box; null until read.
  track: string | null
  // When the current listen started (ms); null while not playing.
  onSince: number | null
  // Whole minutes since onSince, ticked once a minute so the pane redraws rarely.
  minute: number
}

// One fish per finished Claude turn while the radio plays, counted per local day.
export type Pond = { day: string; gold: boolean[]; lastAt: number }

declare module 'claude-code' {
  interface PluginState {
    'lofi-radio': { radio: Radio; pond: Pond }
  }
}
