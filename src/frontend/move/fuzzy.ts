/**
 * Small fuzzy matcher for folder names: "pos" should find "02-Posters".
 * Returns 0 when there is no match, otherwise a score where higher is better.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) {
    return 1;
  }

  const index = t.indexOf(q);
  if (index !== -1) {
    // Matches at the start of a word ("02-Posters" -> "posters") rank above matches in the middle of one
    const atWordStart = index === 0 || /[^a-z]/.test(t[index - 1]);
    return (atWordStart ? 1000 : 500) - index - (t.length - q.length) * 0.01;
  }

  // Otherwise all letters must appear in order: "lds" -> "LanDScapes"
  let position = -1;
  let gaps = 0;
  for (const char of q) {
    const next = t.indexOf(char, position + 1);
    if (next === -1) {
      return 0;
    }
    gaps += next - position - 1;
    position = next;
  }
  return Math.max(1, 100 - gaps);
}
