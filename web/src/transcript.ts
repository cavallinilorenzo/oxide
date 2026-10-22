import type {
  ApprovalDecision,
  ApprovalSnapshot,
  ItemSnapshot,
  PermissionMode,
  SequencedThreadEvent,
  Thread,
  ThreadCapabilities,
  ThreadSnapshot,
  ThreadStatus,
  TurnSnapshot,
} from "./bindings";

/** A Turn as shown: the stored snapshot plus the live Provider retry notice, if any. */
export type TranscriptTurn = TurnSnapshot & { retryNotice?: string | null };

/**
 * The live tail of a Thread: `turns` are the Turns at positions
 * `turnOffset..turnOffset + turns.length`, which always runs to the newest
 * Turn. Older Turns are paged in separately (see `transcriptPages.ts`).
 */
export interface TranscriptState {
  thread: Thread | null;
  status: ThreadStatus;
  turns: TranscriptTurn[];
  turnOffset: number;
  capabilities: ThreadCapabilities;
  lastSeq: number;
  supportedPermissionModes: PermissionMode[];
}

/** The error Core reports when a Thread's Provider session can no longer be resumed. */
export const SESSION_LOST_MESSAGE = "Provider session no longer available";

/** A Turn is running (working, or waiting on an Approval), so Stop applies. */
export function turnIsRunning(status: ThreadStatus): boolean {
  return status === "working" || status === "needs-input";
}

const NO_CAPABILITIES: ThreadCapabilities = { reasoningText: false, imageAttachments: false };

export function initialTranscriptState(snapshot: ThreadSnapshot | null): TranscriptState {
  if (!snapshot) {
    return {
      thread: null,
      status: "completed",
      turns: [],
      turnOffset: 0,
      capabilities: NO_CAPABILITIES,
      lastSeq: 0,
      supportedPermissionModes: ["ask", "auto-edit", "full-access"],
    };
  }
  return {
    thread: snapshot.thread,
    status: snapshot.thread.status,
    turns: snapshot.turns.map((t) => ({ ...t, approvals: t.approvals || [] })),
    turnOffset: snapshot.turnOffset,
    capabilities: snapshot.capabilities,
    lastSeq: snapshot.lastSeq,
    supportedPermissionModes: snapshot.supportedPermissionModes || ["ask", "auto-edit", "full-access"],
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
  let sessionLost = state.thread?.sessionLost ?? false;

  switch (event.type) {
    case "TurnStarted": {
      // Always a new Turn: Providers may repeat turn indexes across sessions,
      // and replays are already dropped by `seq`.
      status = "working";
      turns.push({
        id: 0,
        turnIndex: event.payload.turn_index,
        prompt: event.payload.prompt,
        model: event.payload.model ?? null,
        effort: event.payload.effort ?? null,
        attachments: event.payload.attachments,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        items: [],
        error: null,
        retryNotice: null,
        approvals: [],
        unknownEvents: [],
      });
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
      // Only the newest Turn can be running.
      const idx = turns.length - 1;
      if (idx >= 0) {
        const turn = { ...turns[idx] };
        const approvals = (turn.approvals || []).map((app) =>
          app.decision ? app : { ...app, decision: "deny" as ApprovalDecision, decidedAt: new Date().toISOString() }
        );
        turns[idx] = {
          ...turn,
          status: event.payload.status,
          completedAt: new Date().toISOString(),
          error: event.payload.error ?? null,
          retryNotice: null,
          approvals,
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
      if (turns.length > 0) {
        const lastTurnIndex = turns.length - 1;
        const turn = { ...turns[lastTurnIndex] };
        const approvals = [...(turn.approvals || [])];
        const newApproval: ApprovalSnapshot = {
          id: 0,
          turnId: turn.id,
          approvalId: event.payload.id,
          kind: event.payload.kind,
          summary: event.payload.summary,
          options: event.payload.options || [],
          decision: null,
          createdAt: new Date().toISOString(),
          decidedAt: null,
        };
        approvals.push(newApproval);
        turn.approvals = approvals;
        turns[lastTurnIndex] = turn;
      }
      break;
    }

    case "ApprovalResponded": {
      let hasPending = false;
      for (let tIdx = turns.length - 1; tIdx >= 0; tIdx--) {
        const turn = { ...turns[tIdx] };
        let modified = false;
        const approvals = (turn.approvals || []).map((app) => {
          if (app.approvalId === event.payload.id) {
            modified = true;
            return {
              ...app,
              decision: event.payload.decision,
              decidedAt: event.payload.decided_at,
            };
          }
          if (!app.decision) {
            hasPending = true;
          }
          return app;
        });
        if (modified) {
          turn.approvals = approvals;
          turns[tIdx] = turn;
        }
      }
      if (!hasPending && status === "needs-input") {
        status = "working";
      }
      break;
    }

    case "Error": {
      status = "error";
      sessionLost ||= event.payload.message === SESSION_LOST_MESSAGE;
      break;
    }

    case "Unknown": {
      break;
    }
  }

  return {
    thread: state.thread ? { ...state.thread, status, sessionLost } : null,
    status,
    turns,
    turnOffset: state.turnOffset,
    capabilities: state.capabilities,
    lastSeq: sequenced.seq,
    supportedPermissionModes: state.supportedPermissionModes,
  };
}
