import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ToastApi } from "@/components/toast-host";
import { i18n } from "@/i18n/i18next";
import {
  selectAgentTimelineState,
  useSessionStore,
  type AgentTimelineCursorState,
  type AgentTimelineOlderFetchError,
} from "@/stores/session-store";
import { planTimelineOlderFetch } from "@/timeline/timeline-sync-plan";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface LoadOlderAgentHistoryClient {
  fetchAgentTimeline: (
    agentId: string,
    request: {
      direction: "before";
      cursor: { epoch: string; seq: number };
      limit: number;
      projection: "projected";
    },
  ) => Promise<unknown>;
}

export interface LoadOlderAgentHistoryLogger {
  warn: (...args: unknown[]) => void;
}

export interface LoadOlderAgentHistoryDeps {
  client: LoadOlderAgentHistoryClient | null;
  cursor: AgentTimelineCursorState | undefined;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  setInFlight: (value: boolean) => void;
  toast?: ToastApi | null;
  logger?: LoadOlderAgentHistoryLogger;
  failedMessage?: string;
  /**
   * Page that already failed for this agent. Scrolling back to the history start
   * must not keep re-requesting it; only an explicit retry may.
   */
  failedCursor?: AgentTimelineOlderFetchError | null;
  setFailedCursor?: (value: AgentTimelineOlderFetchError | null) => void;
  /** "auto" comes from scrolling to the history start, "manual" from the retry control. */
  trigger?: "auto" | "manual";
}

export function isSameOlderFetchCursor(
  left: AgentTimelineOlderFetchError | null | undefined,
  right: AgentTimelineOlderFetchError | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.epoch === right.epoch && left.startSeq === right.startSeq;
}

export async function loadOlderAgentHistory(
  agentId: string,
  deps: LoadOlderAgentHistoryDeps,
): Promise<boolean> {
  const {
    client,
    cursor,
    hasOlder,
    isLoadingOlder,
    setInFlight,
    toast,
    logger,
    failedMessage,
    failedCursor,
    setFailedCursor,
    trigger = "auto",
  } = deps;
  if (isLoadingOlder) {
    return true;
  }
  if (!client || !cursor || !hasOlder) {
    return false;
  }
  const requestedCursor = { epoch: cursor.epoch, startSeq: cursor.startSeq };
  if (trigger === "auto" && isSameOlderFetchCursor(failedCursor, requestedCursor)) {
    return false;
  }

  setInFlight(true);
  try {
    await client.fetchAgentTimeline(
      agentId,
      planTimelineOlderFetch({ epoch: cursor.epoch, seq: cursor.startSeq }),
    );
    setFailedCursor?.(null);
  } catch (error) {
    (logger ?? console).warn("[Timeline] failed to load older agent history", agentId, error);
    setFailedCursor?.(requestedCursor);
    toast?.show(failedMessage ?? i18n.t("loadOlderHistory.failed"), {
      durationMs: 2200,
      testID: "agent-load-older-history-toast",
    });
  } finally {
    setInFlight(false);
  }
  return true;
}

export function useLoadOlderAgentHistory({
  serverId,
  agentId,
  toast,
}: {
  serverId: string;
  agentId: string;
  toast?: ToastApi | null;
}) {
  const { t } = useTranslation();
  const hasOlder = useSessionStore((state) => {
    const timeline = selectAgentTimelineState(state.sessions[serverId], agentId);
    return timeline.status === "synced" && timeline.older === "available";
  });
  const isLoadingOlder =
    useSessionStore((state) =>
      state.sessions[serverId]?.agentTimelineOlderFetchInFlight.get(agentId),
    ) === true;
  const progressKey = useSessionStore((state) => {
    const timeline = selectAgentTimelineState(state.sessions[serverId], agentId);
    const cursor = timeline.status === "synced" ? timeline.range : null;
    return cursor ? `${cursor.epoch}:${cursor.startSeq}` : null;
  });
  // The stored failure only counts while the history start still points at the
  // page that failed; any newly loaded or reset page clears the blocked state.
  const hasOlderError = useSessionStore((state) => {
    const timeline = selectAgentTimelineState(state.sessions[serverId], agentId);
    const cursor = timeline.status === "synced" ? timeline.range : null;
    const failed = state.sessions[serverId]?.agentTimelineOlderFetchError.get(agentId) ?? null;
    return cursor
      ? isSameOlderFetchCursor(failed, { epoch: cursor.epoch, startSeq: cursor.startSeq })
      : false;
  });
  const setOlderFetchInFlight = useSessionStore(
    (state) => state.setAgentTimelineOlderFetchInFlight,
  );
  const setOlderFetchError = useSessionStore((state) => state.setAgentTimelineOlderFetchError);

  const setInFlight = useCallback(
    (value: boolean) => {
      setOlderFetchInFlight(serverId, (prev) => {
        if (prev.get(agentId) === value) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, value);
        return next;
      });
    },
    [agentId, serverId, setOlderFetchInFlight],
  );

  const setFailedCursor = useCallback(
    (value: AgentTimelineOlderFetchError | null) => {
      setOlderFetchError(serverId, (prev) => {
        const current = prev.get(agentId) ?? null;
        if (value === null ? current === null : isSameOlderFetchCursor(current, value)) {
          return prev;
        }
        const next = new Map(prev);
        if (value === null) {
          next.delete(agentId);
        } else {
          next.set(agentId, value);
        }
        return next;
      });
    },
    [agentId, serverId, setOlderFetchError],
  );

  const runLoadOlder = useCallback(
    async (trigger: "auto" | "manual"): Promise<boolean> => {
      const session = useSessionStore.getState().sessions[serverId];
      const timeline = selectAgentTimelineState(session, agentId);
      return await loadOlderAgentHistory(agentId, {
        client: session?.client
          ? {
              fetchAgentTimeline: (timelineAgentId, request) =>
                getHostRuntimeStore().fetchAgentTimeline(serverId, timelineAgentId, request),
            }
          : null,
        cursor: timeline.status === "synced" ? (timeline.range ?? undefined) : undefined,
        hasOlder: timeline.status === "synced" && timeline.older === "available",
        isLoadingOlder: session?.agentTimelineOlderFetchInFlight.get(agentId) === true,
        setInFlight,
        toast,
        failedMessage: t("loadOlderHistory.failed"),
        failedCursor: session?.agentTimelineOlderFetchError.get(agentId) ?? null,
        setFailedCursor,
        trigger,
      });
    },
    [agentId, serverId, setFailedCursor, setInFlight, toast, t],
  );

  const loadOlder = useCallback(async (): Promise<boolean> => runLoadOlder("auto"), [runLoadOlder]);
  const retryLoadOlder = useCallback(async (): Promise<boolean> => {
    setFailedCursor(null);
    return await runLoadOlder("manual");
  }, [runLoadOlder, setFailedCursor]);

  return {
    isLoadingOlder,
    hasOlder,
    hasOlderError,
    progressKey,
    loadOlder,
    retryLoadOlder,
  };
}
