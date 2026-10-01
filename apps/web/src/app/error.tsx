"use client";

/** Last-resort boundary: a plain message, never a stack trace. */
export default function ErrorBoundary({
  reset,
}: {
  readonly error: Error;
  readonly reset: () => void;
}) {
  return (
    <div className="empty empty-error" role="alert">
      <h1>Something went wrong</h1>
      <p>This page could not be shown. Nothing was changed. Try again, or go back to the start.</p>
      <p>
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>{" "}
        <a className="btn btn-quiet" href="/">
          Back to the start
        </a>
      </p>
    </div>
  );
}
