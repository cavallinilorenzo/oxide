import { memo, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  commands,
  type ItemSnapshot,
  type SequencedThreadEvent,
  type Thread,
  type ThreadStatus,
} from "./bindings";
import { stopsTurn } from "./shortcuts";
import {
  applyThreadEvent,
  initialTranscriptState,
  turnIsRunning,
  type TranscriptState,
  type TranscriptTurn,
} from "./transcript";

interface ThreadViewProps {
  threadId: number | null;
  projectId: number;
  onThreadCreated: (thread: Thread) => void;
  onStatusChange: (threadId: number, status: ThreadStatus) => void;
}

const ItemView = memo(function ItemView({ item }: { item: ItemSnapshot }) {
  return (
    <div className="message agent">
      <div className="message-header">
        Agent {item.kind !== "agent_message" && `(${item.kind})`}
      </div>
      <div className="message-content">{item.content}</div>
    </div>
  );
});

const TurnView = memo(function TurnView({ turn }: { turn: TranscriptTurn }) {
  return (
    <div className="turn">
      <div className="message user">
        <div className="message-header">You</div>
        <div className="message-content">{turn.prompt}</div>
      </div>
      {turn.items.map((item, iIdx) => (
        <ItemView key={item.id || iIdx} item={item} />
      ))}
      {turn.status === "running" && turn.retryNotice && (
        <div className="turn-notice" role="status">
          {turn.retryNotice}
        </div>
      )}
      {turn.status === "interrupted" && <div className="turn-notice">Interrupted</div>}
      {turn.status === "error" && (
        <div className="turn-error" role="alert">
          <div>{turn.error?.message ?? "The Turn failed"}</div>
          {turn.error?.stderrTail && <pre className="turn-stderr">{turn.error.stderrTail}</pre>}
        </div>
      )}
    </div>
  );
});

export function ThreadView({
  threadId,
  projectId,
  onThreadCreated,
  onStatusChange,
}: ThreadViewProps) {
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscriptState(null));
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pendingEventsRef = useRef<SequencedThreadEvent[]>([]);
  const rafIdRef = useRef<number>(0);

  // Subscribe to the thread when threadId changes
  useEffect(() => {
    let active = true;

    if (!threadId) {
      void Promise.resolve().then(() => {
        if (active) setTranscript(initialTranscriptState(null));
      });
      return () => {
        active = false;
      };
    }

    const channel = new Channel<SequencedThreadEvent>();
    channel.onmessage = (event) => {
      pendingEventsRef.current.push(event);
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = 0;
          const batch = pendingEventsRef.current;
          pendingEventsRef.current = [];
          if (!active || batch.length === 0) return;
          setTranscript((prev) => {
            let next = prev;
            for (const evt of batch) {
              next = applyThreadEvent(next, evt);
            }
            if (next.status !== prev.status) {
              onStatusChange(threadId, next.status);
            }
            return next;
          });
        });
      }
    };

    void (async () => {
      const res = await commands.subscribeThread(threadId, channel);
      if (active && res.status === "ok") {
        const initial = initialTranscriptState(res.data);
        setTranscript(initial);
        onStatusChange(threadId, initial.status);
      }
    })();

    return () => {
      active = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      pendingEventsRef.current = [];
    };
  }, [threadId, onStatusChange]);

  // Auto-scroll to bottom as messages stream in
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.turns]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || sending || turnIsRunning(transcript.status)) return;

    setSending(true);
    setInput("");

    try {
      let targetThreadId = threadId;
      if (!targetThreadId) {
        // Create new thread for this project
        const created = await commands.createThread(
          projectId,
          "fake",
          null,
          null,
          "auto-edit"
        );
        if (created.status === "ok") {
          targetThreadId = created.data.id;
          onThreadCreated(created.data);
        } else {
          console.error("Failed to create thread:", created.error);
          setSending(false);
          return;
        }
      }

      await commands.sendPrompt(targetThreadId, prompt);
    } finally {
      setSending(false);
    }
  };

  const isRunning = turnIsRunning(transcript.status);

  const stop = () => {
    if (threadId) void commands.interruptThread(threadId);
  };

  return (
    <div className="thread-container">
      <div className="transcript" aria-label="Transcript">
        {transcript.turns.length === 0 ? (
          <div className="empty-thread">
            <p>Pick a Project, type a prompt, and watch the agent message stream in.</p>
          </div>
        ) : (
          transcript.turns.map((turn, tIdx) => (
            <TurnView key={turn.id || tIdx} turn={turn} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <input
          type="text"
          className="composer-input"
          placeholder={isRunning ? "Working… (Esc to stop)" : "Type a prompt…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (stopsTurn(e, transcript.status)) {
              e.preventDefault();
              stop();
            }
          }}
          disabled={sending}
        />
        {isRunning ? (
          <button type="button" className="composer-submit" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="composer-submit" disabled={!input.trim() || sending}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
