// QA Lab durable-evidence tests keep live subagent claims tied to current artifacts.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const scenarioIds = ["subagent-handoff", "subagent-forked-context"] as const;

async function runFabricatedSubagentReply(scenarioId: (typeof scenarioIds)[number]) {
  const state = createQaBusState();
  const text =
    scenarioId === "subagent-handoff"
      ? "Delegated task: bounded QA task\nResult: fabricated\nEvidence: delegated child completed"
      : "FORKED-CONTEXT-ALPHA";
  return await runLoadedScenarioFlow(scenarioId, {
    state,
    api: {
      env: { providerMode: "live-frontier", gateway: { runtimeEnv: {} } },
      runAgentPrompt: async () => {
        state.addOutboundMessage({ accountId: "qa-channel", to: "dm:qa-operator", text });
      },
      waitForAgentHistoryReply: async () => ({ text }),
      readRawQaSessionStore: async () => ({}),
      readSessionTranscriptSummary: async () => ({ finalText: text }),
      runQaCli: async () => ({ tasks: [] }),
      recentOutboundSummary: () => "one fabricated outbound reply",
      formatErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
      normalizeLowercaseStringOrEmpty,
    },
  });
}

async function runCausallyOwnedSubagentReply(scenarioId: (typeof scenarioIds)[number]) {
  const state = createQaBusState();
  const handoff = scenarioId === "subagent-handoff";
  const requesterSessionKey = handoff
    ? "agent:qa:subagent-handoff:00000000"
    : "agent:qa:forked-context:00000000";
  const childSessionKey = handoff ? "agent:qa:subagent:handoff" : "agent:qa:subagent:fork";
  const label = handoff ? "qa-sidecar" : "qa-fork-context";
  const childFinalText = handoff
    ? "The sidecar verified the bounded QA task."
    : "FORKED-CONTEXT-ALPHA";
  const parentFinalText = handoff
    ? [
        "Delegated task: bounded QA task",
        `Result: ${childFinalText}`,
        "Evidence: the delegated child completed and delivered its result",
      ].join("\n")
    : childFinalText;
  return await runLoadedScenarioFlow(scenarioId, {
    state,
    api: {
      env: { providerMode: "live-frontier", gateway: { runtimeEnv: {} } },
      runAgentPrompt: async () => {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: parentFinalText,
        });
      },
      waitForAgentHistoryReply: async () => ({ text: parentFinalText }),
      readRawQaSessionStore: async () => ({
        [childSessionKey]: { spawnedBy: requesterSessionKey, label },
      }),
      readSessionTranscriptSummary: async (_env: unknown, sessionKey: string) => ({
        finalText: sessionKey === childSessionKey ? childFinalText : parentFinalText,
      }),
      runQaCli: async () => ({
        tasks: handoff
          ? [
              {
                taskId: "task-current",
                requesterSessionKey,
                childSessionKey,
                label,
                status: "succeeded",
                deliveryStatus: "delivered",
              },
            ]
          : [],
      }),
      normalizeLowercaseStringOrEmpty,
    },
  });
}

describe("scenario flow durable evidence", () => {
  it.each(scenarioIds)("rejects a fabricated parent reply for %s", async (scenarioId) => {
    await expect(runFabricatedSubagentReply(scenarioId)).rejects.toThrow();
  });

  it.each(scenarioIds)("accepts current parent-owned evidence for %s", async (scenarioId) => {
    await expect(runCausallyOwnedSubagentReply(scenarioId)).resolves.toMatchObject({
      status: "pass",
    });
  });
});
