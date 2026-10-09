// The trigger wears the active skin of the skins mod
// (github.com/hellosverre/claude-skins) when that mod is installed: its accent
// on the glyph, its muted colour on the word, its error colour on stop. The
// skin is read from that mod's own state (`prefs`, `custom`, `isLight`), which
// names a skin but holds only the colours of the ones a person made, so the
// three slots of its built-in skins are kept here. A skin this file does not
// know leaves the trigger as it is without a skin.

export type Paint = {
  accent: string
  muted: string
  stop: string
  /** The skin's icon set: glyphs every font has, when it is `ascii`. */
  isAscii: boolean
}

type Slots = { user: string; muted: string; err: string }

const BUILT_IN: Readonly<Record<string, Slots>> = {
  noir: { user: '#f5f5f5', muted: '#8c8c8c', err: '#f87171' },
  'tokyo-night': { user: '#7aa2f7', muted: '#737aa2', err: '#f7768e' },
  dracula: { user: '#bd93f9', muted: '#6272a4', err: '#ff5555' },
  nord: { user: '#88c0d0', muted: '#7b88a1', err: '#bf616a' },
  gruvbox: { user: '#fabd2f', muted: '#928374', err: '#fb4934' },
  catppuccin: { user: '#cba6f7', muted: '#7f849c', err: '#f38ba8' },
  mono: { user: '#e0e0e0', muted: '#7a7a7a', err: '#ffffff' },
}

// The one built-in that carries its own palette for a light background.
const LIGHT: Readonly<Record<string, Slots>> = {
  noir: { user: '#111111', muted: '#6b6b6b', err: '#c42b2b' },
}

const HEX = /^#[0-9a-f]{6}$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** `amount` of the way from `hex` to black, as the skins mod deepens a colour. */
const deepen = (hex: string, amount: number): string =>
  `#${[1, 3, 5]
    .map(at => Math.round(parseInt(hex.slice(at, at + 2), 16) * (1 - amount)))
    .map(value => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0'))
    .join('')}`

// For a light background the skins mod derives a palette: colours deepened
// until they read on white, secondary text a fixed grey.
const toLight = (slots: Slots): Slots => ({
  user: deepen(slots.user, 0.45),
  muted: '#6b6b6b',
  err: deepen(slots.err, 0.25),
})

const slotsOf = (name: string, custom: unknown): Slots | undefined => {
  const own = BUILT_IN[name]
  if (own !== undefined) {
    return own
  }

  const made = isRecord(custom) ? custom[name] : undefined
  if (!isRecord(made)) {
    return undefined
  }

  // A made skin is its base with the slots it changed laid over it.
  const base = (typeof made.base === 'string' ? BUILT_IN[made.base] : undefined) ?? BUILT_IN.noir
  const palette = isRecord(made.palette) ? made.palette : {}
  const slot = (key: keyof Slots, fallback: string): string => {
    const value = palette[key]

    return typeof value === 'string' && HEX.test(value) ? value : fallback
  }

  return base === undefined
    ? undefined
    : { user: slot('user', base.user), muted: slot('muted', base.muted), err: slot('err', base.err) }
}

/**
 * What the trigger wears, from the skins mod's `prefs`, `custom` and `isLight`
 * as its state holds them; undefined with no skins mod, its skin off, or a
 * skin unknown here.
 */
export const paintOf = (prefs: unknown, custom: unknown, isLight: unknown): Paint | undefined => {
  if (!isRecord(prefs) || typeof prefs.skin !== 'string' || prefs.skin === 'off') {
    return undefined
  }

  const dark = slotsOf(prefs.skin, custom)
  if (dark === undefined) {
    return undefined
  }

  const slots = isLight === true ? (LIGHT[prefs.skin] ?? toLight(dark)) : dark

  return { accent: slots.user, muted: slots.muted, stop: slots.err, isAscii: prefs.icons === 'ascii' }
}
