/** Whether a transcript row's text is the one being read aloud now. */
export type IsPlaying = boolean

/** What the speech process is doing, as the footer's indicator says it. */
export type Saying = 'idle' | 'loading' | 'speaking'

declare module 'claude-code' {
  interface PluginState {
    'read-aloud': { playing: StateFamily<IsPlaying>; saying: Saying }
  }
}
