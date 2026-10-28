"""Small stdio LSP fixture: real framing and document notifications, no network."""
import json
import sys


def send(value):
    payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload)
    sys.stdout.buffer.flush()


while True:
    length = None
    while True:
        header = sys.stdin.buffer.readline()
        if not header:
            sys.exit(0)
        if header in (b"\r\n", b"\n"):
            break
        if header.lower().startswith(b"content-length:"):
            length = int(header.split(b":", 1)[1])
    request = json.loads(sys.stdin.buffer.read(length))
    method = request.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request["id"], "result": {"capabilities": {"textDocumentSync": 1, "completionProvider": {}}}})
    elif method in ("textDocument/didOpen", "textDocument/didChange"):
        params = request["params"]
        text = params.get("textDocument", {}).get("text", "")
        if method.endswith("didChange"):
            text = params["contentChanges"][0]["text"]
        diagnostics = []
        if "broken" in text:
            diagnostics = [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 6}}, "severity": 1, "message": "Syntax error: broken", "source": "fixture"}]
        send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": params["textDocument"]["uri"], "diagnostics": diagnostics}})
    elif method == "textDocument/completion":
        send({"jsonrpc": "2.0", "id": request["id"], "result": [{"label": "print", "kind": 3, "insertText": "print($1)", "insertTextFormat": 2}]})
    elif "id" in request:
        send({"jsonrpc": "2.0", "id": request["id"], "result": None})
