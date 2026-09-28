export function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="empty">
      <div className="empty__title">{loading ? "CONTACTING HUB" : "NO OPERATORS ON THE FLOOR"}</div>
      {loading ? (
        <p className="empty__hint">Listening on /ws for the first snapshot.</p>
      ) : (
        <>
          <p className="empty__hint">
            Wire a project into mission control, then start Claude Code there:
          </p>
          <pre className="empty__code">task wire DIR=/path/to/project</pre>
          <p className="empty__hint">Or look around the floor with simulated operators.</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              location.search = "?mock=1";
            }}
          >
            Open mock mode
          </button>
        </>
      )}
    </div>
  );
}
