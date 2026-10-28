# Oxide

Oxide is a desktop app for agentic engineering. Developers open a local Project,
work with installed coding Providers through Threads, and use Git and GitHub from
the same window. Project and Thread terminology is defined in GLOSSARY.md.

## Platform

Desktop, built with Tauri. Windows is the user's current platform; existing native
functionality also targets macOS and Linux. Files and child processes belong to
Core, never to a webview filesystem or shell permission.

## Workflows

The user requested three ways to use the central area:

- Chat: the existing Provider conversations and Thread Board.
- Terminal: a full central terminal, with command blocks, searchable history and
  suggestions, taking Warp's terminal workflow as a functional reference.
- Code: a capable editor with a restrained Zed-like layout, including language
  intelligence, automatic indentation, file tabs, navigation and syntax errors.

Switching modes preserves open files, unsaved changes and shell sessions.
Python, C/C++, JavaScript/TypeScript and Rust are the first supported languages.
Opening the first file of a language offers to download its support, as in Zed.
Downloads happen only after Install is pressed. Advanced settings retain custom
server executable paths, arguments and a Python interpreter path.

## Stack

The established stack is Rust Core, a thin Tauri shell, and React/TypeScript.
The editor uses Monaco; terminal rendering uses the existing xterm integration.
Local language servers provide language intelligence without an extension system.

## Brand and interaction commitments

Extend the incumbent dark surfaces, GitHub-blue actions and Octicons vocabulary.
Keep working controls compact and the primary content prominent. Use restrained
motion, honor reduced motion, and preserve keyboard access and visible focus.
