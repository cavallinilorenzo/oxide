#!/usr/bin/env python3
"""Fake `agy`: replays recorded fixtures. One process per Turn, like the real print mode."""
import json
import os
import signal
import sys
import time

here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
wire_log = os.environ.get("OXIDE_WIRE_LOG")


def log_wire(entry):
    if wire_log:
        with open(wire_log, "a") as f:
            f.write(json.dumps(entry) + "\n")


def emit(line):
    sys.stdout.write(line.rstrip("\n") + "\n")
    sys.stdout.flush()


def replay(name):
    with open(os.path.join(here, name)) as f:
        for line in f:
            emit(line)


def option(name):
    return args[args.index(name) + 1] if name in args else None


log_wire({"type": "argv", "pid": os.getpid(), "args": args})

if "--version" in args:
    print(os.environ.get("OXIDE_FAKE_VERSION", "1.4.5"))
    sys.exit(0)

if args[:1] == ["models"]:
    if os.environ.get("OXIDE_FAKE_LOGGED_IN", "1") != "1":
        sys.stderr.write("authentication required\n")
        sys.exit(1)
    print("Fetching available models...")
    with open(os.path.join(here, "models.tsv")) as f:
        sys.stdout.write(f.read())
    sys.exit(0)

sys.stderr.write("s" * int(os.environ.get("OXIDE_FAKE_STARTUP_LOG_BYTES", "0")))
sys.stderr.flush()
prompt = option("-p") or option("--print") or ""
if option("--input-format") == "stream-json":
    message = json.loads(sys.stdin.readline())
    assert message["event"] == "user"
    prompt = message["message"]["content"]
log_wire({"type": "prompt", "prompt": prompt})
conversation = option("--conversation")


def on_sigint(signum, frame):
    emit(json.dumps({"event": "result", "result": {
        "conversation_id": conversation or "fake", "status": "INTERRUPTED",
        "response": "", "duration_seconds": 0, "num_turns": 1, "usage": {}}}))
    sys.exit(0)


signal.signal(signal.SIGINT, on_sigint)

init = json.load(open(os.path.join(here, "init.json")))
if conversation:
    init["conversation_id"] = conversation
if "--dangerously-skip-permissions" in args:
    init["init"]["permission_mode"] = "always-proceed"
emit(json.dumps(init))

if "interrupt_test" in prompt:
    time.sleep(10)
elif "crash_test" in prompt:
    sys.stderr.write("panic: something broke\n")
    sys.exit(7)
elif "tools_test" in prompt:
    replay("turn_tools.jsonl")
elif "error_test" in prompt:
    replay("turn_error.jsonl")
    sys.exit(3)
else:
    replay("turn_response.jsonl")
sys.exit(0)
