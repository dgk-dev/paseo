import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { AgentProviderSelectionPolicy } from "@getpaseo/protocol/agent-types";
import type { AgentSession, AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import {
  PiProviderParamsSchema,
  PiRpcAgentClient,
  PiRpcAgentSession,
  projectPiScopedCatalog,
  transformPiModels,
} from "./agent.js";
import { FakePi } from "./test-utils/fake-pi.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("Pi RPC timeout defaults to 60 seconds and accepts an override", () => {
  expect(PiProviderParamsSchema.parse({}).rpcTimeoutMs).toBe(60_000);
  expect(PiProviderParamsSchema.parse({ rpcTimeoutMs: 90_000 }).rpcTimeoutMs).toBe(90_000);
});

const DASEO_PI_SELECTION_POLICY: AgentProviderSelectionPolicy = {
  preferenceMode: "defaults",
  defaultModelId: "pi-codex/gpt-5.6-sol",
  thinkingDefaultsByModel: {
    "pi-codex/gpt-5.6-sol": "high",
    "pi-claude/claude-fable-5": "high",
    "pi-claude/claude-opus-4-8": "xhigh",
  },
  featureDefaultsByModel: {
    "pi-codex/gpt-5.6-sol": { fast_mode: false },
  },
};

function createClient(
  pi = new FakePi(),
  selectionPolicy: AgentProviderSelectionPolicy | undefined = DASEO_PI_SELECTION_POLICY,
): PiRpcAgentClient {
  return new PiRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: pi,
    selectionPolicy,
    catalogScopeProjectionFactory: () => null,
  });
}

function rewindCapabilities(capabilities: PiRpcAgentSession["capabilities"]) {
  return {
    supportsRewindConversation: capabilities.supportsRewindConversation,
    supportsRewindFiles: capabilities.supportsRewindFiles,
    supportsRewindBoth: capabilities.supportsRewindBoth,
  };
}

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "pi",
    cwd: "/tmp/paseo-pi-rpc-test",
    ...overrides,
  };
}

function readUtf8File(pathname: string): string {
  const fd = openSync(pathname, "r");
  try {
    const buffer = Buffer.alloc(fstatSync(fd).size);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

type PaseoExtensionListener = (event: unknown, context?: unknown) => unknown;

async function loadPaseoExtensionListeners(
  extensionPath: string,
): Promise<Map<string, PaseoExtensionListener>> {
  const listeners = new Map<string, PaseoExtensionListener>();
  const extension = (await import(pathToFileURL(extensionPath).href)) as {
    default: (piApi: {
      on: (event: string, listener: PaseoExtensionListener) => void;
      registerCommand: () => void;
    }) => void;
  };
  extension.default({
    on: (event, listener) => listeners.set(event, listener),
    registerCommand: () => undefined,
  });
  return listeners;
}

async function applyPaseoExtensionSystemPrompt(
  extensionPath: string,
  systemPrompt: string,
): Promise<string | undefined> {
  const listeners = await loadPaseoExtensionListeners(extensionPath);
  const result = await listeners.get("before_agent_start")?.({ systemPrompt });
  return (result as { systemPrompt?: string } | undefined)?.systemPrompt;
}

async function flushTurnScheduling(): Promise<void> {
  await waitForImmediate();
}

async function createSession(
  pi = new FakePi(),
  configOverrides: Partial<AgentSessionConfig> = {},
): Promise<{
  pi: FakePi;
  session: PiRpcAgentSession;
  events: SessionEvents;
}> {
  const client = createClient(pi);
  const session = (await client.createSession(createConfig(configOverrides))) as PiRpcAgentSession;
  const events = new SessionEvents(session);
  return { pi, session, events };
}

test("forwards launch-context env to the Pi process launch", async () => {
  const pi = new FakePi();
  const client = createClient(pi);
  const session = await client.createSession(createConfig(), {
    env: {
      CHUNK14_PROBE: "expected",
    },
  });

  expect(pi.recordedLaunches[0]?.env).toEqual({
    CHUNK14_PROBE: "expected",
  });

  await session.close();
});

test("starts internal Pi agents without persisting a native session", async () => {
  const pi = new FakePi();
  const client = createClient(pi);
  const session = await client.createSession(createConfig({ internal: true }));

  expect(pi.recordedLaunches[0]).toMatchObject({
    noSession: true,
    argv: expect.arrayContaining(["--no-session"]),
  });

  await session.close();
});

test("keeps normal Pi agent sessions persisted", async () => {
  const pi = new FakePi();
  const client = createClient(pi);
  const session = await client.createSession(createConfig());

  expect(pi.recordedLaunches[0]?.argv).not.toContain("--no-session");

  await session.close();
});

class SessionEvents {
  private readonly events: AgentStreamEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: AgentStreamEvent) => boolean;
    resolve: (event: AgentStreamEvent) => void;
  }> = [];

  constructor(session: PiRpcAgentSession) {
    session.subscribe((event) => {
      this.events.push(event);
      for (let index = 0; index < this.waiters.length; index += 1) {
        const waiter = this.waiters[index];
        if (waiter.predicate(event)) {
          this.waiters.splice(index, 1);
          index -= 1;
          waiter.resolve(event);
        }
      }
    });
  }

  timelineItems() {
    return this.events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline",
      )
      .map((event) => event.item);
  }

  timelineAndCompletionEvents() {
    return this.events.flatMap((event) => {
      if (event.type === "timeline") {
        return [{ type: "timeline" as const, item: event.item }];
      }
      if (event.type === "turn_completed") {
        return [{ type: "turn_completed" as const }];
      }
      return [];
    });
  }

  eventTypes(): AgentStreamEvent["type"][] {
    return this.events.map((event) => event.type);
  }

  turnCompletedEvents() {
    return this.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "turn_completed" }> =>
        event.type === "turn_completed",
    );
  }

  turnStartedEvents() {
    return this.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "turn_started" }> =>
        event.type === "turn_started",
    );
  }

  turnCanceledEvents() {
    return this.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "turn_canceled" }> =>
        event.type === "turn_canceled",
    );
  }

  nextTurnCompletion(): Promise<Extract<AgentStreamEvent, { type: "turn_completed" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "turn_completed" }> =>
        event.type === "turn_completed",
    );
  }

  nextTurnFailure(): Promise<Extract<AgentStreamEvent, { type: "turn_failed" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "turn_failed" }> =>
        event.type === "turn_failed",
    );
  }

  nextTurnCancellation(): Promise<Extract<AgentStreamEvent, { type: "turn_canceled" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "turn_canceled" }> =>
        event.type === "turn_canceled",
    );
  }

  nextPermissionRequest(): Promise<Extract<AgentStreamEvent, { type: "permission_requested" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
        event.type === "permission_requested",
    );
  }

  nextPermissionResolution(): Promise<Extract<AgentStreamEvent, { type: "permission_resolved" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "permission_resolved" }> =>
        event.type === "permission_resolved",
    );
  }

  nextTimelineEvent(): Promise<Extract<AgentStreamEvent, { type: "timeline" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
        event.type === "timeline",
    );
  }

  private nextEvent<T extends AgentStreamEvent>(
    predicate: (event: AgentStreamEvent) => event is T,
  ): Promise<T> {
    const existing = this.events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.waiters.push({
        predicate,
        resolve: (event) => resolve(event as T),
      });
    });
  }
}

describe("PiRpcAgentSession", () => {
  test("bridges Pi RPC select extension UI requests through question permissions", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("ask");
    fakeSession.emit({
      type: "extension_ui_request",
      id: "ui-1",
      method: "select",
      title: "Pick one",
      options: ["A", "B"],
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      id: "ui-1",
      provider: "pi",
      kind: "question",
      title: "Pick one",
      input: {
        questions: [
          {
            question: "Pick one",
            header: "Response",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
        ],
      },
      metadata: { extensionUiMethod: "select" },
    });
    expect(session.getPendingPermissions()).toHaveLength(1);

    await session.respondToPermission("ui-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "B" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([{ id: "ui-1", response: { value: "B" } }]);
    expect(session.getPendingPermissions()).toEqual([]);
    await expect(events.nextPermissionResolution()).resolves.toMatchObject({
      requestId: "ui-1",
      resolution: { behavior: "allow" },
    });
  });

  test("bridges Pi RPC input and confirm extension UI responses", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "input-1",
      method: "input",
      title: "Your name",
      placeholder: "name",
    });
    await events.nextPermissionRequest();
    await session.respondToPermission("input-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Ada" } },
    });

    fakeSession.emit({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Proceed?",
    });
    await events.nextPermissionRequest();
    await session.respondToPermission("confirm-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "No" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "input-1", response: { value: "Ada" } },
      { id: "confirm-1", response: { confirmed: false } },
    ]);
  });

  test("marks optional Pi RPC input prompts as skippable", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "comment-1",
      method: "input",
      title: "Pick one\n\nSelected option:\n- A",
      placeholder: "Optional comment (press Enter to skip)...",
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      title: "Optional comment",
      input: {
        questions: [
          {
            question: "Optional comment",
            header: "Response",
            options: [],
            multiSelect: false,
            placeholder: "Optional comment (press Enter to skip)...",
            allowEmpty: true,
            dismissLabel: "Skip",
          },
        ],
      },
    });

    await session.respondToPermission("comment-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "comment-1", response: { value: "" } },
    ]);
  });

  test("combines Pi ask_user select and optional comment into one permission", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "ask_user",
      args: {
        question: "Pick one",
        options: ["A", "B"],
        allowComment: true,
        allowFreeform: false,
      },
    });
    fakeSession.emit({
      type: "extension_ui_request",
      id: "select-1",
      method: "select",
      title: "Pick one",
      options: ["A", "B"],
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      id: "select-1",
      name: "Pi ask_user",
      kind: "question",
      title: "Pick one",
      input: {
        questions: [
          {
            question: "Pick one",
            header: "Response",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
          {
            question: "Optional comment",
            header: "Comment",
            options: [],
            multiSelect: false,
            placeholder: "Optional comment (press Enter to skip)...",
            allowEmpty: true,
          },
        ],
      },
      metadata: {
        combinedAskUser: "ask_user_select_optional_comment",
        answerHeader: "Response",
        commentHeader: "Comment",
      },
    });

    await session.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "B", Comment: "Looks good" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "select-1", response: { value: "B" } },
    ]);
    expect(session.getPendingPermissions()).toEqual([]);

    fakeSession.emit({
      type: "extension_ui_request",
      id: "comment-1",
      method: "input",
      title: "Pick one\n\nSelected option:\n- B",
      placeholder: "Optional comment (press Enter to skip)...",
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "select-1", response: { value: "B" } },
      { id: "comment-1", response: { value: "Looks good" } },
    ]);
    expect(session.getPendingPermissions()).toEqual([]);
  });

  test("cancels Pi RPC extension UI dialogs when question permission is denied", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "ui-cancel",
      method: "select",
      title: "Pick one",
      options: ["A", "B"],
    });
    await events.nextPermissionRequest();

    await session.respondToPermission("ui-cancel", {
      behavior: "deny",
      message: "Dismissed by user",
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "ui-cancel", response: { cancelled: true } },
    ]);
  });

  test("ignores Pi RPC fire-and-forget extension UI requests", async () => {
    const { pi } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "notify-1",
      method: "notify",
      message: "hello",
    });

    expect(fakeSession.extensionUiResponses).toEqual([]);
    expect(fakeSession.canceledExtensionUiRequests).toEqual([]);
  });

  test("streams assistant text, reasoning, and tool calls from Pi events", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-1" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "response-1" },
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "response-1" },
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
    });
    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    fakeSession.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { output: "hi\n", exitCode: 0 },
      isError: false,
    });
    fakeSession.finishTurn();

    await events.nextTurnCompletion();

    expect(events.timelineItems()).toEqual([
      { type: "assistant_message", text: "hel", messageId: "response-1" },
      { type: "assistant_message", text: "lo", messageId: "response-1" },
      { type: "reasoning", text: "thinking" },
      {
        type: "tool_call",
        callId: "tool-1",
        name: "bash",
        status: "running",
        detail: { type: "shell", command: "echo hi" },
        error: null,
      },
      {
        type: "tool_call",
        callId: "tool-1",
        name: "bash",
        status: "completed",
        detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
        error: null,
      },
    ]);
  });

  test("steers multiple prompts through one Pi turn and settles only after the queue drains", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const { turnId } = await session.startTurn("initial task", {
      clientMessageId: "client-initial",
    });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.finishSubmittedUserMessage({
      id: "entry-initial",
      parentId: null,
      text: "initial task",
    });

    await expect(
      session.steerTurn?.("new mid-turn context", turnId, {
        clientMessageId: "client-steer",
      }),
    ).resolves.toEqual({ turnId });
    expect(fakeSession.steers).toEqual([{ message: "new mid-turn context", imageCount: 0 }]);

    fakeSession.finishLowLevelRun({
      role: "assistant",
      content: [{ type: "text", text: "intermediate" }],
    });
    expect(events.turnCompletedEvents()).toHaveLength(0);

    fakeSession.finishSubmittedUserMessage({
      id: "entry-steer",
      parentId: "entry-initial",
      text: "new mid-turn context",
    });
    fakeSession.finishLowLevelRun({
      role: "assistant",
      content: [{ type: "text", text: "final" }],
    });
    fakeSession.settleTurn();

    await expect(events.nextTurnCompletion()).resolves.toMatchObject({ turnId });
    expect(events.turnCompletedEvents()).toHaveLength(1);
    expect(events.timelineItems().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "initial task",
        messageId: "entry-initial",
        clientMessageId: "client-initial",
      },
      {
        type: "user_message",
        text: "new mid-turn context",
        messageId: "entry-steer",
        clientMessageId: "client-steer",
        steering: true,
      },
    ]);
  });

  test("emits Pi assistant phase metadata when it arrives at message end", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-final" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "response-final" },
      assistantMessageEvent: { type: "text_delta", delta: "Final answer." },
    });
    fakeSession.emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "response-final",
        content: [
          {
            type: "text",
            text: "Final answer.",
            textSignature: JSON.stringify({
              v: 1,
              id: "response-final",
              phase: "final_answer",
            }),
          },
        ],
      },
    });
    fakeSession.finishTurn();

    await events.nextTurnCompletion();
    expect(events.timelineItems()).toEqual([
      {
        type: "assistant_message",
        text: "Final answer.",
        messageId: "response-final",
      },
      {
        type: "assistant_message",
        text: "",
        messageId: "response-final",
        phase: "final_answer",
      },
    ]);
  });

  test("marks a phase-less Pi assistant message that stopped on its own as a final answer", async () => {
    // Claude through the bridge never attaches a phase signature. Without this,
    // the real answer folded behind a later background-fetch follow-up because
    // only the message that ended the Daseo turn counted as an answer.
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-stop" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "response-stop", stopReason: "stop" },
      assistantMessageEvent: { type: "text_delta", delta: "Real answer." },
    });
    fakeSession.emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "response-stop",
        stopReason: "stop",
        content: [{ type: "text", text: "Real answer." }],
      },
    });
    fakeSession.finishTurn();

    await events.nextTurnCompletion();
    expect(events.timelineItems()).toEqual([
      // The streaming placeholder stopReason must not leak a phase per delta.
      { type: "assistant_message", text: "Real answer.", messageId: "response-stop" },
      { type: "assistant_message", text: "", messageId: "response-stop", phase: "final_answer" },
    ]);
  });

  test("leaves narration before a Pi tool call phase-less", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-tool" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "response-tool" },
      assistantMessageEvent: { type: "text_delta", delta: "Checking the file." },
    });
    fakeSession.emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "response-tool",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Checking the file." },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
        ],
      },
    });
    fakeSession.finishTurn();

    await events.nextTurnCompletion();
    expect(events.timelineItems()).toEqual([
      { type: "assistant_message", text: "Checking the file.", messageId: "response-tool" },
    ]);
  });

  test("streams Pi task calls as sub-agent cards with lifecycle status", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("delegate this");
    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: {
        agent: "explore",
        task: "Trace the Pi provider tool mapper",
      },
    });
    fakeSession.emit({
      type: "tool_execution_end",
      toolCallId: "task-1",
      toolName: "task",
      result: { content: [{ type: "text", text: "Found the mapper." }] },
      isError: false,
    });
    fakeSession.finishTurn();

    await events.nextTurnCompletion();

    expect(events.timelineItems()).toEqual([
      {
        type: "tool_call",
        callId: "task-1",
        name: "task",
        status: "running",
        detail: {
          type: "sub_agent",
          subAgentType: "explore",
          description: "Trace the Pi provider tool mapper",
          log: "",
        },
        error: null,
      },
      {
        type: "tool_call",
        callId: "task-1",
        name: "task",
        status: "completed",
        detail: {
          type: "sub_agent",
          subAgentType: "explore",
          description: "Trace the Pi provider tool mapper",
          log: "Found the mapper.",
        },
        error: null,
      },
    ]);
  });

  test("keeps one generated message id when Pi omits message start and response id", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });

    const [firstChunk, secondChunk] = events.timelineItems();
    expect(firstChunk).toMatchObject({
      type: "assistant_message",
      text: "hel",
      messageId: expect.any(String),
    });
    const firstMessageId = (firstChunk as { messageId: string }).messageId;
    expect(secondChunk).toEqual({
      type: "assistant_message",
      text: "lo",
      messageId: firstMessageId,
    });
  });

  test("uses a response id that first appears on the assistant update", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "late-response-id" },
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });

    expect(events.timelineItems()).toEqual([
      {
        type: "assistant_message",
        text: "hello",
        messageId: "late-response-id",
      },
    ]);
  });

  test("streams assistant text and reasoning when Pi omits the cumulative message", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-1" },
    });
    fakeSession.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
    });
    fakeSession.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });
    fakeSession.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
    });

    expect(events.timelineItems()).toEqual([
      { type: "assistant_message", text: "hel", messageId: "response-1" },
      { type: "assistant_message", text: "lo", messageId: "response-1" },
      { type: "reasoning", text: "thinking" },
    ]);
  });

  test("generates one message id when Pi omits both message start and the cumulative message", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
    });
    fakeSession.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });

    const [firstChunk, secondChunk] = events.timelineItems();
    expect(firstChunk).toMatchObject({
      type: "assistant_message",
      text: "hel",
      messageId: expect.any(String),
    });
    const firstMessageId = (firstChunk as { messageId: string }).messageId;
    expect(secondChunk).toEqual({
      type: "assistant_message",
      text: "lo",
      messageId: firstMessageId,
    });
  });

  test("emits live user messages with submitted Pi tree entry ids", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({ type: "turn_start" });
    fakeSession.finishSubmittedUserMessage({
      id: "entry-user-1",
      parentId: null,
      text: "hello",
    });

    await events.nextTimelineEvent();

    expect(events.timelineItems()).toEqual([
      { type: "user_message", text: "hello", messageId: "entry-user-1" },
    ]);
    expect(events.eventTypes().slice(0, 2)).toEqual(["turn_started", "timeline"]);
  });

  test("uses the Pi entry attached to a submitted prompt after resuming old history", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const session = (await client.resumeSession({
      provider: "pi",
      sessionId: "pi-session-1",
      nativeHandle: "/tmp/native-pi-session",
      metadata: { cwd: "/workspace/project" },
    })) as PiRpcAgentSession;
    const events = new SessionEvents(session);
    const fakeSession = pi.latestSession();
    fakeSession.capturedUserEntries = [{ id: "entry-old", parentId: null, text: "old prompt" }];

    await session.startTurn("new prompt", { clientMessageId: "client-new" });
    fakeSession.finishSubmittedUserMessage({
      id: "entry-new",
      parentId: "entry-old-assistant",
      text: "new prompt",
    });

    await events.nextTimelineEvent();

    expect(events.timelineItems()).toEqual([
      {
        type: "user_message",
        text: "new prompt",
        messageId: "entry-new",
        clientMessageId: "client-new",
      },
    ]);
  });

  test("surfaces Pi extension command messages and completes when no agent turn starts", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("/show-status");
    fakeSession.emit({
      type: "message_end",
      message: {
        role: "custom",
        content: [{ type: "text", text: "Extension command output" }],
      },
    });
    await flushTurnScheduling();

    expect(events.timelineAndCompletionEvents()).toEqual([
      {
        type: "timeline",
        item: {
          type: "assistant_message",
          text: "Extension command output",
          phase: "commentary",
        },
      },
      { type: "timeline", item: { type: "user_message", text: "/show-status" } },
      { type: "turn_completed" },
    ]);
  });

  test("ignores idle extension messages without emitting a turn completion", async () => {
    const { pi, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "message_end",
      message: {
        role: "custom",
        content: [
          {
            type: "text",
            text: "Content fetched for 30/30 URLs. Full page content now available.",
          },
        ],
      },
    });
    await flushTurnScheduling();

    expect(events.turnCompletedEvents()).toHaveLength(0);
    expect(events.timelineItems()).toContainEqual({
      type: "assistant_message",
      text: "Content fetched for 30/30 URLs. Full page content now available.",
      phase: "commentary",
    });
  });

  test("does not let an unrelated custom notification complete an ordinary prompt preflight", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.holdNextPrompt();

    const { turnId } = await session.startTurn("ordinary prompt");
    fakeSession.emit({
      type: "message_end",
      message: {
        role: "custom",
        content: [{ type: "text", text: "Background notification" }],
      },
    });
    await flushTurnScheduling();

    expect(events.turnCompletedEvents()).toHaveLength(0);
    fakeSession.emit({ type: "process_exit", error: "audit shutdown" });
    await expect(events.nextTurnFailure()).resolves.toMatchObject({ turnId });
  });

  test("completes extension-triggered autonomous runs with a stable steerable turn id", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "message_end",
      message: {
        role: "custom",
        content: [{ type: "text", text: "Content fetched for 5/5 URLs." }],
      },
    });
    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    const autonomousTurnId = events.turnStartedEvents()[0]?.turnId;
    expect(autonomousTurnId).toEqual(expect.any(String));
    await expect(
      session.steerTurn?.("include this follow-up", autonomousTurnId!, {
        clientMessageId: "autonomous-steer",
      }),
    ).resolves.toEqual({ turnId: autonomousTurnId });
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "autonomous-response" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "autonomous-response" },
      assistantMessageEvent: { type: "text_delta", delta: "Nothing new in the fetched pages." },
    });
    fakeSession.finishTurn();

    const completion = await events.nextTurnCompletion();
    expect(completion.turnId).toBe(autonomousTurnId);
    expect(events.turnCompletedEvents()).toHaveLength(1);
    expect(events.eventTypes()).toContain("turn_started");
  });

  test("fails an autonomous run symmetrically when the Pi process exits", async () => {
    const { pi, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    const autonomousTurnId = events.turnStartedEvents()[0]?.turnId;
    fakeSession.emit({ type: "process_exit", error: "Pi exited during autonomous work" });

    await expect(events.nextTurnFailure()).resolves.toMatchObject({
      turnId: autonomousTurnId,
      error: "Pi exited during autonomous work",
    });
  });

  test("settlement fallback waits for authoritative runtime idleness", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { pi, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.state.isStreaming = true;

    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.emit({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.turnCompletedEvents()).toHaveLength(0);

    fakeSession.state.isStreaming = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(events.turnCompletedEvents()).toHaveLength(1);
  });

  test("legacy fallback resumes after compaction when agent_settled is missing", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { pi, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.emit({ type: "agent_end", messages: [] });
    fakeSession.emit({ type: "compaction_start", reason: "threshold" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.turnCompletedEvents()).toHaveLength(0);

    fakeSession.emit({ type: "compaction_end", reason: "threshold" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(events.turnCompletedEvents()).toHaveLength(1);
  });

  test("ignores a stale settled event after fallback and a newer turn starts", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const first = await session.startTurn("first");
    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.emit({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(events.turnCompletedEvents()).toHaveLength(1);

    const second = await session.startTurn("second");
    fakeSession.state.isStreaming = true;
    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.emit({ type: "agent_end", messages: [] });
    fakeSession.emit({ type: "agent_settled" });
    await flushTurnScheduling();
    expect(events.turnCompletedEvents()).toHaveLength(1);

    fakeSession.state.isStreaming = false;
    fakeSession.emit({ type: "agent_settled" });
    await flushTurnScheduling();
    expect(events.turnCompletedEvents()[0]).toMatchObject({ turnId: first.turnId });
    expect(events.turnCompletedEvents().at(-1)).toMatchObject({ turnId: second.turnId });
  });

  test("holds the Pi turn open while auto-compaction runs after agent_end", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const { turnId } = await session.startTurn("long research task");
    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.emit({ type: "agent_end", messages: [] });
    fakeSession.emit({ type: "compaction_start", reason: "auto" });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(events.turnCompletedEvents()).toHaveLength(0);

    fakeSession.emit({ type: "compaction_end", reason: "auto" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.emit({ type: "agent_end", messages: [] });
    fakeSession.emit({ type: "agent_settled" });

    const completion = await events.nextTurnCompletion();
    expect(completion.turnId).toBe(turnId);
    expect(events.turnCompletedEvents()).toHaveLength(1);
  });

  test("accepts steering during auto-compaction and delivers it in the continued Pi turn", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const { turnId } = await session.startTurn("long task", {
      clientMessageId: "client-initial",
    });
    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.finishSubmittedUserMessage({
      id: "entry-before-compaction",
      parentId: null,
      text: "long task",
    });
    fakeSession.emit({ type: "agent_end", messages: [] });
    fakeSession.emit({ type: "compaction_start", reason: "auto" });

    await expect(
      session.steerTurn?.("context while compacting", turnId, {
        clientMessageId: "client-during-compaction",
      }),
    ).resolves.toEqual({ turnId });
    expect(fakeSession.steers).toEqual([{ message: "context while compacting", imageCount: 0 }]);
    expect(events.turnCompletedEvents()).toHaveLength(0);

    fakeSession.emit({ type: "compaction_end", reason: "auto" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.finishSubmittedUserMessage({
      id: "entry-during-compaction",
      parentId: "entry-before-compaction",
      text: "context while compacting",
    });
    fakeSession.emit({ type: "agent_end", messages: [] });
    fakeSession.emit({ type: "agent_settled" });

    await expect(events.nextTurnCompletion()).resolves.toMatchObject({ turnId });
    expect(events.timelineItems()).toContainEqual({
      type: "user_message",
      text: "context while compacting",
      messageId: "entry-during-compaction",
      clientMessageId: "client-during-compaction",
      steering: true,
    });
  });

  test("does not close the Pi turn while a native steer acknowledgement is pending", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const { turnId } = await session.startTurn("long task");
    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    fakeSession.holdNextSteer();

    const steering = session.steerTurn?.("last-second context", turnId, {
      clientMessageId: "client-last-second-steer",
    });
    await vi.waitFor(() => {
      expect(fakeSession.steers).toEqual([{ message: "last-second context", imageCount: 0 }]);
    });

    fakeSession.finishTurn();
    await flushTurnScheduling();

    expect(events.turnCompletedEvents()).toHaveLength(0);

    await fakeSession.releaseHeldSteer();
    await expect(steering).resolves.toEqual({ turnId });
    fakeSession.settleTurn();

    await expect(events.nextTurnCompletion()).resolves.toMatchObject({ turnId });
  });

  test("does not complete an active Pi turn for a steered extension message", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const { turnId } = await session.startTurn("keep working");
    fakeSession.emit({ type: "turn_start" });
    await session.steerTurn?.("/show-status", turnId, {
      clientMessageId: "client-extension-steer",
    });
    fakeSession.emit({
      type: "message_end",
      message: {
        role: "custom",
        content: [{ type: "text", text: "Still working" }],
      },
    });

    expect(events.turnCompletedEvents()).toHaveLength(0);
    expect(events.timelineItems()).toContainEqual({
      type: "assistant_message",
      text: "Still working",
      phase: "commentary",
    });

    fakeSession.finishTurn();
    await expect(events.nextTurnCompletion()).resolves.toMatchObject({ turnId });
  });

  test("canceling a silent Pi extension command leaves the session usable", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.holdNextPrompt();
    const firstTurn = await session.startTurn("/silent-search");
    fakeSession.emit({
      type: "extension_ui_request",
      id: "notify-1",
      method: "notify",
      message: "Search finished",
    });
    await session.interrupt();
    const cancellation = await events.nextTurnCancellation();
    await session.startTurn("next request");
    await fakeSession.failHeldPrompt(new Error("Canceled prompt timed out"));

    expect(cancellation).toEqual({
      type: "turn_canceled",
      provider: "pi",
      reason: "interrupted",
      turnId: firstTurn.turnId,
    });
    expect(fakeSession.prompts).toEqual([
      { message: "/silent-search", imageCount: 0 },
      { message: "next request", imageCount: 0 },
    ]);
    await expect(session.startTurn("overlapping request")).rejects.toThrow(
      "A Pi turn is already active",
    );
  });

  test("treats Pi's aborted terminal response as cancellation after an interrupt", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.abort = async () => {
      fakeSession.finishTurn({
        role: "assistant",
        provider: "openai-responses",
        model: "gpt-5.6-terra",
        responseId: "resp-aborted",
        stopReason: "aborted",
        errorMessage: "OpenAI Responses stream ended before a terminal response event",
        content: [],
      });
    };

    const { turnId } = await session.startTurn("stop this turn");
    await session.interrupt();

    await expect(events.nextTurnCancellation()).resolves.toEqual({
      type: "turn_canceled",
      provider: "pi",
      reason: "interrupted",
      turnId,
    });
  });

  test("treats a provider-aborted terminal response as cancellation instead of failure", async () => {
    const { pi, session, events } = await createSession();

    const { turnId } = await session.startTurn("continue the task");
    pi.latestSession().finishTurn({
      role: "assistant",
      provider: "xai-auth",
      model: "grok-4.6",
      responseId: "resp-aborted",
      stopReason: "aborted",
      errorMessage: "xAI API error: Responses failed",
      content: [{ type: "text", text: "Partial useful output" }],
    });

    await expect(events.nextTurnCancellation()).resolves.toEqual({
      type: "turn_canceled",
      provider: "pi",
      reason: "aborted",
      turnId,
    });
    expect(
      (events as unknown as { events: AgentStreamEvent[] }).events.map((event) => event.type),
    ).not.toContain("turn_failed");
  });

  test("suppresses late aborted terminal response arriving after interrupt resolves", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.abort = async () => {};

    const { turnId } = await session.startTurn("stop this turn");
    await session.interrupt();

    await expect(events.nextTurnCancellation()).resolves.toEqual({
      type: "turn_canceled",
      provider: "pi",
      reason: "interrupted",
      turnId,
    });

    fakeSession.finishTurn({
      role: "assistant",
      provider: "openai-responses",
      model: "gpt-5.6-terra",
      responseId: "resp-aborted",
      stopReason: "aborted",
      errorMessage: "OpenAI Responses stream ended before a terminal response event",
      content: [],
    });

    expect(
      (events as unknown as { events: AgentStreamEvent[] }).events.map((e) => e.type),
    ).not.toContain("turn_failed");
  });

  test("does not let a previous interrupt suppress a later autonomous cancellation", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.abort = async () => {};

    await session.startTurn("cancel foreground");
    await session.interrupt();
    expect(events.turnCanceledEvents()).toHaveLength(1);

    fakeSession.emit({ type: "agent_start" });
    fakeSession.emit({ type: "turn_start" });
    const autonomousTurnId = events.turnStartedEvents().at(-1)?.turnId;
    fakeSession.finishTurn({
      role: "assistant",
      provider: "openai-responses",
      model: "gpt-5.6-terra",
      responseId: "autonomous-aborted",
      stopReason: "aborted",
      content: [],
    });
    await flushTurnScheduling();

    expect(events.turnCanceledEvents()).toHaveLength(2);
    expect(events.turnCanceledEvents().at(-1)).toMatchObject({
      turnId: autonomousTurnId,
      reason: "aborted",
    });
  });

  test("adds Pi assistant context to generic provider finish errors", async () => {
    const { pi, session, events } = await createSession();

    await session.startTurn("write qa");
    pi.latestSession().finishTurn({
      role: "assistant",
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      responseId: "gen-test",
      stopReason: "error",
      errorMessage: "Provider finish_reason: error",
      content: [
        {
          type: "thinking",
          thinking: "I will use the write tool for qa.txt.",
        },
      ],
    });

    await expect(events.nextTurnFailure()).resolves.toMatchObject({
      error: expect.stringContaining(
        'Provider finish_reason: error (stopReason=error, model=openrouter/google/gemini-2.5-flash-lite, responseId=gen-test, partial="I will use the write tool for qa.txt.")',
      ),
    });
  });

  test("resumes by launching Pi with the persisted session file and cwd metadata", async () => {
    const pi = new FakePi();
    const client = createClient(pi);

    await client.resumeSession(
      {
        provider: "pi",
        sessionId: "pi-session-1",
        nativeHandle: "/tmp/native-pi-session",
        metadata: {
          cwd: "/workspace/project",
          model: "openrouter/model-a",
          thinkingOptionId: "high",
        },
      },
      {},
      { env: { RESUME_PROBE: "expected" } },
    );

    expect(pi.recordedLaunches).toHaveLength(1);
    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch).toMatchObject({
      cwd: "/workspace/project",
      env: { RESUME_PROBE: "expected" },
      session: "/tmp/native-pi-session",
    });
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--model",
      "openrouter/model-a",
      "--thinking",
      "high",
      "--session",
      "/tmp/native-pi-session",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
  });

  test("reports the persisted Pi entry attached to the submitted message", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const session = await client.createSession(createConfig());
    const extensionPath = pi.recordedLaunches[0]?.extensionPaths[0];
    expect(extensionPath).toBeDefined();
    const listeners = await loadPaseoExtensionListeners(extensionPath!);
    const submittedMessage = { role: "user", content: "new prompt" };
    const entries: Array<{
      type: string;
      id: string;
      parentId: string | null;
      message: { role: string; content: string };
    }> = [
      {
        type: "message",
        id: "entry-old",
        parentId: null,
        message: { role: "user", content: "old prompt" },
      },
    ];
    const notifications: string[] = [];
    const context = {
      sessionManager: { getEntries: () => entries },
      ui: { notify: (message: string) => notifications.push(message) },
    };

    await listeners.get("message_end")?.({ message: submittedMessage }, context);
    entries.push({
      type: "message",
      id: "entry-new",
      parentId: "entry-old-assistant",
      message: submittedMessage,
    });
    await listeners.get("message_start")?.(
      { message: { role: "assistant", content: [] } },
      context,
    );

    expect(notifications).toEqual([
      'PASEO_SUBMITTED_USER_ENTRY {"entry":{"id":"entry-new","parentId":"entry-old-assistant","text":"new prompt"}}',
    ]);

    await session.close();
  });

  test("appends agent and daemon prompts after Pi's discovered system prompt", async () => {
    const pi = new FakePi();
    const client = createClient(pi);

    const session = await client.createSession(
      createConfig({
        systemPrompt: "Agent prompt",
        daemonAppendSystemPrompt: "Daemon prompt",
      }),
    );

    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch).toMatchObject({
      cwd: "/tmp/paseo-pi-rpc-test",
    });
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--thinking",
      "medium",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);

    await expect(
      applyPaseoExtensionSystemPrompt(actualLaunch.extensionPaths[0]!, "Pi project prompt"),
    ).resolves.toBe("Pi project prompt\n\nAgent prompt\n\nDaemon prompt");

    await session.close();
  });

  test("resumes Pi sessions with daemon system prompts appended", async () => {
    const pi = new FakePi();
    const client = createClient(pi);

    await client.resumeSession(
      {
        provider: "pi",
        sessionId: "pi-session-1",
        nativeHandle: "/tmp/native-pi-session",
        metadata: {
          cwd: "/workspace/project",
          model: "openrouter/model-a",
          thinkingOptionId: "high",
          systemPrompt: "Agent prompt",
        },
      },
      {
        daemonAppendSystemPrompt: "Daemon prompt",
      },
    );

    expect(pi.recordedLaunches).toHaveLength(1);
    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch).toMatchObject({
      cwd: "/workspace/project",
      session: "/tmp/native-pi-session",
    });
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--model",
      "openrouter/model-a",
      "--thinking",
      "high",
      "--session",
      "/tmp/native-pi-session",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
    await expect(
      applyPaseoExtensionSystemPrompt(actualLaunch.extensionPaths[0]!, "Pi project prompt"),
    ).resolves.toBe("Pi project prompt\n\nAgent prompt\n\nDaemon prompt");
  });

  test("updates model and thinking through Pi runtime commands", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.setModelResult = { provider: "openrouter", id: "model-a", name: "Model A" };

    await session.setModel("openrouter/model-a");
    await session.setThinkingOption("high");

    expect(fakeSession.setModelRequests).toEqual([{ provider: "openrouter", modelId: "model-a" }]);
    expect(fakeSession.setThinkingLevelRequests).toEqual(["high"]);
  });

  test("exposes and updates fast mode for Pi Codex models", async () => {
    const pi = new FakePi();
    pi.queueSessionSetup((fakeSession) => {
      fakeSession.fastModeEnabled = true;
    });
    const { session } = await createSession(pi, { model: "pi-codex/gpt-5.6-sol" });
    const fakeSession = pi.latestSession();

    expect(session.features).toEqual([
      expect.objectContaining({ id: "fast_mode", type: "toggle", value: true }),
    ]);

    await session.setFeature("fast_mode", false);

    expect(fakeSession.featureSetRequests).toEqual([{ featureId: "fast_mode", value: false }]);
    expect(session.features).toEqual([
      expect.objectContaining({ id: "fast_mode", type: "toggle", value: false }),
    ]);
  });

  test("applies a saved fast-mode preference before the first Pi Codex turn", async () => {
    const pi = new FakePi();
    const { session } = await createSession(pi, {
      model: "pi-codex/gpt-5.6-sol",
      featureValues: { fast_mode: true },
    });

    expect(pi.latestSession().featureSetRequests).toEqual([
      { featureId: "fast_mode", value: true },
    ]);
    expect(session.features).toEqual([
      expect.objectContaining({ id: "fast_mode", type: "toggle", value: true }),
    ]);
  });

  test("hides fast mode for Pi models without a feature host", async () => {
    const { session } = await createSession(new FakePi(), {
      model: "pi-claude/claude-fable-5",
    });

    expect(session.features).toEqual([]);
    await expect(session.setFeature("fast_mode", true)).rejects.toThrow(
      "is not available for the selected model",
    );
  });

  test("resets fast mode before switching from Sol to Claude and does not restore stale state", async () => {
    const pi = new FakePi();
    const { session } = await createSession(pi, {
      model: "pi-codex/gpt-5.6-sol",
      featureValues: { fast_mode: true },
    });
    const fakeSession = pi.latestSession();

    fakeSession.setModelResult = {
      provider: "pi-claude",
      id: "claude-fable-5",
      name: "Claude Fable 5",
      reasoning: true,
    };
    await session.setModel("pi-claude/claude-fable-5");

    expect(session.features).toEqual([]);
    expect(fakeSession.featureSetRequests).toEqual([
      { featureId: "fast_mode", value: true },
      { featureId: "fast_mode", value: false },
    ]);
    await expect(session.setFeature("fast_mode", true)).rejects.toThrow(
      "is not available for the selected model",
    );

    fakeSession.setModelResult = {
      provider: "pi-codex",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      reasoning: true,
    };
    await session.setModel("pi-codex/gpt-5.6-sol");
    expect(session.features).toEqual([expect.objectContaining({ id: "fast_mode", value: false })]);
  });

  test("materializes image prompts as text hints for text-only Pi models", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.setModelResult = {
      provider: "openrouter",
      id: "openai/gpt-oss-20b:free",
      name: "OpenAI: gpt-oss-20b (free)",
      input: ["text"],
    };

    await session.setModel("openrouter/openai/gpt-oss-20b:free");
    await session.startTurn([
      { type: "text", text: "Describe this image." },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    let imagePath: string | undefined;
    try {
      expect(fakeSession.prompts).toHaveLength(1);
      const prompt = fakeSession.prompts[0]!;
      expect(prompt.imageCount).toBe(0);
      expect(prompt.message).toContain("Describe this image.");
      expect(prompt.message).not.toContain(ONE_BY_ONE_PNG_BASE64);
      imagePath = prompt.message.match(/\[Image available at: (.+)\]/)?.[1];
      expect(imagePath).toBeTypeOf("string");
      expect(imagePath).toMatch(
        /paseo-attachments(?:-[^\\/]+)?[\\/](?:[^\\/]+[\\/])?[0-9a-f]{64}\.png$/,
      );
      expect(existsSync(imagePath!)).toBe(true);
    } finally {
      if (imagePath) {
        rmSync(imagePath, { force: true });
      }
    }
  });

  test("materializes image prompts when Pi model capabilities are unknown", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn([
      { type: "text", text: "Describe this image." },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    let imagePath: string | undefined;
    try {
      expect(fakeSession.prompts).toHaveLength(1);
      const prompt = fakeSession.prompts[0]!;
      expect(prompt.imageCount).toBe(0);
      expect(prompt.message).toContain("Describe this image.");
      imagePath = prompt.message.match(/\[Image available at: (.+)\]/)?.[1];
      expect(imagePath).toBeTypeOf("string");
      expect(existsSync(imagePath!)).toBe(true);
    } finally {
      if (imagePath) {
        rmSync(imagePath, { force: true });
      }
    }
  });

  test("forwards raw image prompts for vision-capable Pi models", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.setModelResult = {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT-4o",
      input: ["text", "image"],
    };

    await session.setModel("openai/gpt-4o");
    await session.startTurn([
      { type: "text", text: "Describe this image." },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    expect(fakeSession.prompts).toEqual([
      {
        message: "Describe this image.",
        imageCount: 1,
      },
    ]);
  });

  test("fails the active turn when the Pi process exits mid-turn", async () => {
    const { pi, session, events } = await createSession();

    await session.startTurn("hello");
    pi.latestSession().emit({ type: "process_exit", error: "Pi exited" });

    await expect(events.nextTurnFailure()).resolves.toMatchObject({
      error: "Pi exited",
    });
  });

  test("completes locally handled slash commands when agentInvoked is false", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.promptAck = { agentInvoked: false };

    const { turnId: usageTurnId } = await session.startTurn("/usage");
    fakeSession.emit({
      type: "command_output",
      text: "\u001b[38;2;138;138;138mUsage 12%\u001b[39m",
    });

    await flushTurnScheduling();
    const usageCompletion = await events.nextTurnCompletion();
    expect(usageCompletion).toMatchObject({ type: "turn_completed", turnId: usageTurnId });
    expect(events.timelineAndCompletionEvents()).toEqual([
      { type: "timeline", item: { type: "user_message", text: "/usage" } },
      { type: "timeline", item: { type: "assistant_message", text: "Usage 12%" } },
      { type: "turn_completed" },
    ]);

    const { turnId: helloTurnId } = await session.startTurn("hello");
    fakeSession.finishTurn();
    await flushTurnScheduling();
    expect(events.turnCompletedEvents()).toHaveLength(2);
    expect(events.turnCompletedEvents()[1]).toMatchObject({
      type: "turn_completed",
      turnId: helloTurnId,
    });
  });

  test("does not synthesize completion when agentInvoked is true for slash prompts", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.promptAck = { agentInvoked: true };

    const { turnId } = await session.startTurn("/usage");
    await flushTurnScheduling();
    expect(events.turnCompletedEvents()).toHaveLength(0);

    fakeSession.emit({ type: "agent_start" });
    fakeSession.finishTurn();
    await flushTurnScheduling();

    const completion = await events.nextTurnCompletion();
    expect(completion).toMatchObject({ type: "turn_completed", turnId });
    expect(events.turnCompletedEvents()).toHaveLength(1);
  });

  test("probes slash prompts without agentInvoked and surfaces buffered notify output", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const { turnId } = await session.startTurn("/plan on");
    fakeSession.emit({
      type: "extension_ui_request",
      id: "notify-plan",
      method: "notify",
      message: "Plan mode enabled",
    });

    await flushTurnScheduling();
    const completion = await events.nextTurnCompletion();
    expect(completion).toMatchObject({ type: "turn_completed", turnId });
    expect(events.timelineAndCompletionEvents()).toEqual([
      { type: "timeline", item: { type: "user_message", text: "/plan on" } },
      { type: "timeline", item: { type: "assistant_message", text: "Plan mode enabled" } },
      { type: "turn_completed" },
    ]);
  });

  test("does not synthesize completion when lifecycle starts before the no-turn probe", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const { turnId } = await session.startTurn("/custom-template-cmd");
    fakeSession.emit({
      type: "extension_ui_request",
      id: "notify-buffered",
      method: "notify",
      message: "Should not appear after turn starts",
    });
    fakeSession.emit({ type: "agent_start" });

    await flushTurnScheduling();
    expect(events.turnCompletedEvents()).toHaveLength(0);
    expect(events.timelineItems()).toEqual([]);

    fakeSession.finishTurn();
    await flushTurnScheduling();
    const completion = await events.nextTurnCompletion();
    expect(completion).toMatchObject({ type: "turn_completed", turnId });
    expect(events.turnCompletedEvents()).toHaveLength(1);
  });

  test("fails slash turns when the no-turn getState barrier errors", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.getStateError = new Error("get_state timed out");

    const { turnId } = await session.startTurn("/local-command on");
    await flushTurnScheduling();

    await expect(events.nextTurnFailure()).resolves.toMatchObject({
      turnId,
      error: "get_state timed out",
    });

    fakeSession.getStateError = null;
    const { turnId: recoveryTurnId } = await session.startTurn("hello");
    fakeSession.finishTurn();
    await flushTurnScheduling();
    await expect(events.nextTurnCompletion()).resolves.toMatchObject({
      type: "turn_completed",
      turnId: recoveryTurnId,
    });
  });

  test("does not probe non-slash prompts when agentInvoked is missing", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    const { turnId } = await session.startTurn("hello");
    await flushTurnScheduling();
    expect(events.turnCompletedEvents()).toHaveLength(0);

    fakeSession.finishTurn();
    await flushTurnScheduling();
    const completion = await events.nextTurnCompletion();
    expect(completion).toMatchObject({ type: "turn_completed", turnId });
    expect(events.turnCompletedEvents()).toHaveLength(1);
  });
});

describe("PiRpcAgentClient", () => {
  test("lists JSONL persisted sessions from configured provider params", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-sessions-"));
    const cwd = path.join(root, "workspace");
    const otherCwd = path.join(root, "other");
    const sessionsDir = path.join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "20260101_session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-session-jsonl",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "first prompt" },
        }),
        JSON.stringify({
          type: "session_info",
          id: "info-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          name: "Imported Pi session",
        }),
        JSON.stringify({
          type: "message",
          id: "entry-2",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: { role: "user", content: [{ type: "text", text: "last prompt" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(sessionsDir, "other.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "other", cwd: otherCwd })}\n`,
      "utf8",
    );
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      providerParams: { sessionDir: sessionsDir },
    });

    await expect(client.listImportableSessions({ cwd })).resolves.toEqual([
      {
        providerHandleId: sessionFile,
        cwd,
        title: "Imported Pi session",
        firstPromptPreview: "first prompt",
        lastPromptPreview: "last prompt",
        lastActivityAt: new Date("2026-01-01T00:00:03.000Z"),
      },
    ]);
  });

  test("lists JSONL persisted sessions from Pi's configured agent directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-default-sessions-"));
    const cwd = path.join(root, "workspace");
    const agentDir = path.join(root, ".pi", "agent");
    const sessionsDir = path.join(agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "20260102_session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-default-session",
          timestamp: "2026-01-02T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          timestamp: "2026-01-02T00:00:01.000Z",
          message: { role: "user", content: "default dir prompt" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      runtimeSettings: {
        env: {
          PI_CODING_AGENT_DIR: agentDir,
        },
      },
    });

    await expect(client.listImportableSessions({ cwd })).resolves.toMatchObject([
      {
        providerHandleId: sessionFile,
        cwd,
        title: "default dir prompt",
        firstPromptPreview: "default dir prompt",
        lastPromptPreview: "default dir prompt",
      },
    ]);
  });

  test("imports JSONL sessions with the recorded model and thinking level", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-import-config-"));
    const cwd = path.join(root, "workspace");
    const sessionsDir = path.join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "20260103_session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-import-session",
          timestamp: "2026-01-03T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          timestamp: "2026-01-03T00:00:01.000Z",
          message: { role: "user", content: "first prompt" },
        }),
        JSON.stringify({
          type: "model_change",
          id: "model-1",
          timestamp: "2026-01-03T00:00:02.000Z",
          provider: "openrouter",
          modelId: "anthropic/claude-sonnet-4.5",
        }),
        JSON.stringify({
          type: "thinking_level_change",
          id: "thinking-1",
          timestamp: "2026-01-03T00:00:03.000Z",
          thinkingLevel: "high",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const pi = new FakePi();
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: pi,
      providerParams: { sessionDir: sessionsDir },
    });

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd },
      { config: createConfig({ cwd }), storedConfig: createConfig({ cwd }) },
    );

    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--model",
      "openrouter/anthropic/claude-sonnet-4.5",
      "--thinking",
      "high",
      "--session",
      sessionFile,
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
    expect(imported.config).toMatchObject({
      provider: "pi",
      cwd,
      model: "openrouter/anthropic/claude-sonnet-4.5",
      thinkingOptionId: "high",
    });
    expect(imported.persistence.metadata).toMatchObject({
      provider: "pi",
      cwd,
      model: "openrouter/anthropic/claude-sonnet-4.5",
      thinkingOptionId: "high",
    });
  });

  test("discovers models from a short-lived Pi session in the requested cwd", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const catalogPromise = client.fetchCatalog({
      scope: "workspace",
      cwd: "/workspace/with-extension",
      force: false,
    });
    pi.latestSession().models = [
      {
        provider: "openrouter",
        id: "google/gemini-2.5-flash-lite",
        name: "google/gemini-2.5-flash-lite",
        reasoning: true,
      },
    ];

    await expect(catalogPromise).resolves.toMatchObject({
      models: [
        {
          provider: "pi",
          id: "openrouter/google/gemini-2.5-flash-lite",
          label: "gemini-2.5-flash-lite",
          defaultThinkingOptionId: "medium",
        },
      ],
      modes: [],
    });
    expect(pi.recordedLaunches[0]).toMatchObject({
      cwd: "/workspace/with-extension",
      noSession: true,
      argv: ["pi", "--mode", "rpc", "--no-session"],
    });
  });

  test("projects Pi scopedModels as the ordered visible catalog and its pinned defaults", () => {
    const projected = projectPiScopedCatalog({
      models: [
        { provider: "pi-claude", id: "claude-fable-5", reasoning: true },
        {
          provider: "pi-claude",
          id: "claude-opus-4-8",
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        },
        {
          provider: "pi-claude",
          id: "claude-opus-5",
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        },
        { provider: "pi-codex", id: "gpt-5.6-sol", reasoning: true },
        { provider: "xai-auth", id: "grok-4.6", reasoning: true },
        { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true },
      ],
      scopedModels: [
        { provider: "pi-codex", id: "gpt-5.6-sol", thinkingLevel: "high" },
        { provider: "pi-claude", id: "claude-fable-5", thinkingLevel: "high" },
        { provider: "pi-claude", id: "claude-opus-4-8", thinkingLevel: "xhigh" },
        { provider: "pi-claude", id: "claude-opus-5", thinkingLevel: "xhigh" },
        { provider: "xai-auth", id: "grok-4.6", thinkingLevel: "high" },
      ],
      activeModel: { provider: "pi-codex", id: "gpt-5.6-sol" },
      activeThinkingLevel: "high",
      selectionPolicy: { preferenceMode: "defaults" },
    });

    expect(projected.map((model) => model.id)).toEqual([
      "pi-codex/gpt-5.6-sol",
      "pi-claude/claude-fable-5",
      "pi-claude/claude-opus-4-8",
      "pi-claude/claude-opus-5",
      "xai-auth/grok-4.6",
    ]);
    expect(projected.map((model) => model.defaultThinkingOptionId)).toEqual([
      "high",
      "high",
      "xhigh",
      "xhigh",
      "high",
    ]);
    expect(projected.find((model) => model.isDefault)?.id).toBe("pi-codex/gpt-5.6-sol");
  });

  test("projects only provider-native effort levels and removes mapped aliases", () => {
    const fiveLevels = {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    } as const;
    const projected = projectPiScopedCatalog({
      models: [
        {
          provider: "pi-codex",
          id: "gpt-5.6-sol",
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
        },
        {
          provider: "pi-codex",
          id: "gpt-6-astra",
          reasoning: true,
          thinkingLevelMap: fiveLevels,
        },
        {
          provider: "pi-claude",
          id: "claude-fable-5-1",
          reasoning: true,
          thinkingLevelMap: fiveLevels,
        },
        {
          provider: "pi-claude",
          id: "claude-fable-5",
          reasoning: true,
          thinkingLevelMap: fiveLevels,
        },
        {
          provider: "pi-claude",
          id: "claude-opus-4-8",
          reasoning: true,
          thinkingLevelMap: fiveLevels,
        },
        {
          provider: "pi-claude",
          id: "claude-opus-5",
          reasoning: true,
          thinkingLevelMap: fiveLevels,
        },
        {
          provider: "xai-auth",
          id: "grok-4.6",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: "low",
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: null,
          },
        },
      ],
      scopedModels: [],
      activeModel: null,
      selectionPolicy: {
        preferenceMode: "defaults",
        thinkingDefaultsByModel: { "pi-codex/gpt-5.6-sol": "minimal" },
      },
    });
    const optionsByModel: Record<string, string[] | undefined> = {};
    for (const model of projected) {
      optionsByModel[model.id] = model.thinkingOptions?.map((option) => option.id);
    }

    expect(optionsByModel).toEqual({
      "pi-codex/gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
      "pi-codex/gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
      "pi-claude/claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
      "pi-claude/claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
      "pi-claude/claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
      "pi-claude/claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
      "xai-auth/grok-4.6": ["low", "medium", "high", "xhigh"],
    });
    expect(projected[0]?.defaultThinkingOptionId).toBe("low");
  });

  test("pins Daseo per-model defaults: Sol default model, Sol/Fable high, Opus xhigh", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const catalogPromise = client.fetchCatalog({
      scope: "workspace",
      cwd: "/workspace",
      force: false,
    });
    pi.latestSession().models = [
      { provider: "pi-claude", id: "claude-fable-5", reasoning: true },
      {
        provider: "pi-claude",
        id: "claude-opus-4-8",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
      { provider: "pi-codex", id: "gpt-5.6-sol", reasoning: true },
      { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true },
    ];

    const catalog = await catalogPromise;
    const byId = new Map(catalog.models.map((model) => [model.id, model]));
    expect(byId.get("pi-claude/claude-fable-5")).toMatchObject({
      defaultThinkingOptionId: "high",
    });
    expect(byId.get("pi-claude/claude-fable-5")?.isDefault).toBeUndefined();
    expect(byId.get("pi-claude/claude-opus-4-8")).toMatchObject({
      defaultThinkingOptionId: "xhigh",
    });
    expect(byId.get("pi-codex/gpt-5.6-sol")).toMatchObject({
      isDefault: true,
      defaultThinkingOptionId: "high",
    });
    expect(
      byId.get("pi-codex/gpt-5.6-sol")?.thinkingOptions?.find((option) => option.isDefault)?.id,
    ).toBe("high");
    expect(byId.get("deepseek/deepseek-v4-flash")).toMatchObject({
      defaultThinkingOptionId: "medium",
    });
    expect(byId.get("deepseek/deepseek-v4-flash")?.isDefault).toBeUndefined();
  });

  test("lists no draft features without an explicit Pi model", async () => {
    const pi = new FakePi();
    const client = createClient(pi);

    await expect(client.listFeatures(createConfig())).resolves.toEqual([]);

    expect(pi.recordedLaunches).toHaveLength(0);
  });

  test("discovers Pi Codex fast mode for a draft without creating a session file", async () => {
    const pi = new FakePi();
    pi.queueSessionSetup((fakeSession) => {
      fakeSession.fastModeEnabled = true;
    });
    const client = createClient(pi);

    await expect(
      client.listFeatures(createConfig({ model: "pi-codex/gpt-5.6-sol" })),
    ).resolves.toEqual([expect.objectContaining({ id: "fast_mode", type: "toggle", value: true })]);

    expect(pi.recordedLaunches).toHaveLength(1);
    expect(pi.recordedLaunches[0]).toMatchObject({
      model: "pi-codex/gpt-5.6-sol",
      noSession: true,
    });
  });

  test("maps extension, prompt, and skill commands to Paseo slash commands", async () => {
    const { pi, session } = await createSession();
    pi.latestSession().commands = [
      { name: "review", description: "Review changes", source: "extension" },
      { name: "fix-tests", description: "Fix tests", source: "prompt" },
      { name: "skill:docs", description: "Read docs", source: "skill" },
    ];

    await expect(session.listCommands()).resolves.toEqual([
      {
        name: "compact",
        description: "Manually compact the session context",
        argumentHint: "[instructions]",
        kind: "command",
      },
      {
        name: "autocompact",
        description: "Toggle automatic context compaction",
        argumentHint: "[on|off|toggle]",
        kind: "command",
      },
      { name: "review", description: "Review changes", argumentHint: "", kind: "command" },
      { name: "fix-tests", description: "Fix tests", argumentHint: "", kind: "command" },
      { name: "skill:docs", description: "Read docs", argumentHint: "", kind: "skill" },
    ]);
  });

  test("lists Pi compact even when RPC get_commands omits built-in slash commands", async () => {
    const { pi, session } = await createSession();
    pi.latestSession().commands = [
      { name: "review", description: "Review changes", source: "extension" },
    ];

    await expect(session.listCommands()).resolves.toContainEqual({
      name: "compact",
      description: "Manually compact the session context",
      argumentHint: "[instructions]",
      kind: "command",
    });
    await expect(session.listCommands()).resolves.toContainEqual({
      name: "autocompact",
      description: "Toggle automatic context compaction",
      argumentHint: "[on|off|toggle]",
      kind: "command",
    });
  });

  test("preserves known argument hints when RPC get_commands returns built-in slash commands", async () => {
    const { pi, session } = await createSession();
    pi.latestSession().commands = [
      { name: "compact", description: "Compact from RPC", source: "extension" },
      { name: "autocompact", description: "Auto compact from RPC", source: "extension" },
    ];

    await expect(session.listCommands()).resolves.toEqual([
      {
        name: "compact",
        description: "Compact from RPC",
        argumentHint: "[instructions]",
        kind: "command",
      },
      {
        name: "autocompact",
        description: "Auto compact from RPC",
        argumentHint: "[on|off|toggle]",
        kind: "command",
      },
    ]);
  });

  test("executes Pi compact through RPC instead of prompt text", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/compact focus on tests");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.compactRequests).toEqual([{ customInstructions: "focus on tests" }]);
    expect(fakeSession.prompts).toEqual([]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "compaction", status: "loading", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "compaction", status: "completed", trigger: "manual" },
      },
    ]);
  });

  test("closes Pi compact loading marker when RPC rejects after compaction starts", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.emitCompactEnd = false;
    fakeSession.compactError = new Error("summarizer failed");
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/compact");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "compaction", status: "loading", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "compaction", status: "completed", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "[Error] Failed to compact context: summarizer failed",
        },
      },
    ]);
  });

  test("executes Pi autocompact through RPC instead of prompt text", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/autocompact off");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.setAutoCompactionRequests).toEqual([false]);
    expect(fakeSession.prompts).toEqual([]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "Auto-compaction disabled." },
      },
    ]);
  });

  test("rejects unknown Pi autocompact mode instead of toggling", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/autocompact banana");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.setAutoCompactionRequests).toEqual([]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "[Error] Usage: /autocompact [on|off|toggle]",
        },
      },
    ]);
  });

  test("toggles Pi autocompact through current RPC state", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.state.autoCompactionEnabled = false;
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/autocompact");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.setAutoCompactionRequests).toEqual([true]);
    expect(events).toContainEqual({
      type: "timeline",
      provider: "pi",
      item: { type: "assistant_message", text: "Auto-compaction enabled." },
    });
  });

  test("rejects Pi autocompact toggle when current RPC state is unavailable", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    delete fakeSession.state.autoCompactionEnabled;
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/autocompact");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.setAutoCompactionRequests).toEqual([]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "[Error] Auto-compaction state is unavailable. Use /autocompact on or /autocompact off.",
        },
      },
    ]);
  });

  test("rewinds conversation through the Pi tree navigation bridge", async () => {
    const { pi, session, events } = await createSession();
    pi.latestSession().capturedUserEntries = [
      { id: "entry-1", parentId: null, text: "first prompt" },
      { id: "entry-3", parentId: "entry-2", text: "second prompt" },
    ];

    await session.startTurn("first prompt");
    pi.latestSession().finishTurn({ role: "assistant", content: [] });
    await events.nextTurnCompletion();

    await session.revertConversation?.({ messageId: "entry-1" });

    expect(rewindCapabilities(session.capabilities)).toEqual({
      supportsRewindConversation: true,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    });
    expect(pi.latestSession().treeNavigationRequests).toEqual(["entry-1"]);
  });

  test("injects MCP servers without replacing the Pi global MCP config", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "paseo-pi-agent-"));
    onTestFinished(() => rmSync(agentDir, { recursive: true, force: true }));
    writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({
        settings: { toolPrefix: "none", disableProxyTool: true },
        "mcp-servers": {
          "brave-search": {
            url: "https://example.com/mcp/brave",
            directTools: ["brave_llm_context"],
          },
        },
      }),
    );
    const pi = new FakePi();
    pi.queueCommands([
      {
        name: "mcp",
        description: "Show MCP server status",
        source: "extension",
        sourceInfo: { source: "npm:pi-mcp-adapter" },
      },
    ]);
    const client = createClient(pi);

    const session = await client.createSession(
      createConfig({
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
          },
          localSecret: {
            type: "stdio",
            command: "node",
            args: ["secret-server.js"],
            env: { SECRET_NUMBER: "314159" },
          },
        },
      }),
      { env: { PI_CODING_AGENT_DIR: agentDir } },
    );

    expect(pi.recordedLaunches).toHaveLength(2);
    expect(pi.recordedLaunches[0]).toMatchObject({
      cwd: "/tmp/paseo-pi-rpc-test",
      argv: ["pi", "--mode", "rpc"],
    });
    const actualLaunch = pi.recordedLaunches[1]!;
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--thinking",
      "medium",
      "--mcp-config",
      actualLaunch.mcpConfigPath,
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
    expect(session.capabilities.supportsMcpServers).toBe(true);

    const configPath = actualLaunch.mcpConfigPath;
    expect(configPath).toEqual(expect.any(String));
    const injectedConfig = JSON.parse(readUtf8File(configPath!)) as {
      mcpServers: Record<string, unknown>;
    };
    expect(injectedConfig).toEqual({
      settings: { toolPrefix: "none", disableProxyTool: true },
      mcpServers: {
        "brave-search": {
          url: "https://example.com/mcp/brave",
          directTools: ["brave_llm_context"],
        },
        paseo: {
          url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
          auth: false,
          oauth: false,
        },
        localSecret: {
          command: "node",
          args: ["secret-server.js"],
          env: { SECRET_NUMBER: "314159" },
        },
      },
    });

    await session.close();
    expect(existsSync(configPath!)).toBe(false);
  });

  test("reports the path of a malformed Pi global MCP config", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "paseo-pi-agent-"));
    onTestFinished(() => rmSync(agentDir, { recursive: true, force: true }));
    const configPath = path.join(agentDir, "mcp.json");
    writeFileSync(configPath, "{ invalid");
    const pi = new FakePi();
    pi.queueCommands([{ name: "mcp", source: "extension" }]);
    const client = createClient(pi);

    await expect(
      client.createSession(
        createConfig({
          mcpServers: {
            paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents" },
          },
        }),
        { env: { PI_CODING_AGENT_DIR: agentDir } },
      ),
    ).rejects.toThrow(`Failed to parse Pi MCP config: ${configPath}`);
  });

  test("does not pass MCP config when pi-mcp-adapter is not loaded", async () => {
    const pi = new FakePi();
    pi.queueCommands([]);
    const client = createClient(pi);

    const session = await client.createSession(
      createConfig({
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
          },
        },
      }),
    );

    expect(pi.recordedLaunches).toHaveLength(2);
    const actualLaunch = pi.recordedLaunches[1]!;
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--thinking",
      "medium",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
    expect(actualLaunch.mcpConfigPath).toBeUndefined();
    expect(session.capabilities.supportsMcpServers).toBe(false);
  });
});

describe("transformPiModels", () => {
  test("normalizes labels that include the upstream provider prefix", () => {
    expect(
      transformPiModels([
        {
          provider: "pi",
          id: "openrouter/google/gemini-2.5-flash-lite",
          label: "openrouter/google/gemini_2.5 flash lite",
        },
        {
          provider: "pi",
          id: "openrouter/openai/gpt-5.5",
          label: "openrouter/OpenAI: GPT-5.5",
        },
      ]),
    ).toEqual([
      {
        provider: "pi",
        id: "openrouter/google/gemini-2.5-flash-lite",
        label: "gemini 2.5 flash lite",
        description: "openrouter/google/gemini_2.5 flash lite",
      },
      {
        provider: "pi",
        id: "openrouter/openai/gpt-5.5",
        label: "GPT-5.5",
        description: "openrouter/OpenAI: GPT-5.5",
      },
    ]);
  });
});
