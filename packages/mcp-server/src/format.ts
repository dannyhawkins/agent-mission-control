/**
 * The tool result Claude reads. A typed answer (one that matches no option
 * label) is flagged so Claude treats it as the user's own words, not a choice.
 */
export function formatAnswer(options: { label: string }[], answer: string, note?: string): string {
  const picked = options.some((o) => o.label === answer);
  const head = picked ? `DECISION: ${answer}` : `DECISION (typed by the user): ${answer}`;
  return `${head}${note ? `\nNOTE: ${note}` : ""}`;
}
