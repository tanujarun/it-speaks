import { atom, memberOf, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement } from 'claude-code'

import { paintOf } from './skin-paint'
import type { Paint } from './skin-paint'

import { toSpeech } from './speech-text'

// Speech is made by a process of the mod's own (tts/daemon.py: Kokoro-82M, an
// open-source model, through kokoro-onnx), started once per session and told
// what to say through a spool folder of JSON files. Its runtime lives outside
// the mod, under HOME_FOLDER, where tts/setup.py installs it.

type Replies = 'all' | 'final' | 'off'

type Settings = {
  isOn: boolean
  /** `all`: each thing Claude says as it lands; `final`: the turn's answer. */
  replies: Replies
  /** Whether a prompt is read back as it is submitted. */
  prompts: boolean
  /** Whether each reply and prompt in the transcript carries a read trigger. */
  triggers: boolean
  voice: string
  promptVoice: string
  speed: number
  /** Percent, 100 the model's own level. */
  volume: number
  /** The most characters one reply is read for; 0 for the whole of it. */
  limit: number
}

type Daemon = { spool: string; sequence: number; voices: readonly string[] }

type DaemonEvent = { event?: string; id?: unknown; voices?: unknown; message?: unknown }

// Nothing is read unasked: each row carries a trigger, and the person picks.
const DEFAULTS: Settings = {
  isOn: true,
  replies: 'off',
  prompts: false,
  triggers: true,
  voice: 'af_heart',
  promptVoice: 'am_michael',
  speed: 1,
  volume: 100,
  limit: 2000,
}

const PROMPT_LIMIT = 600
const READ = '\u{1F50A} read'
const STOP = '■ stop'

// One member per transcript row: true on the row whose text is being read.
const playing = atom({ plugin: 'read-aloud', key: 'playing' } as const, false)
const SETUP_TIMEOUT_MS = 600_000

const HELP = [
  '/read-aloud                      what is on, and the voices in use',
  '/read-aloud on | off             everything on or off',
  '/read-aloud triggers on | off    the read trigger under each reply and prompt',
  '/read-aloud last                 the last reply (again: the same)',
  '/read-aloud selection            the text selected with the mouse',
  '/read-aloud replies all | final | off',
  '                                 read unasked: each thing Claude says, or the answer alone',
  '/read-aloud prompts on | off     read your prompt back as you submit it',
  '/read-aloud voice <name>         the voice for Claude (voices: list them)',
  '/read-aloud prompt-voice <name>  the voice for your prompts',
  '/read-aloud speed <0.5-2>        speaking rate',
  '/read-aloud volume <0-200>       percent',
  '/read-aloud limit <characters>   longest reply read unasked; 0 reads all of it',
  '/read-aloud say <text>           says the text',
  '/read-aloud setup                installs the voice model (about 340 MB)',
  '/hush                            stops the speech now',
].join('\n')

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

const readSettings = (stored: unknown): Settings => {
  const held = (typeof stored === 'object' && stored !== null ? stored : {}) as Partial<Settings>
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value !== '' ? value : fallback
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  return {
    isOn: typeof held.isOn === 'boolean' ? held.isOn : DEFAULTS.isOn,
    replies:
      held.replies === 'all' || held.replies === 'final' || held.replies === 'off'
        ? held.replies
        : DEFAULTS.replies,
    prompts: typeof held.prompts === 'boolean' ? held.prompts : DEFAULTS.prompts,
    triggers: typeof held.triggers === 'boolean' ? held.triggers : DEFAULTS.triggers,
    voice: text(held.voice, DEFAULTS.voice),
    promptVoice: text(held.promptVoice, DEFAULTS.promptVoice),
    speed: clamp(number(held.speed, DEFAULTS.speed), 0.5, 2),
    volume: clamp(number(held.volume, DEFAULTS.volume), 0, 200),
    limit: Math.max(0, Math.round(number(held.limit, DEFAULTS.limit))),
  }
}

const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim()

let settings = DEFAULTS
let isInteractive = false
let daemon: Daemon | undefined
let starting: Promise<Daemon | undefined> | undefined
let hasToldMissing = false
let spokenThisTurn: string[] = []
let lastReply = ''
let utterance = 0
// The row a trigger asked for, and the utterance that reads it: `awaited`
// until the speech process says it speaks, so the idle a stop reports just
// before it is not taken for this one's end.
let playingRow: string | undefined
let awaited: string | undefined

const setPlaying = async ($: EngineInterface, row: string | undefined): Promise<void> => {
  const before = playingRow
  playingRow = row
  if (before !== undefined && before !== row) {
    await update($, memberOf(playing, { requestId: before }), () => false)
  }
  if (row !== undefined) {
    await update($, memberOf(playing, { requestId: row }), () => true)
  }
}

const loadSettings = async ($: EngineInterface): Promise<Settings> => {
  settings = readSettings(await $.store.get('settings'))

  return settings
}

const saveSettings = async ($: EngineInterface, change: Partial<Settings>): Promise<void> => {
  settings = readSettings({ ...(await loadSettings($)), ...change })
  await $.store.set('settings', settings)
}

const homeFolder = async ($: EngineInterface): Promise<string> => {
  const own = await $.env.get('READ_ALOUD_HOME')
  const user = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'

  return (own ?? `${user}/.claude/read-aloud`).replace(/\\/g, '/')
}

/** The runtime's Python, or undefined while tts/setup.py has not run. */
const findPython = async ($: EngineInterface, home: string): Promise<string | undefined> => {
  const hasModel = await $.fs.exists(`${home}/models/kokoro-v1.0.onnx`)
  if (!hasModel) {
    return undefined
  }
  for (const python of [`${home}/venv/Scripts/python.exe`, `${home}/venv/bin/python`]) {
    if (await $.fs.exists(python)) {
      return python
    }
  }

  return undefined
}

const onDaemonEvent = ($: EngineInterface, mine: Daemon, line: string): void => {
  let said: DaemonEvent
  try {
    said = JSON.parse(line) as DaemonEvent
  } catch {
    return
  }

  if (said.event === 'ready' && Array.isArray(said.voices)) {
    mine.voices = said.voices.filter((voice): voice is string => typeof voice === 'string')
  } else if (said.event === 'loading') {
    $.ui.status('read-aloud: loading the voice')
  } else if (said.event === 'speaking') {
    $.ui.status('read-aloud: speaking (/hush stops it)')
    if (said.id === awaited) {
      awaited = undefined
    }
  } else if (said.event === 'idle') {
    $.ui.status(undefined)
    if (awaited === undefined) {
      void setPlaying($, undefined)
    }
  } else if (said.event === 'error') {
    $.ui.log(`read-aloud: ${String(said.message)}`, { to: 'debug' })
    if (said.id === awaited) {
      awaited = undefined
    }
  }
}

/** Reads the daemon's lines for as long as it lives; the loop is its life. */
const follow = async ($: EngineInterface, mine: Daemon, argv: readonly string[]): Promise<void> => {
  let held = ''
  try {
    for await (const { stream, text } of $.process.spawn({ argv })) {
      if (stream === 'stderr') {
        $.ui.log(`read-aloud: ${text.trim()}`, { to: 'debug' })
        continue
      }
      held += text
      const lines = held.split('\n')
      held = lines.pop() ?? ''
      for (const line of lines) {
        onDaemonEvent($, mine, line)
      }
    }
  } catch (error) {
    $.ui.log(`read-aloud: the speech process did not run: ${String(error)}`, { to: 'debug' })
  } finally {
    if (daemon === mine) {
      daemon = undefined
      $.ui.status(undefined)
    }
  }
}

const start = async ($: EngineInterface): Promise<Daemon | undefined> => {
  const home = await homeFolder($)
  const python = await findPython($, home)

  if (python === undefined) {
    if (!hasToldMissing) {
      hasToldMissing = true
      $.ui.toast('read-aloud: no voice model yet. Run /read-aloud setup', { timeoutMs: 10_000 })
    }

    return undefined
  }

  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const mine: Daemon = { spool: `${home}/spool/${name}`, sequence: 0, voices: [] }
  const script = `${$.plugin.root.replace(/\\/g, '/')}/tts/daemon.py`

  daemon = mine
  void follow($, mine, [python, '-B', script, '--spool', mine.spool, '--models', `${home}/models`])

  return mine
}

const running = async ($: EngineInterface): Promise<Daemon | undefined> => {
  if (daemon !== undefined) {
    return daemon
  }
  starting ??= start($).finally(() => {
    starting = undefined
  })

  return starting
}

const send = async ($: EngineInterface, command: Record<string, unknown>): Promise<boolean> => {
  const to = await running($)
  if (to === undefined) {
    return false
  }
  to.sequence += 1
  const file = `${to.spool}/${String(to.sequence).padStart(6, '0')}.json`
  await $.fs.write(file, JSON.stringify(command))

  return true
}

/** Queues `text` to be spoken; answers the utterance's id, or undefined. */
const say = async ($: EngineInterface, text: string, voice: string): Promise<string | undefined> => {
  if (text === '') {
    return undefined
  }
  utterance += 1
  const id = `u${utterance}`
  const isSent = await send($, {
    op: 'speak',
    id,
    text,
    voice,
    speed: settings.speed,
    gain: settings.volume / 100,
  })

  return isSent ? id : undefined
}

/** Silences the speech, when a process is there to silence. */
const hush = async ($: EngineInterface): Promise<void> => {
  awaited = undefined
  if (daemon !== undefined) {
    await send($, { op: 'stop' })
  }
  await setPlaying($, undefined)
}

type Who = 'voice' | 'promptVoice'

/** A press on a row's trigger: reads that row whole, or stops it if it plays. */
const toggle = async ($: EngineInterface, row: string, markdown: string, who: Who): Promise<void> => {
  try {
    const wasPlaying = playingRow === row
    await loadSettings($)
    await hush($)
    if (wasPlaying) {
      return
    }
    const id = await say($, toSpeech(markdown), settings[who])
    if (id === undefined) {
      return
    }
    awaited = id
    await setPlaying($, row)
  } catch (error) {
    $.ui.log(`read-aloud: ${String(error)}`, { to: 'debug' })
  }
}

// The skins mod's state, read as any plugin may read another's. Read while a
// row is drawn, it draws the row again when the person changes their skin.
// Its contract is not this mod's to import, so each value is read as unknown.
type Held = { value: unknown }

const skinPaint = async ($: EngineInterface): Promise<Paint | undefined> => {
  try {
    const prefs: Held = await $.state.get({ plugin: 'skins', key: 'prefs' } as never)
    const custom: Held = await $.state.get({ plugin: 'skins', key: 'custom' } as never)
    const isLight: Held = await $.state.get({ plugin: 'skins', key: 'isLight' } as never)

    return paintOf(prefs.value, custom.value, isLight.value)
  } catch {
    return undefined
  }
}

type Ui = Pick<ElementTable, 'Box' | 'Button' | 'Text'>

/** The row as drawn beneath, and under it the trigger, in the skin's colours. */
const withTrigger = (
  { Box, Button, Text }: Ui,
  drawn: RenderElement,
  isPlaying: boolean,
  paint: Paint | undefined,
  onPress: () => void,
): RenderElement => (
  <Box flexDirection="column">
    {drawn}
    <Box paddingLeft={2}>
      {paint === undefined ? (
        <Button key="read-aloud" plain dimColor label={isPlaying ? STOP : READ} onPress={onPress} />
      ) : (
        <Button key="read-aloud" plain label={isPlaying ? 'stop' : 'read'} onPress={onPress}>
          <Text color={isPlaying ? paint.stop : paint.accent}>
            {isPlaying ? (paint.isAscii ? 'x' : '■') : paint.isAscii ? '>' : '►'}
          </Text>
          <Text color={paint.muted}>{isPlaying ? ' stop' : ' read'}</Text>
        </Button>
      )}
    </Box>
  </Box>
)

/** Whether a press can reach a transcript row: not in a terminal's scrollback. */
const canPress = (surface: string, isFullscreen: boolean | undefined): boolean =>
  surface !== 'terminal' || isFullscreen !== false

const sayReply = async ($: EngineInterface, markdown: string): Promise<void> => {
  spokenThisTurn.push(squeeze(markdown))
  await say($, toSpeech(markdown, settings.limit), settings.voice)
}

// A hook here never fails the event it rides on: speech is an extra.
const quietly = async ($: EngineInterface, work: () => Promise<void>): Promise<void> => {
  try {
    await work()
  } catch (error) {
    $.ui.log(`read-aloud: ${String(error)}`, { to: 'debug' })
  }
}

const describe = async ($: EngineInterface): Promise<string> => {
  const home = await homeFolder($)
  const isInstalled = (await findPython($, home)) !== undefined
  const replies = { all: 'everything Claude says', final: 'the final answer', off: 'off' }

  return [
    `read-aloud is ${settings.isOn ? 'on' : 'off'}.`,
    `  triggers: ${settings.triggers ? 'a read trigger under each reply and prompt' : 'off'}`,
    `  read unasked, replies: ${replies[settings.replies]} (voice ${settings.voice})`,
    `  read unasked, prompts: ${settings.prompts ? 'as you submit them' : 'off'} (voice ${settings.promptVoice})`,
    `  speed ${settings.speed}, volume ${settings.volume}%, limit ${settings.limit || 'none'}`,
    isInstalled
      ? `  voice model: Kokoro-82M in ${home}`
      : '  voice model: not installed. Run /read-aloud setup',
    '  /read-aloud help lists the commands; /hush stops the speech.',
  ].join('\n')
}

const setUp = async ($: EngineInterface): Promise<string> => {
  const script = `${$.plugin.root.replace(/\\/g, '/')}/tts/setup.py`
  const home = await homeFolder($)

  for (const python of ['python', 'py', 'python3']) {
    const ran = await $.process
      .run([python, '-B', script], {
        timeoutMs: SETUP_TIMEOUT_MS,
        env: { READ_ALOUD_HOME: home },
      })
      .catch(() => undefined)
    if (ran === undefined) {
      continue
    }
    const tail = `${ran.stdout}\n${ran.stderr}`.trim().split('\n').slice(-6).join('\n')
    if (ran.exitCode !== 0) {
      return `read-aloud: setup failed (${python}).\n${tail}`
    }
    hasToldMissing = false
    await running($)

    return `read-aloud: the voice is installed.\n${tail}`
  }

  return 'read-aloud: no Python found. Install Python 3.10 or newer, then run /read-aloud setup.'
}

const setVoice = async ($: EngineInterface, key: 'voice' | 'promptVoice', name: string): Promise<string> => {
  const voices = (await running($))?.voices ?? []

  if (name === '') {
    return `Name a voice. ${voices.length > 0 ? `Voices: ${voices.join(', ')}` : ''}`.trim()
  }
  if (voices.length > 0 && !voices.includes(name)) {
    return `No voice named ${name}. Voices: ${voices.join(', ')}`
  }
  await saveSettings($, { [key]: name })
  await hush($)
  await say($, `This is the voice ${name.replace(/^[a-z]{2}_/, '')}.`, name)

  return `${key === 'voice' ? "Claude's" : 'Your prompt'} voice is now ${name}.`
}

const runCommand = async ($: EngineInterface, args: string): Promise<string> => {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const value = rest.join(' ')
  const isYes = value === 'on' || value === ''

  await loadSettings($)

  switch (verb) {
    case '':
    case 'status':
      return describe($)
    case 'help':
      return HELP
    case 'on':
      await saveSettings($, { isOn: true })
      await running($)
      $.ui.invalidate('ui.render')

      return describe($)
    case 'off':
      await saveSettings($, { isOn: false })
      await hush($)
      $.ui.invalidate('ui.render')

      return 'read-aloud is off.'
    case 'replies': {
      if (value !== 'all' && value !== 'final' && value !== 'off') {
        return 'Say which: /read-aloud replies all | final | off'
      }
      await saveSettings($, { replies: value })

      return describe($)
    }
    case 'prompts':
      if (value !== 'on' && value !== 'off' && value !== '') {
        return 'Say which: /read-aloud prompts on | off'
      }
      await saveSettings($, { prompts: isYes })

      return isYes ? 'Your prompts are read back to you.' : 'Your prompts are no longer read back.'
    case 'triggers':
      if (value !== 'on' && value !== 'off' && value !== '') {
        return 'Say which: /read-aloud triggers on | off'
      }
      await saveSettings($, { triggers: isYes })
      $.ui.invalidate('ui.render')

      return isYes ? 'Each reply and prompt carries a read trigger.' : 'The read triggers are hidden.'
    case 'voice':
      return setVoice($, 'voice', value)
    case 'prompt-voice':
      return setVoice($, 'promptVoice', value)
    case 'voices': {
      const voices = (await running($))?.voices ?? []

      return voices.length > 0
        ? `Voices (a: American, b: British; f: female, m: male):\n${voices.join(', ')}`
        : 'The voices are listed once the speech process has started. Try again in a moment.'
    }
    case 'speed': {
      const speed = Number(value)
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
        return 'Give a rate from 0.5 to 2: /read-aloud speed 1.2'
      }
      await saveSettings($, { speed })

      return `Speed is ${speed}.`
    }
    case 'volume': {
      const volume = Number(value.replace('%', ''))
      if (!Number.isFinite(volume) || volume < 0 || volume > 200) {
        return 'Give a percent from 0 to 200: /read-aloud volume 80'
      }
      await saveSettings($, { volume })

      return `Volume is ${volume}%.`
    }
    case 'limit': {
      const limit = Number(value)
      if (!Number.isInteger(limit) || limit < 0) {
        return 'Give a number of characters, 0 for no limit: /read-aloud limit 2000'
      }
      await saveSettings($, { limit })

      return limit === 0 ? 'Replies are read whole.' : `Replies are read up to ${limit} characters.`
    }
    case 'last':
    case 'again':
      if (lastReply === '') {
        return 'Claude has said nothing yet in this session.'
      }
      await hush($)

      return (await say($, toSpeech(lastReply), settings.voice)) !== undefined
        ? 'Reading the last reply.'
        : 'The voice is not installed. Run /read-aloud setup'
    case 'selection': {
      const selected = await $.ui.selection()
      if (selected === undefined || selected.text.trim() === '') {
        return 'Nothing is selected. Select text with the mouse, then run /read-aloud selection'
      }
      await hush($)

      return (await say($, toSpeech(selected.text), settings.voice)) !== undefined
        ? 'Reading the selection.'
        : 'The voice is not installed. Run /read-aloud setup'
    }
    case 'say':
      return (await say($, toSpeech(value), settings.voice)) !== undefined
        ? 'Saying it.'
        : 'Nothing to say, or the voice is not installed (/read-aloud setup).'
    case 'setup':
      return setUp($)
    default:
      return `No such setting: ${verb}\n${HELP}`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.command.register({
      name: 'read-aloud',
      description: 'Read Claude aloud: triggers, last, selection, voice, speed (bare: status)',
      argumentHint: '[on|off|triggers|last|selection|replies|prompts|voice|speed|volume|say|setup|help]',
      immediate: true,
    })
    await $.command.register({
      name: 'hush',
      description: 'Stop the speech that is playing',
      immediate: true,
    })
    await quietly($, async () => {
      await loadSettings($)
      if (isInteractive && settings.isOn) {
        await running($)
      }
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isTyped = e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/')

    if (isInteractive && isTyped) {
      await quietly($, async () => {
        await loadSettings($)
        // A new prompt makes whatever was being read stale.
        await hush($)
        if (settings.isOn && settings.prompts) {
          await say($, toSpeech(e.text, PROMPT_LIMIT), settings.promptVoice)
        }
      })
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    spokenThisTurn = []

    return next(e)
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    const isMainReply = e.agentId === undefined && e.message.type === 'assistant'

    if (isInteractive && isMainReply) {
      await quietly($, async () => {
        for (const block of e.message.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            lastReply = block.text
            if (settings.isOn && settings.replies === 'all') {
              await sayReply($, block.text)
            }
          }
        }
      })
    }

    return stored
  })

  on('turn.complete', async ($, e, next) => {
    if (isInteractive && e.agentId === undefined) {
      await quietly($, async () => {
        const answer = squeeze(e.answer)
        const isSaid = spokenThisTurn.some(said => said.includes(answer) || answer.includes(said))

        if (answer !== '') {
          lastReply = e.answer
        }
        if (e.isAborted) {
          await hush($)
        } else if (settings.isOn && settings.replies !== 'off' && answer !== '' && !isSaid) {
          await sayReply($, e.answer)
        }
      })
    }

    return next(e)
  })

  // The trigger: the row as it is drawn beneath, and a small button under it
  // that reads that row, or stops it while it is the one being read.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    const isShown = settings.isOn && settings.triggers && canPress(e.surface, e.viewport?.isFullscreen)

    if (!isShown || toSpeech(e.props.text) === '') {
      return drawn
    }

    const isPlaying = await read($, memberOf(playing, e))
    const row = e.requestId
    const text = e.props.text

    return withTrigger($.ui.resolve(e), drawn, isPlaying, await skinPaint($), () => {
      void toggle($, row, text, 'voice')
    })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    const isTyped = e.props.origin.kind === 'composer' && !e.props.text.trimStart().startsWith('/')
    const isShown = settings.isOn && settings.triggers && canPress(e.surface, e.viewport?.isFullscreen)

    if (!isShown || !isTyped || toSpeech(e.props.text) === '') {
      return drawn
    }

    const isPlaying = await read($, memberOf(playing, e))
    const row = e.requestId
    const text = e.props.text

    return withTrigger($.ui.resolve(e), drawn, isPlaying, await skinPaint($), () => {
      void toggle($, row, text, 'promptVoice')
    })
  })

  on('command.run', { command: 'read-aloud' }, async ($, e) => {
    try {
      return { text: await runCommand($, e.args) }
    } catch (error) {
      return { text: `read-aloud: ${String(error)}` }
    }
  })

  on('command.run', { command: 'hush' }, async $ => {
    try {
      await hush($)
    } catch (error) {
      return { text: `read-aloud: ${String(error)}` }
    }

    return { text: 'Hushed.' }
  })
}
