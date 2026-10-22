import { describe, expect, it } from "vitest";
import { applyThreadEvent, initialTranscriptState } from "./transcript";
import type { ThreadSnapshot } from "./bindings";

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
        },
      ],
      lastSeq: 5,
    };

    const state = initialTranscriptState(snapshot);
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
});
