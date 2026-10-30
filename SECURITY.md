# Security policy

## Supported versions

Oxide is pre-1.0. Only the **latest release** gets security fixes. Fixes land on `main` and ship in the next release. Older versions are not patched.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's private vulnerability reporting: open the repository's [Security tab](https://github.com/cavallinilorenzo/oxide/security) and choose **Report a vulnerability**. Don't open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can:

- the Oxide version or commit
- your macOS or Windows version
- the Provider and Provider CLI version involved, if any
- steps to reproduce, the impact, and a proof of concept if you have one

## What to expect

Oxide is maintained by two people, [@cavallinilorenzo](https://github.com/cavallinilorenzo) and [@itsmrma](https://github.com/itsmrma), on a best-effort basis:

- an acknowledgement, usually within a week
- an assessment, and either a fix plan or a reasoned explanation if the report is out of scope
- coordinated disclosure: we publish a GitHub security advisory once a fix is released, crediting you unless you prefer otherwise

## Scope

Oxide is a desktop app that starts agent CLIs (Providers such as Claude Code, Codex and Antigravity CLI) **with your own user privileges**, on Projects you open. Keep this in mind when judging impact.

**In scope**, for example:

- Oxide performing an action the selected Permission mode should have prevented, such as a file edit or command running without the approval that Ask or Auto-edit requires
- the webview gaining filesystem, shell or process access beyond the Tauri commands Oxide exposes
- untrusted content (a repository, transcript, issue or Provider output) causing code execution or data exposure through Oxide itself
- Oxide leaking credentials or tokens, such as GitHub CLI tokens

**Out of scope**, because these are by design:

- anything a Provider does while running under **Full access**, or under any mode with approvals the user granted. Full access means nothing asks.
- actions a Provider takes with your privileges that its own CLI would also take outside Oxide. Report those to the Provider's vendor.
- vulnerabilities in the Provider CLIs themselves, in `git`, or in `gh`
- macOS Gatekeeper and Windows SmartScreen warnings on unsigned builds (see the [README](README.md#opening-an-unsigned-build))
