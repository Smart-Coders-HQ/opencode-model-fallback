/**
 * Case-insensitive pattern matching against error messages.
 */
export function matchesAnyPattern(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}
