"""Installs the speech runtime of the read-aloud mod.

Everything goes under one folder outside the mod (READ_ALOUD_HOME, or
~/.claude/read-aloud): a virtual environment with kokoro-onnx and sounddevice,
and the Kokoro-82M model files (Apache-2.0), about 340 MB in all.

    python setup.py            every step
    python setup.py venv       the virtual environment alone
    python setup.py deps       the packages alone
    python setup.py models     the model files alone
    python setup.py check      says what is in place, installs nothing

Each step skips what is already there, so running it again is safe.
"""

import os
import subprocess
import sys
import urllib.request
import venv
from pathlib import Path

HOME = Path(os.environ.get("READ_ALOUD_HOME") or Path.home() / ".claude" / "read-aloud")
VENV = HOME / "venv"
MODELS = HOME / "models"
PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

PACKAGES = ["kokoro-onnx>=0.4.9", "sounddevice>=0.5"]
RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]


def say(line):
    print(line, flush=True)


def make_venv():
    if PYTHON.exists():
        say(f"venv: already at {VENV}")
        return
    say(f"venv: creating {VENV}")
    venv.EnvBuilder(with_pip=True).create(VENV)


def install_packages():
    say("deps: installing " + ", ".join(PACKAGES))
    subprocess.run(
        [str(PYTHON), "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", *PACKAGES],
        check=True,
    )


def download(name):
    target = MODELS / name
    if target.exists() and target.stat().st_size > 0:
        say(f"models: {name} already there ({target.stat().st_size // 2**20} MB)")
        return
    MODELS.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    say(f"models: downloading {name}")
    with urllib.request.urlopen(RELEASE + name) as response, open(part, "wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        shown = -1
        while True:
            block = response.read(1 << 20)
            if not block:
                break
            out.write(block)
            done += len(block)
            tenth = (done * 10 // total) if total else 0
            if tenth != shown:
                shown = tenth
                say(f"models: {name} {done // 2**20} MB" + (f" of {total // 2**20}" if total else ""))
    part.replace(target)


def check():
    is_ready = PYTHON.exists() and all((MODELS / name).exists() for name in FILES)
    say(f"home: {HOME}")
    say(f"venv: {'ok' if PYTHON.exists() else 'missing'}")
    for name in FILES:
        say(f"{name}: {'ok' if (MODELS / name).exists() else 'missing'}")
    return is_ready


def main():
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step == "check":
        sys.exit(0 if check() else 1)
    if step in ("all", "venv"):
        make_venv()
    if step in ("all", "deps"):
        install_packages()
    if step in ("all", "models"):
        for name in FILES:
            download(name)
    say("read-aloud: ready" if check() else "read-aloud: not complete yet")


if __name__ == "__main__":
    main()
