#!/usr/bin/env python3
"""A scripted stand-in for the GitHub CLI, placed on PATH in tests.

State lives next to this script in `state.json`, which the test writes:
  {"auth": "ok" | "logged_out", "default_branch": "main", "next_number": 7, "prs": {"<branch>": {...}},
   "repo": {"mergeCommitAllowed": true, ...}}
A PR may also carry "author", "body", "comments", "statusCheckRollup" and "diff" (a unified diff).
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


def save():
    with open(state_path, "w") as f:
        json.dump(state, f)


def by_number(n):
    for pr in state.get("prs", {}).values():
        if str(pr["number"]) == str(n):
            return pr
    sys.stderr.write("GraphQL: Could not resolve to a PullRequest with the number of %s.\n" % n)
    sys.exit(1)


def number_arg():
    return args[2] if len(args) > 2 and not args[2].startswith("-") else None


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
    repo = {
        "mergeCommitAllowed": True,
        "squashMergeAllowed": True,
        "rebaseMergeAllowed": True,
        "deleteBranchOnMerge": False,
    }
    repo.update(state.get("repo", {}))
    repo["defaultBranchRef"] = {"name": state.get("default_branch", "main")}
    print(json.dumps(repo))
    sys.exit(0)

if args[:2] == ["pr", "list"]:
    prs = [p for p in state.get("prs", {}).values() if p.get("state") == "OPEN"]
    prs.sort(key=lambda p: p["number"])
    if flag("--author") == "@me":
        prs = [p for p in prs if p.get("author", {}).get("login") == "me"]
    query = flag("--search")
    if query:
        prs = [p for p in prs if query.lower() in p["title"].lower()]
    print(json.dumps(prs))
    sys.exit(0)

if args[:2] == ["pr", "diff"]:
    print(by_number(number_arg()).get("diff", ""), end="")
    sys.exit(0)

if args[:2] == ["pr", "comment"]:
    pr = by_number(number_arg())
    pr.setdefault("comments", []).append(
        {"author": {"login": "me"}, "body": flag("--body"), "createdAt": "2026-01-01T00:00:00Z"}
    )
    save()
    sys.exit(0)

if args[:2] == ["pr", "merge"]:
    by_number(number_arg())["state"] = "MERGED"
    save()
    sys.exit(0)

if args[:2] == ["pr", "checkout"]:
    head = by_number(number_arg())["headRefName"]
    for cmd in (
        ["git", "fetch", "-q", "origin", head],
        ["git", "checkout", "-q", "-B", head, "FETCH_HEAD"],
    ):
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode != 0:
            sys.stderr.write(out.stderr)
            sys.exit(1)
    sys.exit(0)

if args[:2] == ["pr", "view"]:
    n = number_arg()
    pr = by_number(n) if n else state.get("prs", {}).get(branch())
    if pr is None:
        sys.stderr.write('no pull requests found for branch "%s"\n' % branch())
        sys.exit(1)
    print(json.dumps(pr))
    sys.exit(0)

if args[:2] == ["issue", "create"]:
    title = flag("--title")
    body = flag("--body") or ""
    num = state.get("next_number", 1)
    state["next_number"] = num + 1
    issue = {
        "number": num,
        "title": title,
        "body": body,
        "state": "OPEN",
        "author": {"login": "me"},
        "url": f"https://github.com/fake/repo/issues/{num}",
        "createdAt": "2026-01-01T00:00:00Z",
        "comments": []
    }
    state.setdefault("issues", []).append(issue)
    save()
    print(issue["url"])
    sys.exit(0)

if args[:2] == ["issue", "comment"]:
    num = args[2]
    body = flag("--body") or ""
    for issue in state.get("issues", []):
        if str(issue.get("number")) == str(num):
            issue.setdefault("comments", []).append({
                "author": {"login": "me"},
                "body": body,
                "createdAt": "2026-01-01T00:00:00Z"
            })
            break
    save()
    sys.exit(0)

if args[:2] == ["issue", "close"]:
    num = args[2]
    for issue in state.get("issues", []):
        if str(issue.get("number")) == str(num):
            issue["state"] = "CLOSED"
            break
    save()
    sys.exit(0)

if args[:2] == ["issue", "view"]:
    n = args[2]
    found = None
    for issue in state.get("issues", []):
        if str(issue.get("number")) == str(n):
            found = issue
            break
    if found is None:
        sys.stderr.write(f"issue {n} not found\n")
        sys.exit(1)
    print(json.dumps(found))
    sys.exit(0)

if args[:2] == ["issue", "list"]:
    wanted_state = flag("--state")
    if wanted_state == "all":
        issues = list(state.get("issues", []))
    elif wanted_state == "closed":
        issues = [i for i in state.get("issues", []) if i.get("state") == "CLOSED"]
    else:
        issues = [i for i in state.get("issues", []) if i.get("state") == "OPEN"]
    issues.sort(key=lambda i: i["number"])
    query = flag("--search")
    if query:
        issues = [i for i in issues if query.lower() in i.get("title", "").lower() or query.lower() in i.get("body", "").lower()]
    print(json.dumps(issues))
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
    save()
    print(pr["url"])
    sys.exit(0)

sys.stderr.write("fake gh: unsupported arguments %r\n" % args)
sys.exit(2)
