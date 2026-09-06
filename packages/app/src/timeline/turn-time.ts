import type { StreamItem } from "@/types/stream";

export interface TurnTiming {
  completedAt: Date;
  /** Null when the turn has no visible prompt in the loaded window, so no duration is known. */
  durationMs: number | null;
}

export interface StreamTurnTiming {
  byAssistantId: Map<string, TurnTiming>;
  runningStartedAt: Date | null;
}

export function deriveStreamTurnTiming(params: {
  isTurnActive: boolean;
  activeTurnStartedAt: Date | null;
  tail: StreamItem[];
  head: StreamItem[];
}): StreamTurnTiming {
  const byAssistantId = new Map<string, TurnTiming>();
  let currentUserAt: Date | null = null;
  let currentLastItemAt: Date | null = null;
  let currentAssistantIds: string[] = [];

  const flushCompletedTurn = () => {
    if (!currentLastItemAt || currentAssistantIds.length === 0) {
      return;
    }
    const timing: TurnTiming = {
      completedAt: currentLastItemAt,
      durationMs: currentUserAt
        ? Math.max(0, currentLastItemAt.getTime() - currentUserAt.getTime())
        : null,
    };
    for (const id of currentAssistantIds) {
      byAssistantId.set(id, timing);
    }
  };

  const visitItem = (item: StreamItem) => {
    if (item.kind === "user_message") {
      flushCompletedTurn();
      currentUserAt = item.timestamp;
      currentLastItemAt = null;
      currentAssistantIds = [];
      return;
    }
    currentLastItemAt = item.timestamp;
    if (item.kind === "assistant_message") {
      currentAssistantIds.push(item.id);
    }
  };

  for (const item of params.tail) {
    visitItem(item);
  }
  for (const item of params.head) {
    visitItem(item);
  }

  const runningStartedAt = params.isTurnActive ? params.activeTurnStartedAt : null;
  if (!params.isTurnActive) {
    flushCompletedTurn();
  }

  return {
    byAssistantId,
    runningStartedAt,
  };
}
