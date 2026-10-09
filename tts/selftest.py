"""Runs the speech process as the mod does and says one line through it.

    <home>/venv/Scripts/python selftest.py ["text to say"] [voice]

Prints each event the process reports with the seconds since the command was
written, then checks that a stop silences a long utterance at once.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HOME = Path(os.environ.get("READ_ALOUD_HOME") or Path.home() / ".claude" / "read-aloud")
TEXT = sys.argv[1] if len(sys.argv) > 1 else "Read aloud is working. This is Kokoro speaking."
VOICE = sys.argv[2] if len(sys.argv) > 2 else "af_heart"


def main():
    spool = Path(tempfile.mkdtemp(prefix="read-aloud-selftest-"))
    daemon = subprocess.Popen(
        [sys.executable, "-B", str(Path(__file__).with_name("daemon.py")),
         "--spool", str(spool), "--models", str(HOME / "models")],
        stdout=subprocess.PIPE, text=True,
    )
    events = []
    started = [time.monotonic()]
    counter = [0]

    def read():
        for line in daemon.stdout:
            event = json.loads(line)
            events.append(event)
            shown = {key: value for key, value in event.items() if key != "voices"}
            print(f"{time.monotonic() - started[0]:6.2f}s  {shown}", flush=True)

    threading.Thread(target=read, daemon=True).start()

    def send(command):
        counter[0] += 1
        (spool / f"{counter[0]:06d}.json").write_text(json.dumps(command), encoding="utf-8")

    def wait_for(name, seconds, since=0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if any(event["event"] == name for event in events[since:]):
                return True
            time.sleep(0.02)
        return False

    is_ok = wait_for("ready", 20)
    print(f"voices: {len(events[0].get('voices', [])) if events else 0}")

    started[0] = time.monotonic()
    send({"op": "speak", "id": "one", "text": TEXT, "voice": VOICE})
    is_ok = wait_for("speaking", 60) and is_ok
    is_ok = wait_for("idle", 120) and is_ok

    mark = len(events)
    started[0] = time.monotonic()
    send({"op": "speak", "id": "two", "voice": VOICE, "text": "This sentence is cut off. " * 20})
    is_ok = wait_for("speaking", 60, mark) and is_ok
    time.sleep(1.0)
    mark = len(events)
    stop_at = time.monotonic()
    send({"op": "stop"})
    is_ok = wait_for("idle", 5, mark) and is_ok
    print(f"stop took {time.monotonic() - stop_at:.2f}s")

    send({"op": "quit"})
    try:
        daemon.wait(timeout=10)
    except subprocess.TimeoutExpired:
        daemon.kill()
        is_ok = False
    print("selftest: ok" if is_ok and not spool.exists() else "selftest: FAILED")
    sys.exit(0 if is_ok else 1)


if __name__ == "__main__":
    main()
