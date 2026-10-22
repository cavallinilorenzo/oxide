import type {
  ItemSnapshot,
  SequencedThreadEvent,
  Thread,
  ThreadSnapshot,
  ThreadStatus,
  TurnSnapshot,
} from "./bindings";

/** A Turn as shown: the stored snapshot plus the live Provider retry notice, if any. */
export type TranscriptTurn = TurnSnapshot & { retryNotice?: string | null };

export interface TranscriptState {
  thread: Thread | null;
  status: ThreadStatus;
  turns: TranscriptTurn[];
  lastSeq: number;
}

/** A Turn is running (working, or waiting on an Approval), so Stop applies. */
export function turnIsRunning(status: ThreadStatus): boolean {
  return status === "working" || status === "needs-input";
}

export function initialTranscriptState(snapshot: ThreadSnapshot | null): TranscriptState {
  if (!snapshot) {
    return {
      thread: null,
      status: "completed",
      turns: [],
      lastSeq: 0,
    };
  }
  return {
    thread: snapshot.thread,
    status: snapshot.thread.status,
    turns: snapshot.turns,
    lastSeq: snapshot.lastSeq,
  };
}

function updateLastTurnItem(
  turns: TranscriptTurn[],
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
      const newTurn: TranscriptTurn = {
        id: existing >= 0 ? turns[existing].id : 0,
        turnIndex: event.payload.turn_index,
        prompt: event.payload.prompt,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        items: existing >= 0 ? turns[existing].items : [],
        error: null,
        retryNotice: null,
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
          error: event.payload.error ?? null,
          retryNotice: null,
        };
      }
      break;
    }

    case "ProviderRetrying": {
      const last = turns.length - 1;
      if (last >= 0) {
        turns[last] = { ...turns[last], retryNotice: event.payload.message };
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
    lastSeq: sequenced.seq,
  };
}
