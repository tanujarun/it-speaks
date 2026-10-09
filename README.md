# It Speaks

A Claude Code mod (`read-aloud`) that gives Claude a voice. It puts a small
`🔊 read` trigger under each of Claude's replies and each of your prompts:
press it and that one is read aloud, press it again to stop. Nothing is read
unless you ask. The voice is
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), an open-source
(Apache-2.0) text-to-speech model that runs locally on the CPU, so nothing you
or Claude write leaves the machine to be spoken.

Built on Claude Code's function hooks, which are early access and may change
between releases; written against Claude Code 2.1.295. Developed and used on
Windows 11. The speech process is plain Python and is written to run on macOS
and Linux too, but it has not been run there.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install read-aloud --marketplace tanujarun/it-speaks
```

Then install the voice (next section).

## Setup

The voice model and its Python runtime live outside the mod, in
`~/.claude/read-aloud` (about 340 MB of downloads). Install them once, either
from a session:

```
/read-aloud setup
```

or from a shell, with Python 3.10 or newer:

```
python tts/setup.py
```

`python tts/setup.py check` says what is in place. Deleting
`~/.claude/read-aloud` removes all of it.

## Updating

```
/read-aloud update
```

does three things and says what each came to:

- **Packages.** Upgrades the voice runtime's Python packages to their newest
  release, and names each change in the form `<package> <old> -> <new>`.
- **Model.** Checks each model file against the SHA-256 that `tts/models.json`
  names, downloads one that is missing or different, and removes a file an
  earlier version of the mod installed and this one no longer uses.
- **The mod.** Compares this copy's version with the one published here and
  says when it is behind. The mod itself is updated by Claude Code:
  `claude plugin update`, then `/reload-plugins`.

The speech process is stopped for the update and started again after it. If
packages fail to install with "access is denied", another Claude Code session
is speaking with them: `/hush` there, or close it, and run the update again.
From a shell the same is `python tts/setup.py update`.

A new model release reaches people as a new version of the mod: `models.json`
names the packages, each file's address and its checksum, so changing the
model is an edit to that one file, and `/read-aloud update` after the mod
updates brings an install in line with it.

## Reading what you pick

- **The trigger.** Click `🔊 read` under a reply or a prompt. It turns into
  `■ stop` while that row plays. The trigger is drawn where a click can reach
  a transcript row: the fullscreen terminal (`"tui": "fullscreen"`) and the
  desktop app. In a terminal that prints into scrollback it is left out.
- **`/read-aloud last`** reads Claude's last reply, on any surface.
- **`/read-aloud selection`** reads the text you selected with the mouse.
- **`/hush`** stops the speech. So does submitting a prompt or interrupting a
  turn.
- **The indicator.** While something is being read, the right end of the
  prompt's footer (the bottom right corner) says `reading aloud · /hush stops
  it`, beside the mode labels Claude Code shows there, and `loading the voice`
  while the model loads for the first utterance. Nothing is pinned to the
  status line under the prompt.

Code blocks and tables are named ("Code block.") rather than read out.

### With the skins mod

Where [skins](https://github.com/hellosverre/claude-skins) is installed and a
skin is on, the trigger wears it: `► read` with the glyph in the skin's accent
and the word in its muted colour, `■ stop` in its error colour, and `>` / `x`
under the skin's ASCII icons. It follows a change of skin as it happens. The
built-in skins' colours are kept in `hooks/skin-paint.ts`; a built-in added to
skins after this was written leaves the trigger in its plain look.

### With a mod that draws the same rows

The trigger wraps whatever draws the row beneath it. A mod that draws a prompt
or a reply itself (a skin) and is listed before this one in `enabledPlugins`
(`~/.claude/settings.json`) never hands the row down, so no trigger shows
there. List `read-aloud@...` first in `enabledPlugins`: plugins nest in that
order, first outermost. Then start a new session.

## Commands

| Command | What it does |
| --- | --- |
| `/hush` | Stops the speech now |
| `/read-aloud` | What is on, and the voices in use |
| `/read-aloud on` / `off` | Everything on or off |
| `/read-aloud triggers on` / `off` | The read trigger under each reply and prompt |
| `/read-aloud last` | Claude's last reply |
| `/read-aloud selection` | The text selected with the mouse |
| `/read-aloud say <text>` | Says the text |
| `/read-aloud voice <name>` | The voice for Claude (`/read-aloud voices` lists them) |
| `/read-aloud prompt-voice <name>` | The voice for your prompts |
| `/read-aloud speed <0.5-2>` | Speaking rate |
| `/read-aloud volume <0-200>` | Percent |
| `/read-aloud update` | Upgrades the voice packages and model; says if the mod is behind |

To have it read without being asked:

| Command | What it does |
| --- | --- |
| `/read-aloud replies all` / `final` / `off` | Everything Claude says as it lands, the final answer alone, or nothing (the default) |
| `/read-aloud prompts on` / `off` | Read your prompt back as you submit it (off by default) |
| `/read-aloud limit <characters>` | Longest reply read unasked; `0` reads all of it |

Settings are kept across sessions.

## How it works

`hooks/register.tsx` starts one small Python process per session
(`tts/daemon.py`) and hands it text through a spool folder of JSON files; the
process loads the model at the first utterance and lets it go after ten quiet
minutes. Subagents' output and non-interactive runs (`claude -p`) are never
read.

`claude plugin test .` runs the mod's tests; `tts/selftest.py`, run with the
runtime's Python, says a sentence through the real model.
