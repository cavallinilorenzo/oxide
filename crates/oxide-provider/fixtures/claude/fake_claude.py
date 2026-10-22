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
            # Wait for SIGINT
            time.sleep(10)
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
        elif cmd == "interrupt":
            sigint_handler(signal.SIGINT, None)

sys.exit(0)
