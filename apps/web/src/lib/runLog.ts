// Reading a Run's log text on the client.

/**
 * Why a run failed, from its log: the runner's final `ERROR:` / `ABORTED:`
 * line, with the line before it (the failing Step's own log line) for
 * context. Timestamps stripped. Falls back to the last line of the log.
 */
export function failureFromLog(logText: string | null | undefined): string | null {
  const lines = (logText ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(ERROR|ABORTED):/.test(lines[i]!)) {
      const prev = i > 0 ? lines[i - 1]! : null;
      const context = prev && !/^(===|restart|run failed|retry)/.test(prev) ? prev : null;
      return context ? `${context} → ${lines[i]}` : lines[i]!;
    }
  }
  return lines.at(-1)!;
}
