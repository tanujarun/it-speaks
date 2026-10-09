"""The speech process of the read-aloud mod: Kokoro-82M in, the speakers out.

The mod starts one per session and talks to it through a spool folder: each
command is a JSON file there, taken in name order and deleted.

    {"op": "speak", "id": "r3", "text": "...", "voice": "af_heart",
     "speed": 1.0, "gain": 1.0}
    {"op": "stop"}      drops what is queued and silences what is playing
    {"op": "quit"}

What it has to say goes to standard output, one JSON object per line:
ready (with the voices), loading, speaking, done, idle, error, and alive once
a minute.

The model loads at the first utterance and is let go after ten quiet minutes,
so an idle session holds a small Python process and no more.
"""

import argparse
import gc
import json
import os
import queue
import re
import sys
import threading
import time
import zipfile
from pathlib import Path

SAMPLE_RATE = 24000
BLOCK = 2048
POLL_SECONDS = 0.04
UNLOAD_AFTER_SECONDS = 600
CLOSE_STREAM_AFTER_SECONDS = 1.5
ORPHAN_AFTER_SECONDS = 6 * 3600
ALIVE_EVERY_TICKS = 1500  # a minute of polls
DEFAULT_VOICE = "af_heart"
LANGUAGES = {
    "a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi",
    "i": "it", "j": "ja", "p": "pt-br", "z": "cmn",
}


def emit(event, **fields):
    try:
        sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
        sys.stdout.flush()
    except OSError:
        os._exit(0)  # nobody is reading: the session is gone


def split_sentences(text):
    """Pieces short enough that the first one plays while the rest are made."""
    parts = [part.strip() for part in re.split(r"(?<=[.!?:;…])\s+|\n+", text)]
    pieces = []
    held = ""
    for part in parts:
        if not part:
            continue
        held = f"{held} {part}".strip()
        limit = 60 if not pieces else 220
        if len(held) >= limit:
            pieces.append(held)
            held = ""
    if held:
        pieces.append(held)
    return pieces


class ParentWatch:
    """Says when the process that started this one has gone."""

    def __init__(self):
        self.pid = os.getppid()
        self.handle = None
        self.is_watching = True
        self.started = time.monotonic()
        if os.name == "nt":
            import ctypes

            self.kernel = ctypes.windll.kernel32
            self.kernel.OpenProcess.restype = ctypes.c_void_p
            self.kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            self.handle = self.kernel.OpenProcess(0x00100000, False, self.pid)
            self.is_watching = bool(self.handle)

    def is_gone(self):
        if not self.is_watching:
            return False
        if os.name == "nt":
            is_gone = self.kernel.WaitForSingleObject(self.handle, 0) != 0x102
        else:
            is_gone = os.getppid() != self.pid
        if is_gone and time.monotonic() - self.started < 5:
            # Started through a launcher that has already left: no parent to
            # watch, so the quiet-hours limit ends this process instead.
            self.is_watching = False
            return False
        return is_gone


class Speaker:
    def __init__(self, models):
        self.model_path = str(models / "kokoro-v1.0.onnx")
        self.voices_path = str(models / "voices-v1.0.bin")
        self.voices = self.read_voice_names()
        self.kokoro = None
        self.lock = threading.Lock()
        self.generation = 0
        self.outstanding = 0
        self.jobs = queue.Queue()
        self.audio = queue.Queue()
        self.last_used = time.monotonic()
        threading.Thread(target=self.synthesize_forever, daemon=True).start()
        threading.Thread(target=self.play_forever, daemon=True).start()

    def read_voice_names(self):
        try:
            with zipfile.ZipFile(self.voices_path) as archive:
                return sorted(Path(name).stem for name in archive.namelist())
        except (OSError, zipfile.BadZipFile):
            return []

    # Commands, from the reader thread.

    def speak(self, job):
        text = str(job.get("text") or "").strip()
        if not text:
            return
        with self.lock:
            self.outstanding += 1
            generation = self.generation
        self.jobs.put((generation, {**job, "text": text}))

    def stop(self):
        with self.lock:
            self.generation += 1
            self.outstanding = 0
        for pending in (self.jobs, self.audio):
            while True:
                try:
                    pending.get_nowait()
                except queue.Empty:
                    break
        emit("idle")

    def is_current(self, generation):
        return generation == self.generation

    def finish(self, generation, job_id):
        with self.lock:
            if generation != self.generation:
                return
            self.outstanding = max(0, self.outstanding - 1)
            is_idle = self.outstanding == 0
        emit("done", id=job_id)
        if is_idle:
            emit("idle")

    # Text to samples.

    def load(self):
        if self.kokoro is None:
            emit("loading")
            from kokoro_onnx import Kokoro

            self.kokoro = Kokoro(self.model_path, self.voices_path)
        return self.kokoro

    def unload_when_quiet(self):
        is_quiet = time.monotonic() - self.last_used > UNLOAD_AFTER_SECONDS
        if self.kokoro is not None and is_quiet and self.outstanding == 0:
            self.kokoro = None
            gc.collect()

    def synthesize_forever(self):
        while True:
            try:
                generation, job = self.jobs.get(timeout=30)
            except queue.Empty:
                self.unload_when_quiet()
                continue
            job_id = job.get("id")
            try:
                self.synthesize(generation, job)
            except Exception as error:  # one bad utterance never ends the process
                emit("error", id=job_id, message=f"{type(error).__name__}: {error}"[:300])
                self.finish(generation, job_id)
            self.last_used = time.monotonic()

    def synthesize(self, generation, job):
        kokoro = self.load()
        voice = job.get("voice") or DEFAULT_VOICE
        if self.voices and voice not in self.voices:
            emit("error", id=job.get("id"), message=f"no voice named {voice}; using {DEFAULT_VOICE}")
            voice = DEFAULT_VOICE
        speed = min(2.0, max(0.5, float(job.get("speed") or 1.0)))
        gain = min(2.0, max(0.0, float(job.get("gain") if job.get("gain") is not None else 1.0)))
        language = LANGUAGES.get(voice[:1], "en-us")
        pieces = split_sentences(job["text"])
        for index, piece in enumerate(pieces):
            if not self.is_current(generation):
                return
            samples, rate = kokoro.create(piece, voice=voice, speed=speed, lang=language)
            if gain != 1.0:
                samples = samples * gain
            is_last = index == len(pieces) - 1
            self.audio.put((generation, job.get("id"), index == 0, is_last, samples, rate))
        if not pieces:
            self.finish(generation, job.get("id"))

    # Samples to the speakers.

    def play_forever(self):
        import numpy
        import sounddevice

        stream = None
        while True:
            try:
                generation, job_id, is_first, is_last, samples, rate = self.audio.get(
                    timeout=CLOSE_STREAM_AFTER_SECONDS
                )
            except queue.Empty:
                if stream is not None:
                    stream.close()  # lets the device sleep, and follows a new default
                    stream = None
                continue
            if not self.is_current(generation):
                continue
            try:
                if stream is None or stream.samplerate != rate:
                    if stream is not None:
                        stream.close()
                    stream = sounddevice.OutputStream(samplerate=rate, channels=1, dtype="float32")
                    stream.start()
                if is_first:
                    emit("speaking", id=job_id)
                data = numpy.clip(samples, -1.0, 1.0).astype("float32").reshape(-1, 1)
                for start in range(0, len(data), BLOCK):
                    if not self.is_current(generation):
                        stream.abort()
                        stream.close()
                        stream = None
                        break
                    stream.write(data[start : start + BLOCK])
            except Exception as error:
                emit("error", id=job_id, message=f"playback: {type(error).__name__}: {error}"[:300])
                if stream is not None:
                    try:
                        stream.close()
                    except Exception:
                        pass
                    stream = None
                is_last = True
            if is_last:
                self.finish(generation, job_id)


def take_commands(spool, speaker, undecoded):
    """Runs every command file in the spool, oldest name first."""
    try:
        names = sorted(name for name in os.listdir(spool) if name.endswith(".json"))
    except OSError:
        return True
    for name in names:
        path = os.path.join(spool, name)
        try:
            with open(path, encoding="utf-8") as file:
                command = json.load(file)
        except (OSError, ValueError):
            # Still being written: look again, and give up on it after a second.
            first_seen = undecoded.setdefault(name, time.monotonic())
            if time.monotonic() - first_seen < 1.0:
                return True
            command = None
        undecoded.pop(name, None)
        try:
            os.remove(path)
        except OSError:
            pass
        if not isinstance(command, dict):
            continue
        op = command.get("op")
        if op == "speak":
            speaker.speak(command)
        elif op == "stop":
            speaker.stop()
        elif op == "quit":
            return False
    return True


def sweep_dead_spools(spool):
    """Removes the spools a day old that a session killed outright left."""
    for other in spool.parent.iterdir():
        try:
            if other == spool or not other.is_dir():
                continue
            if time.time() - other.stat().st_mtime < 86400:
                continue
            for left in other.glob("*.json"):
                left.unlink(missing_ok=True)
            other.rmdir()
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spool", required=True)
    parser.add_argument("--models", required=True)
    args = parser.parse_args()

    # The mod may have written commands here already: they are kept.
    spool = Path(args.spool)
    spool.mkdir(parents=True, exist_ok=True)
    sweep_dead_spools(spool)

    speaker = Speaker(Path(args.models))
    parent = ParentWatch()
    emit("ready", pid=os.getpid(), voices=speaker.voices)

    undecoded = {}
    last_command = time.monotonic()
    ticks = 0
    try:
        while True:
            before = speaker.outstanding
            if not take_commands(str(spool), speaker, undecoded):
                break
            if speaker.outstanding or before:
                last_command = time.monotonic()
            ticks += 1
            if ticks % 50 == 0:
                if parent.is_gone():
                    break
                if time.monotonic() - last_command > ORPHAN_AFTER_SECONDS:
                    break
            if ticks % ALIVE_EVERY_TICKS == 0:
                # A venv's python.exe is a launcher that outlives a killed
                # session; writing to the session's pipe is what finds it gone.
                emit("alive")
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            for left in spool.glob("*.json"):
                left.unlink(missing_ok=True)
            spool.rmdir()
        except OSError:
            pass


if __name__ == "__main__":
    main()
