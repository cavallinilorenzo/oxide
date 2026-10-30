# Oxide

Oxide is a desktop app for agentic engineering. Developers open a local Project,
work with installed coding Providers through Threads, and use Git and GitHub from
the same window. Project and Thread terminology is defined in GLOSSARY.md.

## Platform

Desktop, built with Tauri. Windows is the user's current platform; existing native
functionality also targets macOS and Linux. Files and child processes belong to
Core, never to a webview filesystem or shell permission.

## Workflows

The Thread and its Transcript stay in the centre. A collapsible sidebar holds
Projects and recent Threads. One right dock holds Diff, Files, Terminal,
Pull request and Issues; each Surface can be maximized and restored.
Work modes are removed. Files contains the editor, and Project terminal tabs
retain their own checkout. Switching tools or their presentation keeps open files,
unsaved changes and shell sessions. The Project's sidebar Board button opens its
Thread Board in the centre and suspends the dock without clearing its state.

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
