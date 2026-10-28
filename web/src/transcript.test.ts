import { describe, expect, it } from "vitest";
import { applyThreadEvent, initialTranscriptState, SESSION_LOST_MESSAGE } from "./transcript";
import { getOfferedPermissionModes } from "./ThreadView";
import type { SequencedThreadEvent, Thread, ThreadSnapshot } from "./bindings";

describe("transcript reducer", () => {
  it("initializes state from a snapshot", () => {
    const snapshot: ThreadSnapshot = {
      thread: {
        id: 1,
        projectId: 1,
        provider: "fake",
        model: null,
        effort: null,
        permissionMode: "auto-edit",
        status: "completed",
        createdAt: "2026-10-22T10:00:00Z",
        updatedAt: "2026-10-22T10:00:00Z",
        sessionLost: false,
        continuedFrom: null,
        continuedIn: null,
      },
      capabilities: { reasoningText: true, imageAttachments: false },
      turns: [
        {
          id: 10,
          turnIndex: 0,
          prompt: "Hello",
          model: null,
          effort: null,
          attachments: [],
          status: "completed",
          startedAt: "2026-10-22T10:00:00Z",
          completedAt: "2026-10-22T10:00:05Z",
          items: [
            {
              id: 100,
              itemIndex: 0,
              kind: "agent_message",
              content: "Hi there!",
              parentItemIndex: null,
              createdAt: "2026-10-22T10:00:02Z",
            },
          ],
          approvals: [],
          unknownEvents: [],
        },
      ],
      turnOffset: 41,
      turnCount: 42,
      lastSeq: 5,
      supportedPermissionModes: ["ask", "auto-edit", "full-access"],
    };

    const state = initialTranscriptState(snapshot);
    expect(state.turnOffset).toBe(41);
    expect(state.thread?.id).toBe(1);
    expect(state.turns.length).toBe(1);
    expect(state.turns[0].items[0].content).toBe("Hi there!");
    expect(state.lastSeq).toBe(5);
    expect(state.capabilities.reasoningText).toBe(true);
  });

  it("applies streaming turn and batched deltas in sequence", () => {
    let state = initialTranscriptState(null);

    // TurnStarted
    state = applyThreadEvent(state, {
      seq: 1,
      event: {
        type: "TurnStarted",
        payload: {
          turn_index: 0,
          prompt: "Streaming prompt",
          model: "Opus 5.5",
          effort: "high",
          attachments: ["/home/.oxide/attachments/a.png"],
        },
      },
    });
    expect(state.turns.length).toBe(1);
    expect(state.turns[0].prompt).toBe("Streaming prompt");
    expect(state.turns[0].status).toBe("running");
    expect(state.turns[0].model).toBe("Opus 5.5");
    expect(state.turns[0].effort).toBe("high");
    expect(state.turns[0].attachments).toEqual(["/home/.oxide/attachments/a.png"]);

    // ItemStarted
    state = applyThreadEvent(state, {
      seq: 2,
      event: {
        type: "ItemStarted",
        payload: {
          item_index: 0,
          kind: "agent_message",
          parent_item_index: null,
        },
      },
    });
    expect(state.turns[0].items.length).toBe(1);
    expect(state.turns[0].items[0].content).toBe("");

    // ItemDeltaBatch
    state = applyThreadEvent(state, {
      seq: 3,
      event: {
        type: "ItemDeltaBatch",
        payload: {
          item_index: 0,
          delta: "Chunk 1 ",
        },
      },
    });
    expect(state.turns[0].items[0].content).toBe("Chunk 1 ");

    // Second ItemDeltaBatch
    state = applyThreadEvent(state, {
      seq: 4,
      event: {
        type: "ItemDeltaBatch",
        payload: {
          item_index: 0,
          delta: "Chunk 2",
        },
      },
    });
    expect(state.turns[0].items[0].content).toBe("Chunk 1 Chunk 2");

    // ItemCompleted
    state = applyThreadEvent(state, {
      seq: 5,
      event: {
        type: "ItemCompleted",
        payload: {
          item_index: 0,
          kind: "agent_message",
          content: "Chunk 1 Chunk 2",
        },
      },
    });
    expect(state.turns[0].items[0].content).toBe("Chunk 1 Chunk 2");

    // TurnCompleted & status change
    state = applyThreadEvent(state, {
      seq: 6,
      event: {
        type: "TurnCompleted",
        payload: {
          turn_index: 0,
          status: "completed",
        },
      },
    });
    expect(state.turns[0].status).toBe("completed");

    state = applyThreadEvent(state, {
      seq: 7,
      event: {
        type: "ThreadStatusChanged",
        payload: {
          status: "completed",
        },
      },
    });
    expect(state.status).toBe("completed");
  });

  const startedTurn = () =>
    applyThreadEvent(initialTranscriptState(null), {
      seq: 1,
      event: { type: "TurnStarted", payload: { turn_index: 0, prompt: "Go", model: null, effort: null, attachments: [] } },
    });

  it("keeps a failed Turn's error message and stderr tail", () => {
    let state = startedTurn();
    state = applyThreadEvent(state, {
      seq: 2,
      event: {
        type: "TurnCompleted",
        payload: {
          turn_index: 0,
          status: "error",
          error: { message: "The Provider exited unexpectedly (exit code 1)", stderrTail: "boom" },
        },
      },
    });
    state = applyThreadEvent(state, {
      seq: 3,
      event: { type: "ThreadStatusChanged", payload: { status: "error" } },
    });

    expect(state.status).toBe("error");
    expect(state.turns[0].status).toBe("error");
    expect(state.turns[0].error).toEqual({
      message: "The Provider exited unexpectedly (exit code 1)",
      stderrTail: "boom",
    });
  });

  it("shows a Provider retry as a notice on the running Turn without changing status", () => {
    let state = startedTurn();
    state = applyThreadEvent(state, {
      seq: 2,
      event: { type: "ProviderRetrying", payload: { message: "Rate limited, retrying in 5s" } },
    });

    expect(state.status).toBe("working");
    expect(state.turns[0].retryNotice).toBe("Rate limited, retrying in 5s");

    state = applyThreadEvent(state, {
      seq: 3,
      event: { type: "TurnCompleted", payload: { turn_index: 0, status: "completed", error: null } },
    });
    expect(state.turns[0].retryNotice).toBeNull();
  });

  it("handles approval requested, responded, and auto-resolution on turn completion", () => {
    let state = initialTranscriptState(null);

    // TurnStarted
    state = applyThreadEvent(state, {
      seq: 1,
      event: {
        type: "TurnStarted",
        payload: {
          turn_index: 0,
          prompt: "Please delete files",
          model: null,
          effort: null,
          attachments: [],
        },
      },
    });

    // ApprovalRequested
    state = applyThreadEvent(state, {
      seq: 2,
      event: {
        type: "ApprovalRequested",
        payload: {
          id: "appr-1",
          kind: "command",
          summary: "rm -rf tmp",
          options: ["allow-always"],
        },
      },
    });

    expect(state.status).toBe("needs-input");
    expect(state.turns[0].approvals?.length).toBe(1);
    expect(state.turns[0].approvals[0].approvalId).toBe("appr-1");
    expect(state.turns[0].approvals[0].kind).toBe("command");
    expect(state.turns[0].approvals[0].summary).toBe("rm -rf tmp");
    expect(state.turns[0].approvals[0].decision).toBeNull();

    // ApprovalResponded
    state = applyThreadEvent(state, {
      seq: 3,
      event: {
        type: "ApprovalResponded",
        payload: {
          id: "appr-1",
          decision: "allow",
          decided_at: "2026-10-22T10:01:00Z",
        },
      },
    });

    expect(state.status).toBe("working");
    expect(state.turns[0].approvals[0].decision).toBe("allow");
    expect(state.turns[0].approvals[0].decidedAt).toBe("2026-10-22T10:01:00Z");

    // Second turn with unresolved approval that completes/interrupts
    state = applyThreadEvent(state, {
      seq: 4,
      event: {
        type: "TurnStarted",
        payload: {
          turn_index: 1,
          prompt: "Another action",
          model: null,
          effort: null,
          attachments: [],
        },
      },
    });

    state = applyThreadEvent(state, {
      seq: 5,
      event: {
        type: "ApprovalRequested",
        payload: {
          id: "appr-2",
          kind: "file-change",
          summary: "Edit file",
          options: [],
        },
      },
    });
    expect(state.status).toBe("needs-input");

    // TurnCompleted before responding -> resolves to deny
    state = applyThreadEvent(state, {
      seq: 6,
      event: {
        type: "TurnCompleted",
        payload: {
          turn_index: 1,
          status: "interrupted",
          error: null,
        },
      },
    });

    expect(state.turns[1].approvals[0].decision).toBe("deny");
  });

  it("filters offered permission modes per provider and applies soft-deny label for agy", () => {
    // Claude / Codex supports all 3
    const claudeModes = getOfferedPermissionModes(
      ["ask", "auto-edit", "full-access"],
      "claude"
    );
    expect(claudeModes).toEqual([
      { mode: "ask", label: "Ask", icon: "lock" },
      { mode: "auto-edit", label: "Auto-edit", icon: "shield-check" },
      { mode: "full-access", label: "Full access", icon: "unlock" },
    ]);

    // agy supports only auto-edit and full-access, and labels auto-edit as soft-deny
    const agyModes = getOfferedPermissionModes(
      ["auto-edit", "full-access"],
      "antigravity"
    );
    expect(agyModes).toEqual([
      { mode: "auto-edit", label: "Auto-edit (soft-deny)", icon: "shield-check" },
      { mode: "full-access", label: "Full access", icon: "unlock" },
    ]);

    // Provider that only supports AutoEdit
    const restrictedModes = getOfferedPermissionModes(["auto-edit"], "custom");
    expect(restrictedModes).toEqual([
      { mode: "auto-edit", label: "Auto-edit", icon: "shield-check" },
    ]);
  });

  it("appends a Turn on every TurnStarted, even when the Provider repeats its turn index", () => {
    let state = initialTranscriptState(null);
    state = applyThreadEvent(state, startTurn(1, "first"));
    state = applyThreadEvent(state, completeTurn(2));
    state = applyThreadEvent(state, startTurn(3, "second"));
    state = applyThreadEvent(state, completeTurn(4));

    expect(state.turns.map((t) => [t.prompt, t.status])).toEqual([
      ["first", "completed"],
      ["second", "completed"],
    ]);
  });

  it("carries a tool call's category from its start through completion", () => {
    let state = initialTranscriptState(null);
    state = applyThreadEvent(state, startTurn(1, "go"));
    state = applyThreadEvent(state, {
      seq: 2,
      event: { type: "ItemStarted", payload: { item_index: 0, kind: "tool_call", parent_item_index: null, category: "run" } },
    });
    expect(state.turns[0].items[0].category).toBe("run");
    state = applyThreadEvent(state, {
      seq: 3,
      event: { type: "ItemDeltaBatch", payload: { item_index: 0, delta: "out" } },
    });
    expect(state.turns[0].items[0].category).toBe("run");
    state = applyThreadEvent(state, {
      seq: 4,
      event: { type: "ItemCompleted", payload: { item_index: 0, kind: "tool_call", content: "Run ls", category: "run" } },
    });
    expect(state.turns[0].items[0].category).toBe("run");
  });

  it("keeps finalized Turns and Items as the same objects while another Item streams", () => {
    let state = initialTranscriptState(null);
    state = applyThreadEvent(state, startTurn(1, "earlier"));
    state = applyThreadEvent(state, completeTurn(2));
    state = applyThreadEvent(state, startTurn(3, "now"));
    state = applyThreadEvent(state, {
      seq: 4,
      event: { type: "ItemCompleted", payload: { item_index: 0, kind: "agent_message", content: "done" } },
    });
    const before = state;
    state = applyThreadEvent(state, {
      seq: 5,
      event: { type: "ItemDeltaBatch", payload: { item_index: 1, delta: "stream" } },
    });

    expect(state.turns[0]).toBe(before.turns[0]);
    expect(state.turns[1].items[0]).toBe(before.turns[1].items[0]);
    expect(state.turns[1].items[1].content).toBe("stream");
  });

  it("replays events that arrived before the snapshot on top of it, skipping those it already holds", () => {
    const base = initialTranscriptState(null);
    const snapshot = {
      ...base,
      thread: sampleThread(),
      status: "working" as const,
      lastSeq: 1,
      turns: applyThreadEvent(base, startTurn(1, "ciao")).turns,
    };
    const early = [startTurn(1, "ciao"), completeTurn(2)];

    const state = early.reduce(applyThreadEvent, snapshot);

    expect(state.turns.map((t) => [t.prompt, t.status])).toEqual([["ciao", "completed"]]);
    expect(state.lastSeq).toBe(2);
  });

  it("updates thread title on ThreadRenamed event", () => {
    let state = initialTranscriptState({
      thread: sampleThread(),
      capabilities: { reasoningText: true, imageAttachments: false },
      turns: [],
      turnOffset: 0,
      turnCount: 0,
      lastSeq: 0,
      supportedPermissionModes: ["ask", "auto-edit", "full-access"],
    });

    expect(state.thread?.title).toBeNull();

    state = applyThreadEvent(state, {
      seq: 1,
      event: {
        type: "ThreadRenamed",
        payload: {
          title: "New Custom Title",
        },
      },
    });

    expect(state.thread?.title).toBe("New Custom Title");
  });

  it("marks the Thread's session lost when the Provider session is gone", () => {
    const thread = { ...initialTranscriptState(null), thread: sampleThread() };

    const other = applyThreadEvent(thread, {
      seq: 1,
      event: { type: "Error", payload: { message: "boom" } },
    });
    expect(other.status).toBe("error");
    expect(other.thread?.sessionLost).toBe(false);

    const gone = applyThreadEvent(thread, {
      seq: 1,
      event: { type: "Error", payload: { message: SESSION_LOST_MESSAGE } },
    });
    expect(gone.status).toBe("error");
    expect(gone.thread?.sessionLost).toBe(true);
  });
});

function sampleThread(): Thread {
  return {
    id: 1,
    projectId: 1,
    provider: "fake",
    model: null,
    effort: null,
    permissionMode: "auto-edit",
    status: "completed",
    createdAt: "a",
    updatedAt: "b",
    title: null,
    sessionLost: false,
    continuedFrom: null,
    continuedIn: null,
  };
}

function startTurn(seq: number, prompt: string): SequencedThreadEvent {
  return { seq, event: { type: "TurnStarted", payload: { turn_index: 0, prompt, attachments: [] } } };
}

function completeTurn(seq: number): SequencedThreadEvent {
  return { seq, event: { type: "TurnCompleted", payload: { turn_index: 0, status: "completed", error: null } } };
}
