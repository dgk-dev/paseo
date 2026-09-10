import { describe, expect, test } from "vitest";
import type { AssistantMessageItem, StreamItem } from "@/types/stream";
import { collapseCompletedWork, collapseCompletedWorkStream } from "./collapsed-work";

let sequence = 0;
function nextBase(kind: StreamItem["kind"], id?: string) {
  sequence += 1;
  return {
    kind,
    id: id ?? `${kind}_${sequence}`,
    timestamp: new Date(1_700_000_000_000 + sequence * 1000),
  };
}

function item(kind: StreamItem["kind"], id?: string): StreamItem {
  const base = nextBase(kind, id);
  switch (kind) {
    case "user_message":
      return { ...base, kind, text: "prompt" };
    case "assistant_message":
      return { ...base, kind, text: "answer" };
    case "thought":
      return { ...base, kind, text: "thinking", status: "ready" };
    case "tool_call":
      return {
        ...base,
        kind,
        payload: {
          source: "agent",
          data: {
            provider: "codex",
            callId: base.id,
            name: "shell",
            status: "completed",
            error: null,
            detail: { type: "unknown", input: null, output: null },
          },
        },
      };
    case "todo_list":
      return {
        ...base,
        kind,
        provider: "codex",
        items: [{ text: "task", completed: true }],
        activity: { type: "created", count: 1 },
      };
    case "activity_log":
      return { ...base, kind, activityType: "info", message: "activity" };
    case "compaction":
      return { ...base, kind, status: "completed" };
  }
}

function assistant(
  id: string,
  overrides: Partial<Omit<AssistantMessageItem, "kind" | "id" | "timestamp">> = {},
): AssistantMessageItem {
  return { ...(item("assistant_message", id) as AssistantMessageItem), ...overrides };
}

function withToolStatus(status: "running" | "completed" | "failed" | "canceled") {
  const tool = item("tool_call");
  if (tool.kind !== "tool_call" || tool.payload.source !== "agent") throw new Error("invalid tool");
  return { ...tool, payload: { ...tool.payload, data: { ...tool.payload.data, status } } };
}

const NONE: ReadonlySet<string> = new Set();

interface DisclosureCase {
  grouping: "block-group" | "adjacent";
  finalBlockCount: number;
  intermediateCount: number;
  workKind: "thought" | "tool_call" | "todo_list" | "activity_log" | "compaction";
}

function createDisclosureCases(): DisclosureCase[] {
  const cases: DisclosureCase[] = [];
  const workKinds = ["thought", "tool_call", "todo_list", "activity_log", "compaction"] as const;
  for (const grouping of ["block-group", "adjacent"] as const) {
    for (const finalBlockCount of [1, 2, 3]) {
      for (const intermediateCount of [0, 1, 2]) {
        for (const workKind of workKinds) {
          cases.push({ grouping, finalBlockCount, intermediateCount, workKind });
        }
      }
    }
  }
  return cases;
}

describe("collapseCompletedWork", () => {
  test("shows each user prompt and final answer while folding completed details", () => {
    const items = [
      item("user_message"),
      item("thought"),
      item("tool_call"),
      assistant("a1"),
      item("user_message"),
      item("todo_list"),
      assistant("a2"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.kind)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
    expect(result.workCountByTurnKey.get("a1")).toBe(2);
    expect(result.workCountByTurnKey.get("a2")).toBe(1);
    expect([...result.summaryTurnKeyByAssistantId]).toEqual([
      ["a1", "a1"],
      ["a2", "a2"],
    ]);
  });

  test("keeps the trailing turn fully visible and unsummarized while active", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      assistant("a1"),
      item("user_message"),
      item("tool_call"),
      assistant("a2"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: true,
    });
    expect(result.items.map((entry) => entry.kind)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "tool_call",
      "assistant_message",
    ]);
    expect([...result.summaryTurnKeyByAssistantId]).toEqual([["a1", "a1"]]);
    expect(result.workCountByTurnKey.has("a2")).toBe(false);
  });

  test("keeps turns without an assistant message untouched", () => {
    const items = [item("user_message"), item("tool_call"), item("thought")];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toBe(items);
    expect(result.workCountByTurnKey.size).toBe(0);
  });

  test("expansion restores the exact original item objects and order", () => {
    const items = [
      item("user_message"),
      assistant("planning"),
      item("tool_call"),
      item("thought"),
      assistant("final"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: new Set(["final"]),
      keepLastTurnExpanded: false,
    });
    expect(result.items).toBe(items);
    expect(result.items).toEqual(items);
    expect(result.workCountByTurnKey.get("final")).toBe(3);
  });

  test("does not auto-fold a leading partial page without its user boundary", () => {
    const items = [
      item("tool_call"),
      assistant("a0"),
      item("user_message"),
      item("thought"),
      assistant("a1"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.id)).toEqual([items[0]!.id, "a0", items[2]!.id, "a1"]);
    expect(result.workCountByTurnKey.has("a0")).toBe(false);
    expect(result.workCountByTurnKey.get("a1")).toBe(1);
  });

  test("folds completed compaction into work history", () => {
    const items = [item("user_message"), item("compaction"), item("tool_call"), assistant("a1")];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.kind)).toEqual(["user_message", "assistant_message"]);
    expect(result.workCountByTurnKey.get("a1")).toBe(2);
  });

  test("returns the identical array when nothing collapses", () => {
    const items = [item("user_message"), assistant("a1")];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toBe(items);
  });

  test("folds intermediate assistant commentary, not just tools", () => {
    const items = [
      item("user_message"),
      assistant("a1", { text: "I will inspect this." }),
      item("tool_call"),
      assistant("a2", { text: "The fix is complete." }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.id)).toEqual([items[0]!.id, "a2"]);
    expect(result.workCountByTurnKey.get("a2")).toBe(2);
  });

  test("keeps a substantive answer visible when only a short wrap-up ends the turn", () => {
    // Pi derives the phase from stopReason, so an answer written just before one
    // last tool call is untagged and folds, leaving a two-line sign-off as the
    // only thing on screen. The summary row must not hide more of the answer
    // than it shows.
    const answer = "Here is the full analysis. ".repeat(30);
    const items = [
      item("user_message"),
      assistant("long-answer", { text: answer }),
      item("tool_call"),
      assistant("wrap-up", { text: "Saved to memory.", phase: "final_answer" }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.id)).toEqual([items[0]!.id, "long-answer", "wrap-up"]);
    // The turn still folds its work, and its key still names the turn-end message.
    expect(result.workCountByTurnKey.get("wrap-up")).toBe(1);
  });

  test("still folds short narration when the visible answer is the substantial one", () => {
    const items = [
      item("user_message"),
      assistant("narration", { text: "Let me check that file." }),
      item("tool_call"),
      assistant("answer", {
        text: "The config is correct. ".repeat(30),
        phase: "final_answer",
      }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.id)).toEqual([items[0]!.id, "answer"]);
    expect(result.workCountByTurnKey.get("answer")).toBe(2);
  });

  test("folds a long intermediate message when the visible answer outweighs it", () => {
    const items = [
      item("user_message"),
      assistant("intermediate", { text: "Working through the options. ".repeat(20) }),
      item("tool_call"),
      assistant("answer", {
        text: "Final recommendation with reasoning. ".repeat(40),
        phase: "final_answer",
      }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.id)).toEqual([items[0]!.id, "answer"]);
  });

  test("puts the summary row before the revealed answer, not after it", () => {
    const answer = "Detailed findings follow. ".repeat(30);
    const items = [
      item("user_message"),
      item("thought"),
      assistant("long-answer", { text: answer }),
      item("tool_call"),
      assistant("wrap-up", { text: "Done.", phase: "final_answer" }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    // The anchor is the first visible assistant row, so the folded thought that
    // preceded the answer is summarized above it rather than below.
    expect(result.summaryTurnKeyByAssistantId.get("long-answer")).toBe("wrap-up");
  });

  test("keeps every block of the final logical assistant response visible", () => {
    const messageId = "shared-provider-message";
    const items = [
      item("user_message"),
      assistant("planning", {
        messageId,
        blockGroupId: "planning-group",
        blockIndex: 0,
        text: "Checking first.",
      }),
      item("tool_call"),
      assistant("final-0", {
        messageId,
        blockGroupId: "final-group",
        blockIndex: 0,
        text: "Complete answer paragraph one.",
      }),
      assistant("final-1", {
        messageId,
        blockGroupId: "final-group",
        blockIndex: 1,
        text: "Complete answer paragraph two.",
      }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.id)).toEqual([items[0]!.id, "final-0", "final-1"]);
    expect(result.workCountByTurnKey.get(messageId)).toBe(2);
    // The summary anchors before the first final block while the stable
    // provider message key survives renderer block promotion.
    expect([...result.summaryTurnKeyByAssistantId]).toEqual([["final-0", messageId]]);
    expect(result.turnEndAssistantIdByTurnKey.get(messageId)).toBe("final-1");
  });

  test("falls back safely for Claude/Grok-style output without block metadata", () => {
    const items = [
      item("user_message"),
      assistant("commentary", { text: "Working on it." }),
      item("tool_call"),
      assistant("final", { text: "Done." }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.id)).toEqual([items[0]!.id, "final"]);
    expect(result.summaryTurnKeyByAssistantId.get("final")).toBe("final");
  });

  test("keeps adjacent provider-split final rows without grouping metadata", () => {
    const items = [
      item("user_message"),
      assistant("commentary", { text: "I will inspect this." }),
      item("tool_call"),
      assistant("final-a", { messageId: "provider-final-a", text: "First final section." }),
      assistant("final-b", { messageId: "provider-final-b", text: "Second final section." }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });

    expect(result.items.map((entry) => entry.id)).toEqual([items[0]!.id, "final-a", "final-b"]);
    expect(result.workCountByTurnKey.get("provider-final-b")).toBe(2);
    expect(result.summaryTurnKeyByAssistantId.get("final-a")).toBe("provider-final-b");
  });

  test("keeps phase-less completed answers visible across an autonomous extension follow-up", () => {
    const user = item("user_message");
    const extensionNotice = assistant("extension-notice", {
      text: "Content fetched for 1/5 URLs.",
      phase: "commentary",
    });
    const work = item("tool_call");
    const detailedAnswer = assistant("detailed-answer", {
      text: "The full researched conclusion.",
      messageId: "response-detailed",
      turnOutcome: "completed",
    });
    const followUpThought = item("thought");
    const backgroundNotice = assistant("background-notice", {
      text: "The background fetch added nothing new.",
      messageId: "response-background",
      turnOutcome: "completed",
    });
    const items = [user, extensionNotice, work, detailedAnswer, followUpThought, backgroundNotice];

    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });

    expect(result.items).toEqual([user, detailedAnswer, backgroundNotice]);
    expect(result.workCountByTurnKey.get("response-background")).toBe(3);
    expect(result.summaryTurnKeyByAssistantId.get("detailed-answer")).toBe("response-background");
  });

  test("keeps explicit final answers visible across an autonomous extension follow-up", () => {
    const user = item("user_message");
    const work = item("tool_call");
    const detailedAnswer = assistant("detailed-answer", {
      text: "The full researched conclusion.",
      messageId: "response-detailed",
      phase: "final_answer",
    });
    const extensionNotice = assistant("extension-notice", {
      text: "Content fetched for 9/10 URLs.",
      phase: "commentary",
    });
    const followUpThought = item("thought");
    const followUp = assistant("follow-up", {
      text: "The conclusion is unchanged.",
      messageId: "response-follow-up",
      phase: "final_answer",
    });
    const compaction = item("compaction");
    const items = [
      user,
      work,
      detailedAnswer,
      extensionNotice,
      followUpThought,
      followUp,
      compaction,
    ];

    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });

    expect(result.items).toEqual([user, detailedAnswer, followUp, compaction]);
    expect(result.workCountByTurnKey.get("response-follow-up")).toBe(3);
    expect(result.summaryTurnKeyByAssistantId.get("detailed-answer")).toBe("response-follow-up");
  });

  test("keeps steering prompts inside the active turn while folding prior commentary", () => {
    const initial = item("user_message");
    const commentary = assistant("commentary", {
      text: "I am checking it.",
      phase: "commentary",
    });
    const work = item("tool_call");
    const steering = {
      ...item("user_message"),
      id: "steering-user",
      steering: true,
    } as StreamItem;
    const finalAnswer = assistant("final", {
      text: "Done.",
      messageId: "final-response",
      phase: "final_answer",
      turnOutcome: "completed",
    });

    const result = collapseCompletedWork({
      items: [initial, commentary, work, steering, finalAnswer],
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });

    expect(result.items).toEqual([initial, steering, finalAnswer]);
    expect(result.workCountByTurnKey.get("final-response")).toBe(2);
  });

  test("keeps commentary visible when a provider supplies no final answer", () => {
    const user = item("user_message");
    const work = item("tool_call");
    const commentary = assistant("commentary-only", {
      text: "The extension command completed.",
      phase: "commentary",
    });

    const result = collapseCompletedWork({
      items: [user, work, commentary],
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });

    expect(result.items).toEqual([user, commentary]);
    expect(result.workCountByTurnKey.get("commentary-only")).toBe(1);
  });

  test("preserves manual expansion when canonical hydration changes renderer row ids", () => {
    const stableMessageId = "provider-final-message";
    const liveItems = [
      item("user_message"),
      item("tool_call"),
      assistant("live-final:block:1", {
        messageId: stableMessageId,
        blockGroupId: "live-final",
        blockIndex: 1,
        turnOutcome: "completed",
      }),
    ];
    const firstProjection = collapseCompletedWork({
      items: liveItems,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(firstProjection.workCountByTurnKey.get(stableMessageId)).toBe(1);
    expect(firstProjection.turnEndAssistantIdByTurnKey.get(stableMessageId)).toBe(
      "live-final:block:1",
    );

    const canonicalItems = [
      item("user_message"),
      item("tool_call"),
      assistant("canonical-final", {
        messageId: stableMessageId,
        turnOutcome: "completed",
      }),
    ];
    const hydratedProjection = collapseCompletedWork({
      items: canonicalItems,
      expandedTurnKeys: new Set([stableMessageId]),
      keepLastTurnExpanded: false,
    });

    expect(hydratedProjection.items).toBe(canonicalItems);
    expect(hydratedProjection.turnKeyByTurnEndAssistantId.get("canonical-final")).toBe(
      stableMessageId,
    );
  });

  test.each(["failed", "canceled"] as const)("keeps a %s turn fully visible", (turnOutcome) => {
    const items = [
      item("user_message"),
      item("thought"),
      item("tool_call"),
      assistant("a1", { turnOutcome }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toBe(items);
    expect(result.workCountByTurnKey.size).toBe(0);
  });

  test("keeps a failed turn open when a provider appends diagnostics after termination", () => {
    const items = [
      item("user_message"),
      item("thought"),
      assistant("partial", { turnOutcome: "failed" }),
      assistant("diagnostic", { text: "[Error] provider disconnected" }),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toBe(items);
    expect(result.workCountByTurnKey.size).toBe(0);
  });

  test("leaves error activity visible while folding safe details", () => {
    const error = {
      ...(item("activity_log") as Extract<StreamItem, { kind: "activity_log" }>),
      activityType: "error" as const,
    };
    const items = [item("user_message"), item("thought"), error, assistant("a1")];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toEqual([items[0], error, items[3]]);
    expect(result.workCountByTurnKey.get("a1")).toBe(1);
  });

  test.each(["failed", "canceled"] as const)(
    "leaves %s tool results visible while folding safe details",
    (status) => {
      const exceptionalTool = withToolStatus(status);
      const items = [item("user_message"), item("thought"), exceptionalTool, assistant("a1")];
      const result = collapseCompletedWork({
        items,
        expandedTurnKeys: NONE,
        keepLastTurnExpanded: false,
      });
      expect(result.items).toEqual([items[0], exceptionalTool, items[3]]);
      expect(result.workCountByTurnKey.get("a1")).toBe(1);
    },
  );

  test("does not hide intermediate assistant error messages", () => {
    const errorMessage = assistant("error", { text: "[System Error] provider failed" });
    const items = [item("user_message"), errorMessage, item("tool_call"), assistant("a1")];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toEqual([items[0], errorMessage, items[3]]);
    expect(result.workCountByTurnKey.get("a1")).toBe(1);
  });

  test.each([
    [
      "loading thought",
      {
        ...(item("thought") as Extract<StreamItem, { kind: "thought" }>),
        status: "loading" as const,
      },
    ],
    ["running tool", withToolStatus("running")],
    [
      "loading compaction",
      {
        ...(item("compaction") as Extract<StreamItem, { kind: "compaction" }>),
        status: "loading" as const,
      },
    ],
  ])("does not fold a partially loaded turn with %s", (_label, partialItem) => {
    const items = [item("user_message"), partialItem as StreamItem, assistant("a1")];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toBe(items);
    expect(result.workCountByTurnKey.size).toBe(0);
  });
  test("preserves lossless disclosure invariants across 90 turn shapes", () => {
    const cases = createDisclosureCases();

    for (const [caseIndex, testCase] of cases.entries()) {
      const caseId = caseIndex + 1;
      const user = item("user_message");
      const details: StreamItem[] = [];
      for (let index = 0; index < Math.max(1, testCase.intermediateCount); index += 1) {
        if (index < testCase.intermediateCount) {
          details.push(assistant(`case-${caseId}-intermediate-${index}`));
        }
        details.push(item(testCase.workKind));
      }
      const finalBlocks = Array.from({ length: testCase.finalBlockCount }, (_, index) =>
        assistant(`case-${caseId}-final-${index}`, {
          text: `Final ${index}`,
          messageId:
            testCase.grouping === "block-group"
              ? `case-${caseId}-message`
              : `case-${caseId}-message-${index}`,
          ...(testCase.grouping === "block-group"
            ? { blockGroupId: `case-${caseId}-group`, blockIndex: index }
            : {}),
          ...(index === testCase.finalBlockCount - 1 ? { turnOutcome: "completed" as const } : {}),
        }),
      );
      const items = [user, ...details, ...finalBlocks];
      const collapsed = collapseCompletedWork({
        items,
        expandedTurnKeys: NONE,
        keepLastTurnExpanded: false,
      });
      const turnKey = finalBlocks.at(-1)!.messageId!;

      expect(collapsed.items).toEqual([user, ...finalBlocks]);
      expect(collapsed.items.every((entry) => items.includes(entry))).toBe(true);
      expect(collapsed.workCountByTurnKey.get(turnKey)).toBe(details.length);
      expect(collapsed.summaryTurnKeyByAssistantId.get(finalBlocks[0]!.id)).toBe(turnKey);

      const expanded = collapseCompletedWork({
        items,
        expandedTurnKeys: new Set([turnKey]),
        keepLastTurnExpanded: false,
      });
      expect(expanded.items).toBe(items);
    }

    expect(cases).toHaveLength(90);
  });
});

describe("collapseCompletedWorkStream", () => {
  test("folds a completed turn spanning the tail/head boundary into one summary", () => {
    const user = item("user_message");
    const settledWork = item("tool_call");
    const headWork = item("thought");
    const finalAssistant = assistant("a-final");
    const result = collapseCompletedWorkStream({
      tail: [user, settledWork],
      head: [headWork, finalAssistant],
      expandedTurnKeys: NONE,
      isTurnActive: false,
    });
    expect(result.tail).toEqual([user]);
    expect(result.head).toEqual([finalAssistant]);
    expect(result.workCountByTurnKey.get("a-final")).toBe(2);
    expect(result.summaryTurnKeyByAssistantId.get("a-final")).toBe("a-final");
  });

  test("leaves permission-blocked or streaming head content untouched while active", () => {
    const tail = [item("user_message"), item("tool_call"), assistant("a1")];
    const head = [item("tool_call"), item("thought")];
    const result = collapseCompletedWorkStream({
      tail,
      head,
      expandedTurnKeys: NONE,
      isTurnActive: true,
    });
    expect(result.head).toBe(head);
    expect(result.tail).toBe(tail);
    expect(result.workCountByTurnKey.size).toBe(0);
    expect(result.summaryTurnKeyByAssistantId.size).toBe(0);
  });

  test("collapses an idle head-only completed turn immediately", () => {
    const head = [item("user_message"), item("tool_call"), assistant("a1")];
    const result = collapseCompletedWorkStream({
      tail: [],
      head,
      expandedTurnKeys: NONE,
      isTurnActive: false,
    });
    expect(result.head.map((entry) => entry.kind)).toEqual(["user_message", "assistant_message"]);
    expect(result.workCountByTurnKey.get("a1")).toBe(1);
  });

  test("expanding a spanning turn restores items on both sides without copying", () => {
    const user = item("user_message");
    const settledWork = item("tool_call");
    const headWork = item("thought");
    const finalAssistant = assistant("a-final");
    const result = collapseCompletedWorkStream({
      tail: [user, settledWork],
      head: [headWork, finalAssistant],
      expandedTurnKeys: new Set(["a-final"]),
      isTurnActive: false,
    });
    expect(result.tail).toEqual([user, settledWork]);
    expect(result.head).toEqual([headWork, finalAssistant]);
    expect(result.tail[1]).toBe(settledWork);
    expect(result.head[0]).toBe(headWork);
  });
});
