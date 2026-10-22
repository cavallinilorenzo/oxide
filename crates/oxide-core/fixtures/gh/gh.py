#!/usr/bin/env python3
"""A scripted stand-in for the GitHub CLI, placed on PATH in tests.

State lives next to this script in `state.json`, which the test writes:
  {"auth": "ok" | "logged_out", "default_branch": "main", "next_number": 7, "prs": {"<branch>": {...}}}
Every invocation is appended to `calls.jsonl` as {"args": [...], "cwd": "..."}.
"""
import json
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
state_path = os.path.join(here, "state.json")
args = sys.argv[1:]

with open(os.path.join(here, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"args": args, "cwd": os.getcwd()}) + "\n")

with open(state_path) as f:
    state = json.load(f)


def flag(name):
    return args[args.index(name) + 1] if name in args else None


def branch():
    out = subprocess.run(["git", "branch", "--show-current"], capture_output=True, text=True)
    return out.stdout.strip()


if args[:2] == ["auth", "status"]:
    if state.get("auth") == "ok":
        print("Logged in to github.com account fake (keyring)")
        sys.exit(0)
    sys.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\n")
    sys.exit(1)

if args[:2] == ["repo", "view"]:
    print(json.dumps({"defaultBranchRef": {"name": state.get("default_branch", "main")}}))
    sys.exit(0)

if args[:2] == ["pr", "view"]:
    pr = state.get("prs", {}).get(branch())
    if pr is None:
        sys.stderr.write('no pull requests found for branch "%s"\n' % branch())
        sys.exit(1)
    print(json.dumps(pr))
    sys.exit(0)

if args[:2] == ["pr", "create"]:
    number = state.get("next_number", 1)
    head = flag("--head") or branch()
    pr = {
        "number": number,
        "title": flag("--title"),
        "url": "https://github.com/fake/repo/pull/%d" % number,
        "state": "OPEN",
        "isDraft": "--draft" in args,
        "baseRefName": flag("--base"),
        "headRefName": head,
    }
    state.setdefault("prs", {})[head] = pr
    state["next_number"] = number + 1
    with open(state_path, "w") as f:
        json.dump(state, f)
    print(pr["url"])
    sys.exit(0)

sys.stderr.write("fake gh: unsupported arguments %r\n" % args)
sys.exit(2)
