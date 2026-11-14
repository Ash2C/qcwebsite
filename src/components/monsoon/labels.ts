// Small label helpers shared by the profile, the contact list and the match line.

export function stageLabel(key: string): string {
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
