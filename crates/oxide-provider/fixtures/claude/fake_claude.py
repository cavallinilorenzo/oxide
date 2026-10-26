#!/usr/bin/env python3
import sys
import os
import json
import signal
import time

# Handle SIGINT by outputting an interrupted result
def sigint_handler(signum, frame):
    res = {
        "type": "result",
        "subtype": "interrupted",
        "session_id": "claude-session-1234",
        "result": "Turn interrupted by signal",
        "is_error": False
    }
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()

signal.signal(signal.SIGINT, sigint_handler)

wire_log_path = os.environ.get("OXIDE_WIRE_LOG")

def log_wire(entry):
    if wire_log_path:
        with open(wire_log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
            f.flush()

# Log argv
log_wire({"type": "argv", "args": sys.argv[1:]})

if "--version" in sys.argv:
    version = os.environ.get("OXIDE_FAKE_VERSION", "1.0.0")
    print(f"claude {version}")
    sys.exit(0)

if "--help" in sys.argv:
    if os.environ.get("OXIDE_FAKE_NO_SAFE_MODE") != "1":
        print("  --safe-mode    Start with all customizations disabled")
    sys.exit(0)

if len(sys.argv) >= 3 and sys.argv[1] == "auth" and sys.argv[2] == "status":
    logged_in = os.environ.get("OXIDE_FAKE_LOGGED_IN", "1") == "1"
    if logged_in:
        print('{"loggedIn": true}')
        sys.exit(0)
    else:
        print('{"loggedIn": false}')
        sys.exit(1)

# Stream-json mode
fixtures_dir = os.path.dirname(os.path.abspath(__file__))

# 1. Output system/init
init_file = os.path.join(fixtures_dir, "session_init.json")
if os.path.exists(init_file):
    with open(init_file, "r") as f:
        sys.stdout.write(f.read().strip() + "\n")
        sys.stdout.flush()

# Read stdin line by line
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
    except Exception:
        data = {"raw": line}

    log_wire({"type": "stdin", "data": data})

    if data.get("type") == "control_request":
        if (data.get("request") or {}).get("subtype") == "initialize":
            with open(os.path.join(fixtures_dir, "initialize_models.json"), "r") as f:
                models = json.load(f)
            with open(os.path.join(fixtures_dir, "initialize_commands.json"), "r") as f:
                commands = json.load(f)
            if "--disable-slash-commands" in sys.argv or "--safe-mode" in sys.argv:
                commands = [c for c in commands if c.get("builtin")]
            reply = {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": data.get("request_id"),
                    "response": {"models": models, "commands": commands},
                },
            }
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()
        elif (data.get("request") or {}).get("subtype") == "interrupt":
            # The CLI may use a normal result subtype after a control interrupt.
            print(json.dumps({"type": "result", "subtype": "success", "is_error": False}), flush=True)
        continue

    # Check for prompt
    if data.get("type") == "user" or "prompt" in data:
        prompt_text = ""
        if isinstance(data.get("message"), dict):
            prompt_text = data["message"].get("content", "")
        elif "prompt" in data:
            prompt_text = data["prompt"]

        if "approval_test" in prompt_text:
            # Emit approval request
            appr = {
                "type": "approval_request",
                "id": "appr-42",
                "kind": "command",
                "summary": "Run cargo test",
                "options": ["allow-once", "allow-always"]
            }
            sys.stdout.write(json.dumps(appr) + "\n")
            sys.stdout.flush()
        elif "interrupt_test" in prompt_text:
            # Keep reading stdin so protocol interrupts can be handled on every platform.
            print(json.dumps({"type": "interrupt_ready"}), flush=True)
        else:
            # Emit turn response fixture
            resp_file = os.path.join(fixtures_dir, "turn_response.jsonl")
            if os.path.exists(resp_file):
                with open(resp_file, "r") as f:
                    for resp_line in f:
                        sys.stdout.write(resp_line.strip() + "\n")
                        sys.stdout.flush()

    elif data.get("type") == "approval_response":
        # Received approval answer
        log_wire({"type": "approval_answered", "id": data.get("id"), "decision": data.get("decision")})
        res = {
            "type": "result",
            "subtype": "success",
            "session_id": "claude-session-1234",
            "result": "Approved and finished",
            "is_error": False
        }
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()

    elif data.get("type") == "control":
        cmd = data.get("command")
        if cmd == "set_model":
            log_wire({"type": "model_changed", "model": data.get("model")})
        elif cmd == "set_effort":
            log_wire({"type": "effort_changed", "effort": data.get("effort")})
        elif cmd == "set_permission_mode":
            log_wire({"type": "permission_mode_changed", "mode": data.get("mode")})

sys.exit(0)
