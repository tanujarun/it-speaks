"""Installs and updates the speech runtime of the read-aloud mod.

Everything goes under one folder outside the mod (READ_ALOUD_HOME, or
~/.claude/read-aloud): a virtual environment with the packages, and the model
files, about 340 MB in all. What to install is read from models.json beside
this file: the packages, and each model file with its address and SHA-256.

    python setup.py            every step
    python setup.py update     the same: brings an install up to models.json
    python setup.py venv       the virtual environment alone
    python setup.py deps       the packages alone
    python setup.py models     the model files alone
    python setup.py check      says what is in place, installs nothing

Each step keeps what is already right, so running it again is safe: packages
are upgraded to their newest release, a model file is downloaded again only
when it is missing or is not the one models.json names, and a file an earlier
models.json installed and this one no longer names is removed.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
import venv
from pathlib import Path

HOME = Path(os.environ.get("READ_ALOUD_HOME") or Path.home() / ".claude" / "read-aloud")
VENV = HOME / "venv"
MODELS = HOME / "models"
RECORD = HOME / "installed.json"
PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

MANIFEST = json.loads(Path(__file__).with_name("models.json").read_text(encoding="utf-8"))
PACKAGES = MANIFEST["packages"]
FILES = MANIFEST["files"]


def say(line):
    print(line, flush=True)


def read_record():
    try:
        return json.loads(RECORD.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def make_venv():
    if PYTHON.exists():
        say(f"venv: already at {VENV}")
        return
    say(f"venv: creating {VENV}")
    venv.EnvBuilder(with_pip=True).create(VENV)


def package_versions():
    """The installed version of each package models.json names."""
    listed = subprocess.run(
        [str(PYTHON), "-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
        capture_output=True, text=True, check=False,
    )
    try:
        installed = {entry["name"].lower(): entry["version"] for entry in json.loads(listed.stdout)}
    except ValueError:
        installed = {}
    names = [re.split(r"[<>=!~ \[]", spec, maxsplit=1)[0].lower() for spec in PACKAGES]
    return {name: installed.get(name) for name in names}


def install_packages():
    before = package_versions()
    subprocess.run(
        [str(PYTHON), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--upgrade", *PACKAGES],
        check=True,
    )
    for name, version in package_versions().items():
        was = before.get(name)
        if was is None:
            say(f"packages: {name} {version} installed")
        elif was != version:
            say(f"packages: {name} {was} -> {version}")
        else:
            say(f"packages: {name} {version} is the newest")


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def is_right(entry):
    target = MODELS / entry["name"]
    if not target.exists() or target.stat().st_size == 0:
        return False
    return "sha256" not in entry or sha256_of(target) == entry["sha256"]


def download(entry):
    name = entry["name"]
    target = MODELS / name
    MODELS.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    say(f"models: downloading {name}")
    with urllib.request.urlopen(entry["url"]) as response, open(part, "wb") as out:
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
    if "sha256" in entry and sha256_of(part) != entry["sha256"]:
        part.unlink()
        raise SystemExit(f"models: {name} is not the file models.json names (SHA-256 differs); kept what was there")
    part.replace(target)


def sync_models():
    for entry in FILES:
        if is_right(entry):
            say(f"models: {entry['name']} is current")
        else:
            download(entry)
    wanted = {entry["name"] for entry in FILES}
    for name in read_record().get("files", []):
        stale = MODELS / name
        if name not in wanted and stale.exists():
            stale.unlink()
            say(f"models: removed {name}, which {MANIFEST['model']} does not use")


def write_record():
    record = {
        "model": MANIFEST["model"],
        "files": [entry["name"] for entry in FILES],
        "packages": package_versions(),
    }
    RECORD.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


def is_in_place():
    return PYTHON.exists() and all((MODELS / entry["name"]).exists() for entry in FILES)


def check():
    """Says what is in place, piece by piece."""
    say(f"home: {HOME}")
    say(f"venv: {'ok' if PYTHON.exists() else 'missing'}")
    for entry in FILES:
        say(f"{entry['name']}: {'ok' if (MODELS / entry['name']).exists() else 'missing'}")
    installed = read_record().get("model")
    if installed is not None and installed != MANIFEST["model"]:
        say(f"model: {installed} is installed; this mod uses {MANIFEST['model']}. Run: python setup.py update")
        return False
    return is_in_place()


def main():
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step == "check":
        sys.exit(0 if check() else 1)
    is_whole = step in ("all", "update")
    if is_whole or step == "venv":
        make_venv()
    if is_whole or step == "deps":
        install_packages()
    if is_whole or step == "models":
        sync_models()
    if is_in_place():
        write_record()
        say(f"read-aloud: ready ({MANIFEST['model']})")
    else:
        say("read-aloud: not complete yet; run python setup.py")


if __name__ == "__main__":
    main()
