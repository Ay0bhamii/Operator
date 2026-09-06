export function formatCountdown(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function getGlobalRankText(rank: number, pointsAway: number, isGapMessage = false): string {
  if (isGapMessage) {
    return `#${Math.max(rank - 1, 1)} is only ${pointsAway} points away.`;
  }
  return `#${rank} GLOBAL`;
}
