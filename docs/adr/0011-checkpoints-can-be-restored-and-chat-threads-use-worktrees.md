# Checkpoints can be restored, and chat Threads work in a worktree by default

Two glossary rules are reversed on purpose, to serve the path to a confident merge (ADR-0010). This ADR explicitly supersedes the earlier glossary rules "nothing is ever restored from a Checkpoint" and "a Thread started from the chat works in the Project's main checkout".

## Checkpoints can be restored

The glossary said a Checkpoint is read-only. Now a Thread's files can be restored to how they were before a chosen Turn. Reason: a wrong Turn cannot be undone today, so the user must reprompt or clean up by hand, and competing tools already offer restore.

- Restore writes the chosen Turn's start Checkpoint back to the working tree, after taking a safety Checkpoint so that a restore can itself be undone. It does not move HEAD or branches and leaves ignored files alone.
- Undoing a restore puts back the files the restore changed, as the safety Checkpoint had them; work done after the restore stays where it is.
- It is refused while a Turn is running or while another working Thread shares the checkout.
- The Provider session is not rewound (ADR-0002, ADR-0001). The Transcript records a restore marker and the next prompt tells the agent which files were restored.
- Reverting a single hunk or file is a separate, all-or-nothing reverse patch, not a restore.

## Chat Threads work in a worktree by default

The glossary said only a Board Thread has a worktree of its own. Now a new chat Thread creates a worktree with its first prompt, through the path Board Threads use, including the Setup command. Reason: in a shared checkout a Turn diff can include other Threads' changes, so Turn diffs are misattributed and the Verification Dossier, which is computed from them, would be wrong.

- A per-Project setting opts out, for repositories where worktrees are impractical.
- Threads that already exist keep their checkout; the default never moves running work.
- Uncommitted changes stay behind in the main checkout, and the user is told so.
- Deleting a Thread removes its worktree and keeps its branch, as ADR-0005 already says for Board Threads.

## Consequences

- ADR-0005 stays. The Review ledger keeps only numbers and identifiers, never Transcript content, so deleting a Thread still removes its Transcript, Attachments and Checkpoints for good.
- ADR-0009 stays: Thread Git operations resolve that Thread's checkout, which is now usually its own worktree.
- The glossary entries for Checkpoint, Thread, Board Thread and Diff scope are updated to match.
