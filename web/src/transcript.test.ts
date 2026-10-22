import { describe, expect, it } from "vitest";
import { applyThreadEvent, initialTranscriptState } from "./transcript";
import { getOfferedPermissionModes } from "./ThreadView";
import type { SequencedThreadEvent, ThreadSnapshot } from "./bindings";

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
        archived: false,
        createdAt: "2026-10-22T10:00:00Z",
        updatedAt: "2026-10-22T10:00:00Z",
      },
      turns: [
        {
          id: 10,
          turnIndex: 0,
          prompt: "Hello",
          status: "completed",
          startedAt: "2026-10-22T10:00:00Z",
          completedAt: "2026-10-22T10:00:05Z",
          items: [
            {
              id: 100,
              itemIndex: 0,
              kind: "agent_message",
              content: "Hi there!",
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
        },
      },
    });
    expect(state.turns.length).toBe(1);
    expect(state.turns[0].prompt).toBe("Streaming prompt");
    expect(state.turns[0].status).toBe("running");

    // ItemStarted
    state = applyThreadEvent(state, {
      seq: 2,
      event: {
        type: "ItemStarted",
        payload: {
          item_index: 0,
          kind: "agent_message",
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
      { mode: "ask", label: "Ask", icon: "🔒" },
      { mode: "auto-edit", label: "Auto-edit", icon: "🛡️" },
      { mode: "full-access", label: "Full access", icon: "🔓" },
    ]);

    // agy supports only auto-edit and full-access, and labels auto-edit as soft-deny
    const agyModes = getOfferedPermissionModes(
      ["auto-edit", "full-access"],
      "antigravity"
    );
    expect(agyModes).toEqual([
      { mode: "auto-edit", label: "Auto-edit (soft-deny)", icon: "🛡️" },
      { mode: "full-access", label: "Full access", icon: "🔓" },
    ]);

    // Provider that only supports AutoEdit
    const restrictedModes = getOfferedPermissionModes(["auto-edit"], "custom");
    expect(restrictedModes).toEqual([
      { mode: "auto-edit", label: "Auto-edit", icon: "🛡️" },
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
});

function startTurn(seq: number, prompt: string): SequencedThreadEvent {
  return { seq, event: { type: "TurnStarted", payload: { turn_index: 0, prompt } } };
}

function completeTurn(seq: number): SequencedThreadEvent {
  return { seq, event: { type: "TurnCompleted", payload: { turn_index: 0, status: "completed" } } };
}
