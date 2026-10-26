import { AlertIcon } from "@primer/octicons-react";

export function PullRequestError({
  title,
  guidance,
  message,
  onRetry,
}: {
  title: string;
  guidance?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="pr-feedback" role="alert">
      <AlertIcon size={16} />
      <div className="pr-feedback-content">
        <strong>{title}</strong>
        {guidance && <p>{guidance}</p>}
        <details>
          <summary>Technical details</summary>
          <pre>{message}</pre>
        </details>
        {onRetry && <button type="button" onClick={onRetry}>Try again</button>}
      </div>
    </div>
  );
}
