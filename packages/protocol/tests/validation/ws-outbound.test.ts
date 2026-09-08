import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";
import { WSOutboundMessageSchema as GeneratedWSOutboundMessageSchema } from "../../src/generated/validation/ws-outbound.aot.js";

interface GeneratedSchema {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedWSOutboundPath = resolve(
  protocolRoot,
  "src/generated/validation/ws-outbound.aot.ts",
);
const require = createRequire(import.meta.url);

async function compileInlineSchema(sourceSchema: string): Promise<GeneratedSchema> {
  const scratchRoot = resolve(protocolRoot, "../../.tmp");
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, "paseo-zod-aot-"));

  try {
    const sourcePath = join(tempDir, "schema.source.js");
    const outputPath = join(tempDir, "schema.generated.ts");
    await writeFile(join(tempDir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      sourcePath,
      [
        'import { z } from "zod";',
        'import { compile } from "zod-aot";',
        sourceSchema,
        "export const Schema = compile(SourceSchema);",
        "",
      ].join("\n"),
    );

    const zodAotEntry = require.resolve("zod-aot");
    const zodAotRoot = resolve(dirname(zodAotEntry), "..");
    const [{ discoverSchemas }, { compileSchemas }, { generateCompiledFileContent }] =
      await Promise.all([
        import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
      ]);

    const schemas = await discoverSchemas(sourcePath, { cacheBust: true });
    const compiled = compileSchemas(schemas, { mode: "inline" });
    const content = generateCompiledFileContent(compiled, "./schema.source.js", {
      zodCompat: false,
    });
    await writeFile(outputPath, content);

    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const generated = await jiti.import(outputPath);
    return generated.Schema as GeneratedSchema;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("WS outbound zod-aot validation", () => {
  it("applies defaults inside discriminated-union branches", async () => {
    const schema = await compileInlineSchema(`
const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("with_default"),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("without_default"),
    label: z.string(),
  }),
]);
`);

    expect(schema.safeParse({ type: "with_default" })).toMatchObject({
      success: true,
      data: { type: "with_default", enabled: true },
    });
  });

  it("routes tool-call-like status unions through the current sequential item union", async () => {
    const schema = await compileInlineSchema(`
const ToolCallItemSchema = z.discriminatedUnion("status", [
  z.object({ type: z.literal("tool_call"), status: z.literal("running"), callId: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("completed"), callId: z.string(), output: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("failed"), callId: z.string(), error: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("canceled"), callId: z.string() }),
]);

const TimelineItemSchema = z.union([
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  ToolCallItemSchema,
]);

const SourceSchema = z.object({
  item: TimelineItemSchema,
});
`);

    expect(
      schema.safeParse({ item: { type: "tool_call", status: "running", callId: "run" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "running", callId: "run" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "completed", callId: "done", output: "ok" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "completed", callId: "done", output: "ok" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" } },
    });
    expect(
      schema.safeParse({ item: { type: "tool_call", status: "canceled", callId: "stop" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "canceled", callId: "stop" } },
    });
  });

  it("keeps transformed members reachable inside a discriminated union", async () => {
    // zod-aot 0.20.4 dropped `.transform()` members from the generated discriminator
    // dispatch, which silently invalidated every message carrying a text attachment.
    const schema = await compileInlineSchema(`
const SourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plain"), label: z.string() }),
  z
    .object({ type: z.literal("transformed"), text: z.string(), contextKind: z.string().optional() })
    .transform(({ contextKind, ...attachment }) => ({
      ...attachment,
      ...(contextKind === "keep" ? { contextKind } : {}),
    })),
]);
`);

    expect(schema.safeParse({ type: "plain", label: "ok" })).toMatchObject({ success: true });
    expect(schema.safeParse({ type: "transformed", text: "body" })).toMatchObject({
      success: true,
      data: { type: "transformed", text: "body" },
    });
    expect(
      schema.safeParse({ type: "transformed", text: "body", contextKind: "keep" }),
    ).toMatchObject({
      success: true,
      data: { type: "transformed", text: "body", contextKind: "keep" },
    });
    expect(
      schema.safeParse({ type: "transformed", text: "body", contextKind: "drop" }),
    ).toMatchObject({ success: true, data: { type: "transformed", text: "body" } });
  });

  it("accepts a minimal valid envelope and rejects a corrupted envelope", () => {
    expect(GeneratedWSOutboundMessageSchema.safeParse({ type: "pong" }).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse({ type: "not_a_message" }).success).toBe(
      false,
    );
  });

  it("validates optional assistant message phases in generated envelopes", () => {
    const envelope = (phase?: string) => ({
      type: "session",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-08-17T00:00:00.000Z",
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "assistant_message",
              text: "Done.",
              ...(phase === undefined ? {} : { phase }),
            },
          },
        },
      },
    });

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope()).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope("commentary")).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope("final_answer")).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope("analysis")).success).toBe(false);
  });

  it("validates steering user messages", () => {
    const userEnvelope = (steering: unknown) => ({
      type: "session",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-08-17T00:00:00.000Z",
          event: {
            type: "timeline",
            provider: "pi",
            item: {
              type: "user_message",
              text: "new context",
              steering,
            },
          },
        },
      },
    });

    expect(GeneratedWSOutboundMessageSchema.safeParse(userEnvelope(true)).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse(userEnvelope("yes")).success).toBe(false);
  });

  it("accepts project config responses with and without setup commit status", () => {
    const payload = {
      requestId: "project-config-read",
      repoRoot: "/repo",
      ok: true,
      config: null,
      revision: null,
    };
    const envelope = (
      responsePayload: typeof payload & {
        hasUncommittedWorktreeSetupChanges?: boolean;
      },
    ) => ({
      type: "session",
      message: {
        type: "read_project_config_response",
        payload: responsePayload,
      },
    });

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope(payload)).success).toBe(true);
    expect(
      GeneratedWSOutboundMessageSchema.safeParse(
        envelope({ ...payload, hasUncommittedWorktreeSetupChanges: true }),
      ).success,
    ).toBe(true);
  });

  it("accepts a compact provider snapshot envelope", () => {
    const envelope = {
      type: "session",
      message: {
        type: "get_providers_snapshot_response",
        payload: {
          entries: [],
          compactSnapshot: {
            entries: [
              {
                provider: "pi",
                status: "ready",
                enabled: true,
                models: [{ id: "model-a", label: "Model A", thinkingSet: 0 }],
              },
            ],
            thinkingSets: [
              {
                options: [{ id: "high", label: "High", isDefault: true }],
                defaultOptionId: "high",
              },
            ],
          },
          snapshotHash: "snapshot-hash",
          generatedAt: "2026-08-04T00:00:00.000Z",
          requestId: "provider-snapshot",
        },
      },
    };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it.each([
    {
      name: "dedicated attention message",
      message: {
        type: "agent_attention_required",
        payload: {
          agentId: "agent-1",
          reason: "finished",
          timestamp: "2026-07-22T18:00:00.000Z",
          shouldNotify: true,
          notification: {
            title: "Agent finished",
            body: "Done",
            data: {
              serverId: "server-1",
              workspaceId: "workspace-1",
              agentId: "agent-1",
              reason: "finished",
            },
          },
        },
      },
    },
    {
      name: "agent stream attention event",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-07-22T18:00:00.000Z",
          event: {
            type: "attention_required",
            provider: "codex",
            reason: "finished",
            timestamp: "2026-07-22T18:00:00.000Z",
            shouldNotify: true,
            notification: {
              title: "Agent finished",
              body: "Done",
              data: {
                serverId: "server-1",
                workspaceId: "workspace-1",
                agentId: "agent-1",
                reason: "finished",
              },
            },
          },
        },
      },
    },
  ])("preserves workspaceId in a $name", ({ message }) => {
    const envelope = { type: "session", message };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it.each([
    {
      name: "text",
      attachment: {
        type: "text",
        mimeType: "text/plain",
        title: "Browser element · span",
        text: '<browser-element url="https://example.com">span</browser-element>',
      },
    },
    {
      name: "text with chat history context",
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "Earlier conversation",
        text: "previous turns",
      },
    },
    {
      name: "github_pr",
      attachment: {
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 7,
        title: "Fix timeline",
        url: "https://github.com/acme/repo/pull/7",
      },
    },
    {
      name: "github_issue",
      attachment: {
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 8,
        title: "Timeline stalls",
        url: "https://github.com/acme/repo/issues/8",
      },
    },
    {
      name: "forge_change_request",
      attachment: {
        type: "forge_change_request",
        mimeType: "application/paseo-forge-change-request",
        forge: "gitlab",
        number: 9,
        title: "Fix timeline",
        url: "https://gitlab.com/acme/repo/-/merge_requests/9",
      },
    },
    {
      name: "forge_issue",
      attachment: {
        type: "forge_issue",
        mimeType: "application/paseo-forge-issue",
        forge: "gitlab",
        number: 10,
        title: "Timeline stalls",
        url: "https://gitlab.com/acme/repo/-/issues/10",
      },
    },
    {
      name: "review",
      attachment: {
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/repo",
        mode: "uncommitted",
        comments: [],
      },
    },
    {
      name: "uploaded_file",
      attachment: {
        type: "uploaded_file",
        id: "upload-1",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 12,
        path: "/uploads/notes.txt",
      },
    },
  ])("accepts a $name attachment in streamed and fetched timeline items", ({ attachment }) => {
    const item = { type: "user_message", text: "look at this", attachments: [attachment] };

    expect(
      GeneratedWSOutboundMessageSchema.safeParse({
        type: "session",
        message: {
          type: "agent_stream",
          payload: {
            agentId: "agent-1",
            timestamp: "2026-09-08T05:40:39.840Z",
            event: { type: "timeline", provider: "pi", item },
          },
        },
      }).success,
    ).toBe(true);

    expect(
      GeneratedWSOutboundMessageSchema.safeParse({
        type: "session",
        message: {
          type: "fetch_agent_timeline_response",
          payload: {
            requestId: "timeline-1",
            agentId: "agent-1",
            agent: null,
            direction: "before",
            projection: "projected",
            epoch: "epoch-1",
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
            startCursor: { epoch: "epoch-1", seq: 1 },
            endCursor: { epoch: "epoch-1", seq: 1 },
            hasOlder: false,
            hasNewer: true,
            entries: [
              {
                provider: "pi",
                item,
                timestamp: "2026-09-08T05:40:39.840Z",
                seqStart: 1,
                seqEnd: 1,
                sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
                collapsed: [],
              },
            ],
            error: null,
          },
        },
      }).success,
    ).toBe(true);
  });

  it("strips unknown text attachment context kinds while keeping chat history", () => {
    const parseAttachment = (contextKind: string) => {
      const result = GeneratedWSOutboundMessageSchema.safeParse({
        type: "session",
        message: {
          type: "agent_stream",
          payload: {
            agentId: "agent-1",
            timestamp: "2026-09-08T05:40:39.840Z",
            event: {
              type: "timeline",
              provider: "pi",
              item: {
                type: "user_message",
                text: "look at this",
                attachments: [{ type: "text", mimeType: "text/plain", contextKind, text: "body" }],
              },
            },
          },
        },
      });
      expect(result.success).toBe(true);
      const message = result.data as {
        message: {
          payload: { event: { item: { attachments: { contextKind?: string }[] } } };
        };
      };
      return message.message.payload.event.item.attachments[0];
    };

    expect(parseAttachment("chat_history")).toMatchObject({ contextKind: "chat_history" });
    expect(parseAttachment("workspace_file")).not.toHaveProperty("contextKind");
  });

  it("emits runtime imports with .js extensions", async () => {
    const generated = await readFile(generatedWSOutboundPath, "utf8");
    expect(generated).toContain('from "../../validation/ws-outbound-schema-metadata.js"');
  });

  it("accepts a forge.search.response envelope", () => {
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "forge.search.response",
        payload: {
          items: [
            {
              kind: "change_request",
              number: 17,
              title: "Fix search",
              url: "https://gitlab.com/acme/repo/-/merge_requests/17",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          authState: "authenticated",
          error: null,
          requestId: "search-forge",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a legacy github_search_response envelope", () => {
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "github_search_response",
        payload: {
          items: [
            {
              kind: "pr",
              number: 42,
              title: "Legacy PR",
              url: "https://github.com/acme/repo/pull/42",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          featuresEnabled: true,
          githubFeaturesEnabled: true,
          authState: "authenticated",
          error: null,
          requestId: "search-github",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
