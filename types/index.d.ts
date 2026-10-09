export type Radio = {
  status: 'off' | 'tuning' | 'on' | 'error'
  note: string | null
  // ffplay's -volume, 10 to 100.
  volume: number
  // Video in a small always-on-top ffplay window instead of audio only.
  isWindow: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'lofi-radio': { radio: Radio }
  }
}
