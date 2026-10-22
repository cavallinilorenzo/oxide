import type {
  ItemSnapshot,
  SequencedThreadEvent,
  Thread,
  ThreadCapabilities,
  ThreadSnapshot,
  ThreadStatus,
  TurnSnapshot,
} from "./bindings";

export interface TranscriptState {
  thread: Thread | null;
  status: ThreadStatus;
  turns: TurnSnapshot[];
  capabilities: ThreadCapabilities;
  lastSeq: number;
}

const NO_CAPABILITIES: ThreadCapabilities = { reasoningText: false, imageAttachments: false };

export function initialTranscriptState(snapshot: ThreadSnapshot | null): TranscriptState {
  if (!snapshot) {
    return {
      thread: null,
      status: "completed",
      turns: [],
      capabilities: NO_CAPABILITIES,
      lastSeq: 0,
    };
  }
  return {
    thread: snapshot.thread,
    status: snapshot.thread.status,
    turns: snapshot.turns,
    capabilities: snapshot.capabilities,
    lastSeq: snapshot.lastSeq,
  };
}

function updateLastTurnItem(
  turns: TurnSnapshot[],
  itemIndex: number,
  updater: (existing: ItemSnapshot | undefined) => ItemSnapshot
): void {
  if (turns.length === 0) return;
  const lastTurnIndex = turns.length - 1;
  const turn = { ...turns[lastTurnIndex] };
  const items = [...turn.items];
  const idx = items.findIndex((i) => i.itemIndex === itemIndex);
  const existing = idx >= 0 ? items[idx] : undefined;
  const updated = updater(existing);
  if (idx >= 0) {
    items[idx] = updated;
  } else {
    items.push(updated);
  }
  turn.items = items;
  turns[lastTurnIndex] = turn;
}

export function applyThreadEvent(
  state: TranscriptState,
  sequenced: SequencedThreadEvent
): TranscriptState {
  if (sequenced.seq <= state.lastSeq) {
    return state;
  }

  const { event } = sequenced;
  const turns = [...state.turns];
  let status = state.status;

  switch (event.type) {
    case "TurnStarted": {
      status = "working";
      const existing = turns.findIndex((t) => t.turnIndex === event.payload.turn_index);
      const newTurn: TurnSnapshot = {
        id: existing >= 0 ? turns[existing].id : 0,
        turnIndex: event.payload.turn_index,
        prompt: event.payload.prompt,
        model: event.payload.model ?? null,
        effort: event.payload.effort ?? null,
        attachments: event.payload.attachments,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        items: existing >= 0 ? turns[existing].items : [],
      };
      if (existing >= 0) turns[existing] = newTurn;
      else turns.push(newTurn);
      break;
    }

    case "ItemStarted": {
      updateLastTurnItem(turns, event.payload.item_index, (existing) => ({
        id: existing ? existing.id : 0,
        itemIndex: event.payload.item_index,
        kind: event.payload.kind,
        content: existing ? existing.content : "",
        parentItemIndex: event.payload.parent_item_index ?? null,
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      }));
      break;
    }

    case "ItemDeltaBatch": {
      updateLastTurnItem(turns, event.payload.item_index, (existing) => ({
        id: existing ? existing.id : 0,
        itemIndex: event.payload.item_index,
        kind: existing ? existing.kind : "agent_message",
        content: (existing ? existing.content : "") + event.payload.delta,
        parentItemIndex: existing ? existing.parentItemIndex : null,
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      }));
      break;
    }

    case "ItemCompleted": {
      updateLastTurnItem(turns, event.payload.item_index, (existing) => ({
        id: existing ? existing.id : 0,
        itemIndex: event.payload.item_index,
        kind: event.payload.kind,
        content: event.payload.content,
        parentItemIndex: event.payload.parent_item_index ?? null,
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      }));
      break;
    }

    case "TurnCompleted": {
      const idx = turns.findIndex((t) => t.turnIndex === event.payload.turn_index);
      if (idx >= 0) {
        turns[idx] = {
          ...turns[idx],
          status: event.payload.status,
          completedAt: new Date().toISOString(),
        };
      }
      break;
    }

    case "ThreadStatusChanged": {
      status = event.payload.status;
      break;
    }

    case "ApprovalRequested": {
      status = "needs-input";
      break;
    }

    case "Error": {
      status = "error";
      break;
    }

    case "Unknown": {
      break;
    }
  }

  return {
    thread: state.thread ? { ...state.thread, status } : null,
    status,
    turns,
    capabilities: state.capabilities,
    lastSeq: sequenced.seq,
  };
}
