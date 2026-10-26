#!/usr/bin/env python3
import sys
import os
import json

wire_log_path = os.environ.get("OXIDE_WIRE_LOG")

def log_wire(entry):
    if wire_log_path:
        with open(wire_log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
            f.flush()

log_wire({"type": "argv", "args": sys.argv[1:]})

if "--version" in sys.argv or "-V" in sys.argv:
    version = os.environ.get("OXIDE_FAKE_VERSION", "0.163.0")
    print(f"codex-cli {version}")
    sys.exit(0)

if len(sys.argv) >= 3 and sys.argv[1] == "login" and sys.argv[2] == "status":
    logged_in = os.environ.get("OXIDE_FAKE_LOGGED_IN", "1") == "1"
    if logged_in:
        print("Logged in using ChatGPT")
        sys.exit(0)
    else:
        print("Not logged in")
        sys.exit(1)

# Running in app-server mode
def send_msg(msg):
    log_wire({"type": "send", "msg": msg})
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

version = os.environ.get("OXIDE_FAKE_VERSION", "0.163.0")
active_threads = {}
pending_approvals = {}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
    except Exception:
        continue

    log_wire({"type": "stdin", "data": data})

    # Check if it is a response to a server-initiated request
    if "result" in data and "id" in data:
        req_id = str(data["id"])
        log_wire({"type": "approval_response_received", "id": req_id, "result": data.get("result")})
        if req_id in pending_approvals:
            t_id = pending_approvals[req_id]
            # Emit turn completed
            send_msg({
                "method": "turn/completed",
                "params": {
                    "threadId": t_id,
                    "turn": {"id": "turn-1", "status": "completed"}
                }
            })
            del pending_approvals[req_id]
        continue

    method = data.get("method")
    msg_id = data.get("id")
    params = data.get("params", {})

    if method == "initialize":
        user_agent = f"oxide/{version} (Mac OS 27.0.1; arm64) codex/{version}"
        send_msg({
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "userAgent": user_agent,
                "codexHome": "/tmp/.codex",
                "platformFamily": "unix",
                "platformOs": "macos"
            }
        })
    elif method == "model/list":
        send_msg({
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "data": [
                    {
                        "id": "gpt-5",
                        "model": "gpt-5",
                        "displayName": "GPT-5",
                        "supportedReasoningEfforts": [
                            {"reasoningEffort": "low", "description": "low"},
                            {"reasoningEffort": "high", "description": "high"}
                        ],
                        "inputModalities": ["text", "image"]
                    }
                ]
            }
        })
    elif method == "thread/start":
        thread_id = f"thread-codex-{len(active_threads) + 1}"
        active_threads[thread_id] = {
            "cwd": params.get("cwd", "."),
            "sandbox": params.get("sandbox"),
            "approvalPolicy": params.get("approvalPolicy"),
            "model": params.get("model")
        }
        send_msg({
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "thread": {
                    "id": thread_id,
                    "cwd": params.get("cwd", ".")
                }
            }
        })
        send_msg({
            "method": "thread/started",
            "params": {"thread": {"id": thread_id}}
        })
    elif method == "thread/resume":
        thread_id = params.get("threadId", "thread-codex-1")
        send_msg({
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "thread": {
                    "id": thread_id
                }
            }
        })
    elif method == "turn/start":
        t_id = params.get("threadId", "thread-codex-1")
        inputs = params.get("input", [])
        prompt_text = ""
        for inp in inputs:
            if inp.get("type") == "text":
                prompt_text = inp.get("text", "")

        if "deadlock_test" in prompt_text:
            # Send server-initiated approval BEFORE sending response to turn/start!
            send_msg({
                "jsonrpc": "2.0",
                "id": "appr-deadlock",
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "itemId": "item-cmd-deadlock",
                    "command": "cargo test deadlock",
                    "threadId": t_id,
                    "turnId": "turn-deadlock"
                }
            })
            # Wait for client to answer while turn/start is in flight
            while True:
                resp_line = sys.stdin.readline()
                if not resp_line:
                    break
                resp_data = json.loads(resp_line.strip())
                log_wire({"type": "stdin_during_flight", "data": resp_data})
                if str(resp_data.get("id")) == "appr-deadlock":
                    log_wire({"type": "deadlock_approval_answered_in_flight", "result": resp_data.get("result")})
                    break

            # Now send turn/start response
            send_msg({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"turn": {"id": "turn-deadlock", "status": "completed"}}
            })
            send_msg({
                "method": "turn/completed",
                "params": {
                    "threadId": t_id,
                    "turn": {"id": "turn-deadlock", "status": "completed"}
                }
            })
        elif "approval_test" in prompt_text:
            send_msg({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"turn": {"id": "turn-1", "status": "inProgress"}}
            })
            pending_approvals["appr-42"] = t_id
            send_msg({
                "jsonrpc": "2.0",
                "id": "appr-42",
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "itemId": "item-cmd-1",
                    "command": "Run cargo test",
                    "threadId": t_id,
                    "turnId": "turn-1"
                }
            })
        elif "interrupt_test" in prompt_text:
            send_msg({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"turn": {"id": "turn-1", "status": "inProgress"}}
            })
            send_msg({
                "method": "turn/started",
                "params": {
                    "threadId": t_id,
                    "turn": {"id": "turn-1", "status": "inProgress"}
                }
            })
            # Wait for turn/interrupt without sleeping
            send_msg({"method": "interrupt_ready", "params": {"threadId": t_id}})
        else:
            # Standard prompt replay
            send_msg({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"turn": {"id": "turn-1", "status": "inProgress"}}
            })
            send_msg({
                "method": "turn/started",
                "params": {
                    "threadId": t_id,
                    "turn": {"id": "turn-1", "status": "inProgress"}
                }
            })
            send_msg({
                "method": "item/started",
                "params": {
                    "threadId": t_id,
                    "turnId": "turn-1",
                    "item": {"id": "item-0", "type": "agentMessage", "text": ""}
                }
            })
            send_msg({
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": t_id,
                    "turnId": "turn-1",
                    "itemId": "item-0",
                    "delta": "Hello world!"
                }
            })
            send_msg({
                "method": "item/completed",
                "params": {
                    "threadId": t_id,
                    "turnId": "turn-1",
                    "item": {"id": "item-0", "type": "agentMessage", "text": "Hello world!"}
                }
            })
            send_msg({
                "method": "custom_unrecognized_event",
                "params": {"threadId": t_id, "data": 123}
            })
            send_msg({
                "method": "turn/completed",
                "params": {
                    "threadId": t_id,
                    "turn": {"id": "turn-1", "status": "completed"}
                }
            })
    elif method == "turn/interrupt":
        t_id = params.get("threadId", "thread-codex-1")
        if params.get("turnId") != "turn-1":
            send_msg({"jsonrpc": "2.0", "id": msg_id,
                      "error": {"code": -32602, "message": "turnId is required"}})
            continue
        send_msg({
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {}
        })
        send_msg({
            "method": "turn/completed",
            "params": {
                "threadId": t_id,
                "turn": {"id": "turn-1", "status": "interrupted"}
            }
        })
    else:
        # Unknown method or control
        send_msg({
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {}
        })

sys.exit(0)
