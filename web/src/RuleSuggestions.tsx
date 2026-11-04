import { useCallback, useEffect, useState } from "react";
import { commands, type RuleSuggestion, type Thread } from "./bindings";

/**
 * Feedback the user keeps giving: when three or more sent Line comments, from at least two
 * Threads of the Project, say the same thing, the app offers to turn them into a rule for the
 * agent instructions. Accepting starts a Thread that proposes the edit, which the user reviews
 * like any change.
 */
export function RuleSuggestions({
  projectId,
  onAccepted,
}: {
  projectId: number;
  onAccepted: (thread: Thread) => void;
}) {
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);
  const [accepting, setAccepting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await commands.ruleSuggestions(projectId);
    if (result.status === "ok") setSuggestions(result.data ?? []);
    else setError(result.error.message);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void commands.ruleSuggestions(projectId).then((result) => {
      if (!active) return;
      if (result.status === "ok") setSuggestions(result.data ?? []);
      else setError(result.error.message);
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  async function dismiss(id: number) {
    const result = await commands.dismissRuleSuggestion(projectId, id);
    if (result.status === "ok") {
      setError(null);
      await load();
    } else setError(result.error.message);
  }

  async function accept(suggestion: RuleSuggestion) {
    setAccepting(suggestion.id);
    try {
      const { settings } = await commands.getSettings();
      const provider = settings.defaultProvider || "claude";
      const result = await commands.acceptRuleSuggestion(projectId, suggestion.id, provider);
      if (result.status === "ok") {
        setError(null);
        setSuggestions((previous) => previous.filter((s) => s.id !== suggestion.id));
        onAccepted(result.data);
      } else setError(result.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAccepting(null);
    }
  }

  if (suggestions.length === 0 && error === null) return null;
  return (
    <section className="rule-suggestions" aria-label="Rule suggestions">
      <h2>Rule suggestions</h2>
      <p className="dim">
        You keep giving similar feedback. Accepting starts a Thread that proposes a rule for the
        Project’s agent instructions, which you review like any other change.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul>
        {suggestions.map((suggestion) => (
          <li key={suggestion.id}>
            <div>
              <strong>{suggestion.comments.length} similar comments</strong>
              <ul
                className="rule-suggestion-comments"
                aria-label="Comments the suggestion is based on"
              >
                {suggestion.comments.map((comment, index) => (
                  <li key={index}>{comment}</li>
                ))}
              </ul>
            </div>
            <span className="actions">
              <button
                className="btn primary"
                disabled={accepting !== null}
                onClick={() => void accept(suggestion)}
              >
                {accepting === suggestion.id ? "Accepting…" : "Accept"}
              </button>
              <button
                className="btn"
                disabled={accepting !== null}
                onClick={() => void dismiss(suggestion.id)}
              >
                Dismiss
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
