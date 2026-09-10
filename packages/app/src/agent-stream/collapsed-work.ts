import type { StreamItem } from "@/types/stream";

/**
 * Provider-neutral completed-turn projection. The canonical stream remains
 * untouched; only render output changes. Completed intermediate activity folds
 * behind one summary row, while explicit final answers stay visible. Messages
 * without phase metadata retain the legacy positional fallback. Expanding a row
 * therefore restores the exact original item order.
 */

const WORK_KINDS = new Set<StreamItem["kind"]>([
  "thought",
  "tool_call",
  "todo_list",
  "activity_log",
  "compaction",
]);
const ERROR_ASSISTANT_PREFIX = /^\[(?:system )?error\]/i;

export interface CollapsedWorkResult {
  items: StreamItem[];
  /** Folded-detail count per stable completed-turn key, including expanded turns. */
  workCountByTurnKey: Map<string, number>;
  /** Final-answer anchor item id -> stable completed-turn key. */
  summaryTurnKeyByAssistantId: Map<string, string>;
  /** Stable completed-turn key -> final rendered assistant item id. */
  turnEndAssistantIdByTurnKey: Map<string, string>;
  /** Final rendered assistant item id -> stable completed-turn key. */
  turnKeyByTurnEndAssistantId: Map<string, string>;
}

export function isCollapsibleWorkItem(item: StreamItem): boolean {
  return WORK_KINDS.has(item.kind);
}

interface Turn {
  start: number;
  end: number; // exclusive
  hasUserMessage: boolean;
}

interface TurnProjection {
  turnKey: string;
  turnEndAssistantId: string;
  summaryAnchorId: string;
  hideableDetails: StreamItem[];
}

function splitTurns(items: readonly StreamItem[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === "user_message") {
      if (current && item.steering) {
        // Codex and Pi persist steering as another user item inside the same
        // provider turn. Keep it visible without inventing a new turn boundary.
        continue;
      }
      if (current) {
        current.end = index;
        turns.push(current);
      }
      current = {
        start: index,
        end: items.length,
        hasUserMessage: item.steering !== true,
      };
      continue;
    }
    if (!current) {
      // A page can begin mid-turn. Without its user boundary, completion is
      // ambiguous, so this leading slice is never auto-folded.
      current = { start: index, end: items.length, hasUserMessage: false };
    }
  }
  if (current) turns.push(current);
  return turns;
}

function isIncompleteDetail(item: StreamItem): boolean {
  if (item.kind === "thought") return item.status === "loading";
  if (item.kind === "compaction") return item.status === "loading";
  if (item.kind !== "tool_call") return false;
  return item.payload.data.status === "running" || item.payload.data.status === "executing";
}

function mustRemainVisible(item: StreamItem): boolean {
  if (item.kind === "assistant_message") return ERROR_ASSISTANT_PREFIX.test(item.text.trimStart());
  if (item.kind === "activity_log") return item.activityType === "error";
  if (item.kind !== "tool_call") return isIncompleteDetail(item);
  return (
    item.payload.data.status === "failed" ||
    (item.payload.source === "agent" && item.payload.data.status === "canceled") ||
    isIncompleteDetail(item)
  );
}

function getAssistantIndices(items: readonly StreamItem[], turn: Turn): number[] {
  const assistantIndices: number[] = [];
  for (let index = turn.start; index < turn.end; index += 1) {
    if (items[index]?.kind === "assistant_message") assistantIndices.push(index);
  }
  return assistantIndices;
}

function addLogicalAssistantGroup(input: {
  items: readonly StreamItem[];
  assistantIndices: readonly number[];
  terminalIndex: number;
  visibleIndices: Set<number>;
}): void {
  const terminal = input.items[input.terminalIndex];
  const blockGroupId = terminal?.kind === "assistant_message" ? terminal.blockGroupId : undefined;
  if (blockGroupId) {
    // Markdown streaming may promote one logical assistant response into
    // several render items. blockGroupId is authoritative when present;
    // messageId is not, because providers can reuse one message id before and
    // after tool activity.
    for (const index of input.assistantIndices) {
      const assistant = input.items[index];
      if (assistant?.kind === "assistant_message" && assistant.blockGroupId === blockGroupId) {
        input.visibleIndices.add(index);
      }
    }
    return;
  }

  // Older/custom providers may emit one response as adjacent assistant rows
  // without grouping metadata. A work item still separates distinct output.
  input.visibleIndices.add(input.terminalIndex);
  for (let index = input.terminalIndex - 1; index >= 0; index -= 1) {
    if (input.items[index]?.kind !== "assistant_message") break;
    input.visibleIndices.add(index);
  }
}

function getFinalGroupIndices(
  items: readonly StreamItem[],
  assistantIndices: readonly number[],
  lastAssistantIndex: number,
): Set<number> {
  const finalGroupIndices = new Set<number>();
  let hasExplicitFinalAnswer = false;
  for (const index of assistantIndices) {
    const assistant = items[index];
    if (assistant?.kind !== "assistant_message" || assistant.phase !== "final_answer") {
      continue;
    }
    hasExplicitFinalAnswer = true;
    addLogicalAssistantGroup({
      items,
      assistantIndices,
      terminalIndex: index,
      visibleIndices: finalGroupIndices,
    });
  }

  if (!hasExplicitFinalAnswer) {
    for (const index of assistantIndices) {
      const assistant = items[index];
      if (
        assistant?.kind !== "assistant_message" ||
        assistant.phase !== undefined ||
        assistant.turnOutcome !== "completed"
      ) {
        continue;
      }
      // A phase-less provider can settle, wake for autonomous extension work,
      // and settle again without another user message. Each completed output is
      // an authoritative response boundary; preserving it avoids folding an
      // earlier answer behind the later background notification.
      addLogicalAssistantGroup({
        items,
        assistantIndices,
        terminalIndex: index,
        visibleIndices: finalGroupIndices,
      });
    }
  }

  const lastAssistant = items[lastAssistantIndex];
  // Codex treats absent phase as "unknown" for provider compatibility. Keep
  // the legacy last-message fallback unless the provider explicitly says the
  // trailing output is commentary and already supplied a final answer.
  if (
    !hasExplicitFinalAnswer ||
    lastAssistant?.kind !== "assistant_message" ||
    lastAssistant.phase !== "commentary"
  ) {
    addLogicalAssistantGroup({
      items,
      assistantIndices,
      terminalIndex: lastAssistantIndex,
      visibleIndices: finalGroupIndices,
    });
  }
  return finalGroupIndices;
}

/**
 * Prose length of an assistant row, for the "never hide more than you show"
 * check below. Non-assistant rows count as nothing.
 */
function assistantTextLength(item: StreamItem | undefined): number {
  return item?.kind === "assistant_message" ? item.text.trim().length : 0;
}

/**
 * A hidden answer this long is a real answer, not narration, so it is worth
 * keeping on screen even when a later message formally ends the turn.
 */
const SUBSTANTIVE_ANSWER_CHARS = 500;

/**
 * Enforce the one thing a summary row must never do: hide more of the answer
 * than it leaves visible.
 *
 * Phase metadata is only as trustworthy as its source. Codex receives
 * commentary/final_answer from the model, so folding untagged text is safe
 * there. Pi derives it from stopReason — `stop` plus text means final answer,
 * anything else stays untagged — so an answer written just before one last
 * tool call is untagged and folds, while a short wrap-up afterwards is the
 * only thing left expanded. Measured over 1278 local pi-claude turns: 893
 * fold something (that is the feature working), and in 17 the folded prose
 * outweighs everything still visible. Those 17 are the ones that hide what
 * the reader came for.
 *
 * Revealing only those keeps one-line narration folded, which is the point of
 * the collapse; adopting codex's polarity wholesale — treat untagged as final
 * — would un-fold roughly 70% of turns for this provider.
 */
function revealOverweightHiddenAnswers(
  items: readonly StreamItem[],
  assistantIndices: readonly number[],
  visibleIndices: Set<number>,
): void {
  for (;;) {
    const hidden = assistantIndices.filter((index) => !visibleIndices.has(index));
    if (hidden.length === 0) return;
    const largest = hidden.reduce((best, index) =>
      assistantTextLength(items[index]) > assistantTextLength(items[best]) ? index : best,
    );
    const largestLength = assistantTextLength(items[largest]);
    if (largestLength < SUBSTANTIVE_ANSWER_CHARS) return;
    let visibleLength = 0;
    for (const index of visibleIndices) visibleLength += assistantTextLength(items[index]);
    if (largestLength <= visibleLength) return;
    addLogicalAssistantGroup({
      items,
      assistantIndices,
      terminalIndex: largest,
      visibleIndices,
    });
  }
}

function getTurnDetails(
  items: readonly StreamItem[],
  turn: Turn,
  finalGroupIndices: ReadonlySet<number>,
): StreamItem[] {
  const details: StreamItem[] = [];
  const lastFinalAssistantIndex = Math.max(...finalGroupIndices);
  for (let index = turn.start; index < turn.end; index += 1) {
    const item = items[index]!;
    const isIntermediateAssistant =
      item.kind === "assistant_message" && !finalGroupIndices.has(index);
    const isWorkBeforeFinal = WORK_KINDS.has(item.kind) && index < lastFinalAssistantIndex;
    if (isIntermediateAssistant || isWorkBeforeFinal) details.push(item);
  }
  return details;
}

function projectTurn(items: readonly StreamItem[], turn: Turn): TurnProjection | null {
  if (!turn.hasUserMessage) return null;

  const assistantIndices = getAssistantIndices(items, turn);
  const lastAssistantIndex = assistantIndices.at(-1);
  if (lastAssistantIndex === undefined) return null;
  const lastAssistant = items[lastAssistantIndex];
  if (!lastAssistant || lastAssistant.kind !== "assistant_message") return null;
  const hasExceptionalOutcome = assistantIndices.some((index) => {
    const assistant = items[index];
    return (
      assistant?.kind === "assistant_message" &&
      (assistant.turnOutcome === "failed" || assistant.turnOutcome === "canceled")
    );
  });
  if (hasExceptionalOutcome) return null;

  const finalGroupIndices = getFinalGroupIndices(items, assistantIndices, lastAssistantIndex);
  // Resolved before the reveal below, so the turn key stays anchored to the
  // message that actually ended the turn and manual expansion survives.
  const turnEndAssistantIndex = Math.max(...finalGroupIndices);
  const turnEndAssistant = items[turnEndAssistantIndex];
  if (!turnEndAssistant || turnEndAssistant.kind !== "assistant_message") return null;
  revealOverweightHiddenAnswers(items, assistantIndices, finalGroupIndices);
  const details = getTurnDetails(items, turn, finalGroupIndices);
  // Loading thoughts, running tools, and loading compaction markers indicate a
  // partial projection even if agent liveness briefly reports idle.
  if (details.some(isIncompleteDetail)) return null;

  const hideableDetails = details.filter((item) => !mustRemainVisible(item));
  if (hideableDetails.length === 0) return null;

  const summaryAnchor = items[Math.min(...finalGroupIndices)];
  if (!summaryAnchor || summaryAnchor.kind !== "assistant_message") return null;
  return {
    // Provider message identity survives block promotion and canonical
    // hydration more reliably than a renderer-row id, preserving manual
    // expansion state while the transcript reconciles.
    turnKey: turnEndAssistant.messageId ?? turnEndAssistant.blockGroupId ?? turnEndAssistant.id,
    turnEndAssistantId: turnEndAssistant.id,
    summaryAnchorId: summaryAnchor.id,
    hideableDetails,
  };
}

export interface CollapsedStreamResult {
  tail: StreamItem[];
  head: StreamItem[];
  workCountByTurnKey: Map<string, number>;
  summaryTurnKeyByAssistantId: Map<string, string>;
  turnEndAssistantIdByTurnKey: Map<string, string>;
  turnKeyByTurnEndAssistantId: Map<string, string>;
}

/**
 * Collapse across the tail/head boundary. While a turn is active only settled
 * history collapses (the in-flight turn streams fully); once idle the buffers
 * are folded together so a turn spanning both buffers gets one summary row.
 */
export function collapseCompletedWorkStream(input: {
  tail: StreamItem[];
  head: StreamItem[];
  expandedTurnKeys: ReadonlySet<string>;
  isTurnActive: boolean;
}): CollapsedStreamResult {
  const { tail, head, expandedTurnKeys, isTurnActive } = input;
  if (isTurnActive) {
    const collapsedTail = collapseCompletedWork({
      items: tail,
      expandedTurnKeys,
      keepLastTurnExpanded: true,
    });
    return {
      tail: collapsedTail.items,
      head,
      workCountByTurnKey: collapsedTail.workCountByTurnKey,
      summaryTurnKeyByAssistantId: collapsedTail.summaryTurnKeyByAssistantId,
      turnEndAssistantIdByTurnKey: collapsedTail.turnEndAssistantIdByTurnKey,
      turnKeyByTurnEndAssistantId: collapsedTail.turnKeyByTurnEndAssistantId,
    };
  }
  if (head.length === 0) {
    const collapsedTail = collapseCompletedWork({
      items: tail,
      expandedTurnKeys,
      keepLastTurnExpanded: false,
    });
    return {
      tail: collapsedTail.items,
      head,
      workCountByTurnKey: collapsedTail.workCountByTurnKey,
      summaryTurnKeyByAssistantId: collapsedTail.summaryTurnKeyByAssistantId,
      turnEndAssistantIdByTurnKey: collapsedTail.turnEndAssistantIdByTurnKey,
      turnKeyByTurnEndAssistantId: collapsedTail.turnKeyByTurnEndAssistantId,
    };
  }
  const headItems = new Set(head);
  const combined = collapseCompletedWork({
    items: [...tail, ...head],
    expandedTurnKeys,
    keepLastTurnExpanded: false,
  });
  const tailOut: StreamItem[] = [];
  const headOut: StreamItem[] = [];
  for (const item of combined.items) {
    (headItems.has(item) ? headOut : tailOut).push(item);
  }
  return {
    tail: tailOut,
    head: headOut,
    workCountByTurnKey: combined.workCountByTurnKey,
    summaryTurnKeyByAssistantId: combined.summaryTurnKeyByAssistantId,
    turnEndAssistantIdByTurnKey: combined.turnEndAssistantIdByTurnKey,
    turnKeyByTurnEndAssistantId: combined.turnKeyByTurnEndAssistantId,
  };
}

export function collapseCompletedWork(input: {
  items: StreamItem[];
  expandedTurnKeys: ReadonlySet<string>;
  /** Never summarize the trailing settled slice while its turn is active. */
  keepLastTurnExpanded: boolean;
}): CollapsedWorkResult {
  const { items, expandedTurnKeys, keepLastTurnExpanded } = input;
  const workCountByTurnKey = new Map<string, number>();
  const summaryTurnKeyByAssistantId = new Map<string, string>();
  const turnEndAssistantIdByTurnKey = new Map<string, string>();
  const turnKeyByTurnEndAssistantId = new Map<string, string>();
  if (items.length === 0) {
    return {
      items,
      workCountByTurnKey,
      summaryTurnKeyByAssistantId,
      turnEndAssistantIdByTurnKey,
      turnKeyByTurnEndAssistantId,
    };
  }

  const turns = splitTurns(items);
  const hidden = new Set<StreamItem>();
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    if (keepLastTurnExpanded && turnIndex === turns.length - 1) continue;
    const projection = projectTurn(items, turns[turnIndex]!);
    if (!projection) continue;

    workCountByTurnKey.set(projection.turnKey, projection.hideableDetails.length);
    summaryTurnKeyByAssistantId.set(projection.summaryAnchorId, projection.turnKey);
    turnEndAssistantIdByTurnKey.set(projection.turnKey, projection.turnEndAssistantId);
    turnKeyByTurnEndAssistantId.set(projection.turnEndAssistantId, projection.turnKey);
    if (expandedTurnKeys.has(projection.turnKey)) continue;
    for (const item of projection.hideableDetails) hidden.add(item);
  }

  if (hidden.size === 0) {
    return {
      items,
      workCountByTurnKey,
      summaryTurnKeyByAssistantId,
      turnEndAssistantIdByTurnKey,
      turnKeyByTurnEndAssistantId,
    };
  }
  return {
    items: items.filter((item) => !hidden.has(item)),
    workCountByTurnKey,
    summaryTurnKeyByAssistantId,
    turnEndAssistantIdByTurnKey,
    turnKeyByTurnEndAssistantId,
  };
}
