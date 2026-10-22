import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { PaperclipIcon, XIcon } from "@primer/octicons-react";
import {
  commands,
  type SequencedThreadEvent,
  type Thread,
  type ThreadCapabilities,
  type ThreadStatus,
} from "./bindings";
import { TurnView } from "./TurnView";
import { applyThreadEvent, initialTranscriptState, type TranscriptState } from "./transcript";

interface ThreadViewProps {
  threadId: number | null;
  projectId: number;
  onThreadCreated: (thread: Thread) => void;
  onStatusChange: (threadId: number, status: ThreadStatus) => void;
}

const NEW_THREAD_PROVIDER = "fake";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

interface PendingImage {
  path: string;
  previewUrl: string;
}

export function ThreadView({
  threadId,
  projectId,
  onThreadCreated,
  onStatusChange,
}: ThreadViewProps) {
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscriptState(null));
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [newThreadCaps, setNewThreadCaps] = useState<ThreadCapabilities | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Before a Thread exists, ask what the Provider it will use supports.
  useEffect(() => {
    if (threadId) return;
    let active = true;
    void commands.providerCapabilities(NEW_THREAD_PROVIDER).then((caps) => {
      if (active) setNewThreadCaps(caps);
    });
    return () => {
      active = false;
    };
  }, [threadId]);

  const imagesOffered = (threadId ? transcript.capabilities : newThreadCaps)?.imageAttachments ?? false;

  const addImage = async (file: File) => {
    const ext = IMAGE_EXTENSIONS[file.type];
    if (!ext) return;
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    const saved = await commands.saveAttachment(bytes, ext);
    if (saved.status !== "ok") {
      console.error("Failed to store image:", saved.error);
      return;
    }
    setPendingImages((prev) => [...prev, { path: saved.data, previewUrl: URL.createObjectURL(file) }]);
  };

  const removeImage = (path: string) => {
    setPendingImages((prev) => {
      const gone = prev.find((i) => i.path === path);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((i) => i.path !== path);
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!imagesOffered) return;
    const files = Array.from(e.clipboardData.files).filter((f) => f.type in IMAGE_EXTENSIONS);
    if (files.length === 0) return;
    e.preventDefault();
    files.forEach((f) => void addImage(f));
  };

  // Auto-scroll to bottom as messages stream in
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.turns]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || sending) return;

    setSending(true);
    setInput("");

    try {
      let targetThreadId = threadId;
      if (!targetThreadId) {
        // Create new thread for this project
        const created = await commands.createThread(
          projectId,
          NEW_THREAD_PROVIDER,
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

      const attachments = pendingImages.map((i) => i.path);
      pendingImages.forEach((i) => URL.revokeObjectURL(i.previewUrl));
      setPendingImages([]);
      await commands.sendPrompt(targetThreadId, prompt, attachments);
    } finally {
      setSending(false);
    }
  };

  const isWorking = transcript.status === "working";

  return (
    <div className="thread-container">
      <div className="transcript" aria-label="Transcript">
        {transcript.turns.length === 0 ? (
          <div className="empty-thread">
            <p>Pick a Project, type a prompt, and watch the agent message stream in.</p>
          </div>
        ) : (
          transcript.turns.map((turn, tIdx) => (
            <TurnView
              key={turn.id || tIdx}
              turn={turn}
              provider={transcript.thread?.provider ?? NEW_THREAD_PROVIDER}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        {pendingImages.length > 0 && (
          <div className="pending-images">
            {pendingImages.map((img) => (
              <div className="pending-image" key={img.path}>
                <img src={img.previewUrl} alt="Pending attachment" />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => removeImage(img.path)}
                >
                  <XIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          {imagesOffered && (
            <>
              <button
                type="button"
                className="composer-attach"
                aria-label="Attach image"
                disabled={isWorking || sending}
                onClick={() => fileInputRef.current?.click()}
              >
                <PaperclipIcon size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  Array.from(e.target.files ?? []).forEach((f) => void addImage(f));
                  e.target.value = "";
                }}
              />
            </>
          )}
          <input
            type="text"
            className="composer-input"
            placeholder={isWorking ? "Agent is working…" : "Type a prompt…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            disabled={isWorking || sending}
          />
          <button
            type="submit"
            className="composer-submit"
            disabled={!input.trim() || isWorking || sending}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
