import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { paintOf } from '../hooks/skin-paint'
import { toSpeech } from '../hooks/speech-text'

type Command = { op: string; text?: string; voice?: string; speed?: number; gain?: number }

const HOME = 'C:/Users/tester'

/**
 * Stands for the machine beneath the mod: an installed runtime, a speech
 * process that reports ready and then lives until `end()`, and a spool whose
 * command files are kept for the test to read.
 */
const machine = (on: On, settings?: Record<string, unknown>) => {
  const commands: Command[] = []
  const spawned: (readonly string[])[] = []
  let end = (): void => {}
  const ended = new Promise<void>(resolve => {
    end = resolve
  })

  mock.store(on, settings === undefined ? {} : { settings })
  mock.env(on, { USERPROFILE: HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_$, e) => {
    const command = JSON.parse(e.text) as Command
    commands.push(command)
    // The speech process exits on a quit, as the real one does.
    if (command.op === 'quit') {
      end()
    }

    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.selection', () => ({ value: { text: 'Only these words.' } }))
  // The row as the engine would draw it, for the mod's render hooks to wrap;
  // the footer's mode labels joined as the engine joins them.
  on('ui.render', (_$, e) => ({
    type: 'Text',
    children: [e.component === 'SessionMode' ? e.props.modes.join(' & ') || 'no modes' : 'the row'],
  }))

  // What the speech process reports, a line at a time, as the test says it.
  const reports: string[] = []
  let wake = (): void => {}
  const report = (event: Record<string, unknown>): void => {
    reports.push(JSON.stringify(event))
    wake()
  }
  let isEnded = false
  void ended.then(() => {
    isEnded = true
    wake()
  })

  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    yield { stream: 'stdout', text: '{"event": "ready", "voices": ["af_heart", "am_michael"]}\n' }
    while (!isEnded) {
      const line = reports.shift()
      if (line === undefined) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
        continue
      }
      yield { stream: 'stdout', text: `${line}\n` }
    }

    return { value: { code: 0, signal: null } }
  })

  return { commands, spawned, end, report }
}

declare const setTimeout: (run: () => void, ms: number) => unknown

/** Waits, a few milliseconds at a time, for what a report set in motion. */
const until = async (isSo: () => Promise<boolean>): Promise<void> => {
  for (let tries = 0; tries < 200 && !(await isSo()); tries += 1) {
    await new Promise<void>(resolve => {
      setTimeout(resolve, 5)
    })
  }
}

const SCREEN = { columns: 100, rows: 40, isFullscreen: true }

const FOOTER = { plugin: 'read-aloud', component: 'SessionMode', props: { modes: ['focus'] } } as const

const reply = (text: string) =>
  ({ plugin: 'read-aloud', component: 'AssistantMessage', props: { text, isFirstOfReply: true } }) as const

const prompt = (text: string, kind: 'composer' | 'task-notification' = 'composer') =>
  ({
    plugin: 'read-aloud',
    component: 'UserMessage',
    props: { text, origin: { kind }, isExpanded: false },
  }) as const

const begin = ($: Engine) => $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } as const })

const slash = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
})

const answered = (answer: string) =>
  ({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }) as const

describe('toSpeech', () => {
  test('keeps the prose and drops the marks', () => {
    expect(toSpeech('## Done\n\n**Fixed** the `parse` bug in [the parser](https://x.dev/p).')).toBe(
      'Done.\nFixed the parse bug in the parser.',
    )
  })

  test('names code and tables instead of reading them', () => {
    const said = toSpeech('Run this:\n```sh\nnpm test\n```\n| a | b |\n|---|---|\n| 1 | 2 |\nThen push.')

    expect(said).toBe('Run this:\nCode block.\nTable.\nThen push.')
  })

  test('says a path by its file name and a list item as a sentence', () => {
    expect(toSpeech('- edited src/hooks/register.ts:42\n- see https://example.com/a/b')).toBe(
      'edited register.ts line 42.\nsee link.',
    )
  })

  test('holds a long reply to its limit at a sentence end', () => {
    const said = toSpeech(`${'One short sentence. '.repeat(20)}`, 100)

    expect(said.endsWith('The rest is on screen.')).toBe(true)
    expect(said.length).toBeLessThan(130)
  })
})

const EVA = {
  name: 'eva',
  label: 'EVA',
  base: 'dracula',
  palette: { user: '#9b6dff', muted: '#8f86ad', err: '#ff3b3b' },
  spinner: [],
  done: [],
}

describe('paintOf', () => {
  test('wears a made skin: its own slots over its base', () => {
    expect(paintOf({ skin: 'eva', icons: 'unicode' }, { eva: EVA }, false)).toEqual({
      accent: '#9b6dff',
      muted: '#8f86ad',
      stop: '#ff3b3b',
      isAscii: false,
    })
    expect(paintOf({ skin: 'mine', icons: 'ascii' }, { mine: { base: 'nord', palette: { user: '#112233' } } }, false)).toEqual({
      accent: '#112233',
      muted: '#7b88a1',
      stop: '#bf616a',
      isAscii: true,
    })
  })

  test('wears a built-in skin, deepened for a light background', () => {
    expect(paintOf({ skin: 'dracula' }, {}, false)?.accent).toBe('#bd93f9')
    expect(paintOf({ skin: 'dracula' }, {}, true)).toEqual({
      accent: '#685189',
      muted: '#6b6b6b',
      stop: '#bf4040',
      isAscii: false,
    })
    expect(paintOf({ skin: 'noir' }, {}, true)?.accent).toBe('#111111')
  })

  test('wears nothing with no skins mod, its skin off, or a skin it does not know', () => {
    expect(paintOf(undefined, undefined, undefined)).toBeUndefined()
    expect(paintOf({ skin: 'off' }, {}, false)).toBeUndefined()
    expect(paintOf({ skin: 'brand-new' }, {}, false)).toBeUndefined()
  })
})

describe('read-aloud', () => {
  test("the trigger wears the skins mod's active skin, and follows it to stop", async ($, on) => {
    const { end } = machine(on)
    // Another mod's state is outside this mod's contract, so its matcher is untyped.
    const held = (key: string) => ({ plugin: 'skins', key }) as never
    on('state.get', held('prefs'), () => ({ value: { value: { skin: 'eva', icons: 'unicode' }, version: 1 } }))
    on('state.get', held('custom'), () => ({ value: { value: { eva: EVA }, version: 1 } }))
    on('state.get', held('isLight'), () => ({ value: { value: false, version: 1 } }))
    await begin($)
    const ui = await $.ui.mount({ ...reply('Themed.'), surface: 'terminal', viewport: SCREEN })
    const colours = async () =>
      (await ui.findAll({ type: 'Text' })).map(text => [text.text, text.props?.color])

    expect((await ui.find({ key: 'read-aloud' }))?.text).toContain('read')
    expect(await colours()).toContainEqual(['►', '#9b6dff'])
    expect(await colours()).toContainEqual([' read', '#8f86ad'])

    await ui.press({ key: 'read-aloud' })
    expect(await colours()).toContainEqual(['■', '#ff3b3b'])
    end()
  })

  test('starts one speech process for the session, from the installed runtime', async ($, on) => {
    const { spawned, end } = machine(on)
    await begin($)

    expect(spawned.length).toBe(1)
    expect(spawned[0]?.[0]).toBe(`${HOME}/.claude/read-aloud/venv/Scripts/python.exe`)
    expect(spawned[0]?.join(' ')).toContain('tts/daemon.py --spool')
    end()
  })

  test('reads nothing unasked by default', async ($, on) => {
    const { commands, end } = machine(on)
    await begin($)
    await $.prompt.submit(typed('Fix the login bug'))
    await $.turn.complete(answered('It is fixed.'))

    expect(commands.filter(command => command.op === 'speak')).toEqual([])
    end()
  })

  test('a reply carries a trigger that reads it whole, and stops it while it plays', async ($, on) => {
    const { commands, end, report } = machine(on, { limit: 10 })
    await begin($)
    const ui = await $.ui.mount({ ...reply('All **three** tests pass.'), surface: 'terminal', viewport: SCREEN })
    const footer = await $.ui.mount({ ...FOOTER, surface: 'terminal', viewport: SCREEN })
    const label = async () => (await ui.find({ key: 'read-aloud' }))?.text ?? ''

    expect(await label()).toContain('read')
    await ui.press({ key: 'read-aloud' })
    expect(commands.at(-1)?.text).toBe('All three tests pass.')
    expect(commands.at(-1)?.voice).toBe('af_heart')
    expect(await label()).toContain('stop')

    // The stop before it reported idle; that is not this utterance's end.
    report({ event: 'idle' })
    report({ event: 'speaking', id: 'u1' })
    await until(async () => ((await footer.find({ type: 'Text' }))?.text ?? '').includes('reading aloud'))
    expect(await label()).toContain('stop')

    await ui.press({ key: 'read-aloud' })
    expect(commands.at(-1)).toEqual({ op: 'stop' })
    expect(await label()).toContain('read')
    end()
  })

  test('every surface that reports a press draws the same trigger', async ($, on) => {
    const { commands, end } = machine(on)
    await begin($)

    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...reply(`Read on ${surface}.`), surface })
      await ui.press({ key: 'read-aloud' })
      expect(commands.at(-1)?.text).toBe(`Read on ${surface}.`)
    }
    end()
  })

  test('the trigger goes back to read when the speech ends by itself', async ($, on) => {
    const { end, report } = machine(on)
    await begin($)
    const ui = await $.ui.mount({ ...reply('Done.'), surface: 'terminal', viewport: SCREEN })
    const label = async () => (await ui.find({ key: 'read-aloud' }))?.text ?? ''

    await ui.press({ key: 'read-aloud' })
    report({ event: 'speaking', id: 'u1' })
    report({ event: 'done', id: 'u1' })
    report({ event: 'idle' })
    await until(async () => (await label()).includes('read'))

    expect(await label()).toContain('read')
    end()
  })

  test("a typed prompt's trigger reads it in the prompt voice; a notification has none", async ($, on) => {
    const { commands, end } = machine(on)
    await begin($)
    const mine = await $.ui.mount({ ...prompt('Fix the `login` bug'), surface: 'terminal', viewport: SCREEN })
    const notice = await $.ui.mount({
      ...prompt('A task finished', 'task-notification'),
      surface: 'terminal',
      viewport: SCREEN,
    })

    await mine.press({ key: 'read-aloud' })
    expect(commands.at(-1)?.text).toBe('Fix the login bug')
    expect(commands.at(-1)?.voice).toBe('am_michael')
    expect(await notice.find({ type: 'Button' })).toBeUndefined()
    end()
  })

  test('no trigger where a press cannot reach the row, or once they are turned off', async ($, on) => {
    const { end } = machine(on)
    await begin($)
    const scrollback = await $.ui.mount({
      ...reply('In scrollback.'),
      surface: 'terminal',
      viewport: { ...SCREEN, isFullscreen: false },
    })
    expect(await scrollback.find({ type: 'Button' })).toBeUndefined()

    const code = await $.ui.mount({ ...reply('```sh\nls\n```'), surface: 'terminal', viewport: SCREEN })
    expect(await code.find({ type: 'Button' })).toBeDefined()

    const off = await $.command.run(slash('read-aloud', 'triggers off'))
    expect(off.text).toBe('The read triggers are hidden.')
    const hidden = await $.ui.mount({ ...reply('Hidden.'), surface: 'terminal', viewport: SCREEN })
    expect(await hidden.find({ type: 'Button' })).toBeUndefined()
    end()
  })

  test('/read-aloud update stops the speech process, runs the updater, and says the mod is behind', async ($, on) => {
    const { commands, spawned } = machine(on)
    const ran: (readonly string[])[] = []
    on('process.run', (_$, e) => {
      ran.push(e.argv)

      return {
        value: {
          exitCode: 0,
          stdout:
            'packages: kokoro-onnx 0.6.1 -> 0.6.2\nmodels: downloading kokoro-v1.0.onnx\nmodels: kokoro-v1.0.onnx 31 MB of 310\nread-aloud: ready (Kokoro-82M v1.0)\n',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })
    on('fs.read', () => ({ value: '{"version": "0.3.0", "homepage": "https://github.com/tanujarun/it-speaks"}' }))
    const fetched: string[] = []
    on('http.fetch', (_$, e) => {
      fetched.push(e.url)

      return { value: { status: 200, ok: true, headers: {}, text: '{"version": "0.4.0"}' } }
    })
    await begin($)

    const updated = await $.command.run(slash('read-aloud', 'update'))

    expect(commands.at(-1)).toEqual({ op: 'quit' })
    expect(ran[0]?.slice(-2)).toEqual([expect.stringContaining('tts/setup.py'), 'update'])
    expect(spawned.length).toBe(2)
    expect(fetched).toEqual(['https://raw.githubusercontent.com/tanujarun/it-speaks/HEAD/.claude-plugin/plugin.json'])
    expect(updated.text).toBe(
      [
        'read-aloud: the voice is up to date.',
        'packages: kokoro-onnx 0.6.1 -> 0.6.2',
        'models: downloading kokoro-v1.0.onnx',
        'read-aloud: ready (Kokoro-82M v1.0)',
        'mod: version 0.4.0 is out and this is 0.3.0. Update it with: claude plugin update, then /reload-plugins',
      ].join('\n'),
    )
  })

  test('/read-aloud update reports a failed update, and nothing on the mod it cannot reach', async ($, on) => {
    machine(on)
    on('process.run', () => ({
      value: {
        exitCode: 1,
        stdout: '',
        stderr: 'ERROR: Could not install packages: [WinError 5] Access is denied',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    await begin($)

    const updated = await $.command.run(slash('read-aloud', 'update'))

    expect(updated.text).toBe(
      'read-aloud: the update failed.\nERROR: Could not install packages: [WinError 5] Access is denied',
    )
  })

  test('/read-aloud last reads the last reply, and selection what is selected', async ($, on) => {
    const { commands, end } = machine(on)
    await begin($)

    const none = await $.command.run(slash('read-aloud', 'last'))
    expect(none.text).toBe('Claude has said nothing yet in this session.')

    await $.turn.complete(answered('The build is green.'))
    await $.command.run(slash('read-aloud', 'last'))
    expect(commands.at(-1)?.text).toBe('The build is green.')

    await $.command.run(slash('read-aloud', 'selection'))
    expect(commands.at(-1)?.text).toBe('Only these words.')
    end()
  })

  test('reads a typed prompt back in the prompt voice, after silencing what played', async ($, on) => {
    const { commands, end } = machine(on, { prompts: true })
    await begin($)
    await $.prompt.submit(typed('Fix the **login** bug'))

    expect(commands.map(command => command.op)).toEqual(['stop', 'speak'])
    expect(commands[1]?.text).toBe('Fix the login bug')
    expect(commands[1]?.voice).toBe('am_michael')
    end()
  })

  test('leaves a prompt unread when prompts are off, and one nobody typed', async ($, on) => {
    const { commands, end } = machine(on, { prompts: false })
    await begin($)
    await $.prompt.submit(typed('hello'))
    await $.prompt.submit({ text: 'a task finished', wait: false, origin: { kind: 'task-notification' } })

    expect(commands.filter(command => command.op === 'speak')).toEqual([])
    end()
  })

  test("reads the turn's answer in Claude's voice at the set speed and volume", async ($, on) => {
    const { commands, end } = machine(on, { replies: 'final', speed: 1.5, volume: 50 })
    await begin($)
    await $.turn.complete(answered('All **three** tests pass.'))

    expect(commands).toEqual([
      { op: 'speak', id: 'u1', text: 'All three tests pass.', voice: 'af_heart', speed: 1.5, gain: 0.5 },
    ])
    end()
  })

  test('reads each reply as it lands, and the answer only once', async ($, on) => {
    const { commands, end } = machine(on, { replies: 'all' })
    await begin($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Looking at the file.' }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: 'row-1',
    })
    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'It is fixed.' }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: 'row-2',
    })
    await $.turn.complete(answered('It is fixed.'))

    expect(commands.map(command => command.text)).toEqual(['Looking at the file.', 'It is fixed.'])
    end()
  })

  test("says nothing for a subagent's turn, and stops on an interrupted one", async ($, on) => {
    const { commands, end } = machine(on, { replies: 'final' })
    await begin($)
    await $.turn.complete({ ...answered('A report.'), agentId: 'agent-1' })
    await $.turn.complete({ ...answered(''), isAborted: true, reason: 'aborted' })

    expect(commands).toEqual([{ op: 'stop' }])
    end()
  })

  test('/read-aloud turns the reading off and on, and /hush stops it', async ($, on) => {
    const { commands, end } = machine(on, { replies: 'final' })
    await begin($)

    const off = await $.command.run(slash('read-aloud', 'off'))
    await $.turn.complete(answered('Unheard.'))
    expect(off.text).toBe('read-aloud is off.')
    expect(commands.filter(command => command.op === 'speak')).toEqual([])

    await $.command.run(slash('read-aloud', 'on'))
    await $.turn.complete(answered('Heard.'))
    expect(commands.at(-1)?.text).toBe('Heard.')

    const hushed = await $.command.run(slash('hush'))
    expect(hushed.text).toBe('Hushed.')
    expect(commands.at(-1)).toEqual({ op: 'stop' })
    end()
  })

  test('/read-aloud voice takes a voice the model has and refuses one it lacks', async ($, on) => {
    const { commands, end } = machine(on)
    await begin($)

    const refused = await $.command.run(slash('read-aloud', 'voice zz_nobody'))
    expect(refused.text).toContain('No voice named zz_nobody')

    const taken = await $.command.run(slash('read-aloud', 'voice am_michael'))
    expect(taken.text).toBe("Claude's voice is now am_michael.")
    expect(commands.at(-1)?.voice).toBe('am_michael')
    end()
  })

  // Each report is drawn at the kit's redraw rate, so six of them take a while.
  test("says it is reading at the right of the prompt's footer, and clears when it is done", { timeoutMs: 20_000 }, async ($, on) => {
    const { end, report } = machine(on)
    await begin($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const footer = await $.ui.mount({ ...FOOTER, surface, viewport: SCREEN })
      const shown = async () => (await footer.find({ type: 'Text' }))?.text ?? ''

      expect(await shown()).toBe('focus')

      report({ event: 'loading' })
      await until(async () => (await shown()).includes('loading'))
      expect(await shown()).toBe('focus & loading the voice')

      report({ event: 'speaking', id: 'u1' })
      await until(async () => (await shown()).includes('reading'))
      expect(await shown()).toBe('focus & reading aloud · /hush stops it')

      report({ event: 'idle' })
      await until(async () => (await shown()) === 'focus')
      expect(await shown()).toBe('focus')
      await footer.unmount()
    }
    end()
  })

  test('leaves the status line under the prompt alone', async ($, on) => {
    const { end, report } = machine(on)
    const pinned: (string | undefined)[] = []
    on('ui.status', (_$, e) => {
      pinned.push(e.text)

      return { value: undefined }
    })
    await begin($)
    const footer = await $.ui.mount({ ...FOOTER, surface: 'terminal', viewport: SCREEN })

    report({ event: 'speaking', id: 'u1' })
    await until(async () => ((await footer.find({ type: 'Text' }))?.text ?? '').includes('reading'))
    report({ event: 'idle' })
    await until(async () => (await footer.find({ type: 'Text' }))?.text === 'focus')

    expect(pinned).toEqual([])
    end()
  })

  test('asks for setup, and speaks nothing, while the voice is not installed', async ($, on) => {
    const toasts: string[] = []
    const written: string[] = []
    mock.store(on)
    mock.env(on, { USERPROFILE: HOME })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('ui.log', () => ({ value: undefined }))
    on('fs.exists', () => ({ value: false }))
    on('fs.write', (_$, e) => {
      written.push(e.path)

      return { value: undefined }
    })
    await begin($)
    await $.turn.complete(answered('Nobody hears this.'))

    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('/read-aloud setup')
    expect(written).toEqual([])
  })
})
