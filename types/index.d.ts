/** Whether a transcript row's text is the one being read aloud now. */
export type IsPlaying = boolean

declare module 'claude-code' {
  interface PluginState {
    'read-aloud': { playing: StateFamily<IsPlaying> }
  }
}
