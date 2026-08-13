import { describe, expect, it } from "vitest";
import {
  evaluateForkedSubagentEvidence,
  evaluateSubagentHandoffEvidence,
  summarizeSubagentHandoffFailure,
} from "./subagent-scenario-evidence.js";

const requesterSessionKey = "agent:qa:subagent-handoff:current";
const childSessionKey = "agent:qa:subagent:current";
const expectedChildLabel = "qa-sidecar";
const childFinalText = "The sidecar verified the workspace.";
const parentFinalText = [
  "Delegated task: bounded QA inspection",
  `Result: ${childFinalText}`,
  "Evidence: the delegated child completed and delivered its result",
].join("\n");

function validInputs() {
  return {
    requesterSessionKey,
    expectedChildLabel,
    sessionStore: {
      [childSessionKey]: { spawnedBy: requesterSessionKey, label: expectedChildLabel },
    },
    tasksPayload: {
      tasks: [
        {
          taskId: "task-current",
          requesterSessionKey,
          childSessionKey,
          label: expectedChildLabel,
          status: "succeeded",
          deliveryStatus: "delivered",
        },
      ],
    },
    childFinalText,
    parentFinalText,
  };
}

describe("subagent scenario evidence", () => {
  it("accepts one owned child, matching delivered task, and attributed child result", () => {
    expect(evaluateSubagentHandoffEvidence(validInputs())).toMatchObject({
      child: { sessionKey: childSessionKey, spawnedBy: requesterSessionKey },
      task: { taskId: "task-current", status: "succeeded", deliveryStatus: "delivered" },
      parentFinalText,
    });
  });

  it.each([
    [
      "wrong child owner",
      { sessionStore: { [childSessionKey]: { spawnedBy: "stale", label: expectedChildLabel } } },
    ],
    [
      "wrong child label",
      { sessionStore: { [childSessionKey]: { spawnedBy: requesterSessionKey, label: "stale" } } },
    ],
    [
      "duplicate children",
      {
        sessionStore: {
          [childSessionKey]: { spawnedBy: requesterSessionKey, label: expectedChildLabel },
          "agent:qa:subagent:duplicate": {
            spawnedBy: requesterSessionKey,
            label: expectedChildLabel,
          },
        },
      },
    ],
    [
      "wrong task owner",
      {
        tasksPayload: {
          tasks: [{ ...validInputs().tasksPayload.tasks[0], requesterSessionKey: "stale" }],
        },
      },
    ],
    [
      "failed task",
      { tasksPayload: { tasks: [{ ...validInputs().tasksPayload.tasks[0], status: "failed" }] } },
    ],
    [
      "undelivered task",
      {
        tasksPayload: {
          tasks: [{ ...validInputs().tasksPayload.tasks[0], deliveryStatus: "pending" }],
        },
      },
    ],
    ["empty child", { childFinalText: "<prompt-data></prompt-data>" }],
    ["accepted-only child", { childFinalText: '{"status":"accepted"}' }],
    [
      "fabricated result",
      { parentFinalText: "Delegated task: x\nResult: fabricated\nEvidence: child completed" },
    ],
    [
      "unattributed evidence",
      { parentFinalText: `Delegated task: x\nResult: ${childFinalText}\nEvidence: done` },
    ],
    ["duplicate section", { parentFinalText: `${parentFinalText}\nResult: duplicate` }],
  ])("rejects %s", (_name, overrides) => {
    expect(evaluateSubagentHandoffEvidence({ ...validInputs(), ...overrides })).toBeUndefined();
  });

  it("accepts only the owned fork child transcript containing the fork needle", () => {
    const params = {
      requesterSessionKey: "agent:qa:fork:current",
      expectedChildLabel: "qa-fork-context",
      contextNeedle: "FORKED-CONTEXT-ALPHA",
      sessionStore: {
        "agent:qa:fork-child": {
          spawnedBy: "agent:qa:fork:current",
          label: "qa-fork-context",
        },
      },
      childTranscripts: [{ sessionKey: "agent:qa:fork-child", finalText: "FORKED-CONTEXT-ALPHA" }],
    };

    expect(evaluateForkedSubagentEvidence(params)).toMatchObject({
      child: { sessionKey: "agent:qa:fork-child" },
    });
    expect(
      evaluateForkedSubagentEvidence({
        ...params,
        sessionStore: {
          "agent:qa:fork-child": { spawnedBy: "agent:qa:fork:stale", label: "qa-fork-context" },
        },
      }),
    ).toBeUndefined();
  });

  it("bounds failure diagnostics and never returns transcript text", () => {
    const privateText = "QA_PRIVATE_CHILD_RESULT_DO_NOT_LOG";
    const summary = summarizeSubagentHandoffFailure({
      ...validInputs(),
      childFinalText: privateText,
      parentFinalText: `Delegated task: x\nResult: wrong\nEvidence: ${privateText}`,
      mockRequests: Array.from({ length: 20 }, () => ({
        allInputText: `[Internal task completion event]\nsource: subagent\ntask: qa-sidecar\nstatus: completed; ready for parent review\nChild result:\n<prompt-data>${privateText}</prompt-data>`,
        hasReadableCompletedHandoffResult: true,
      })),
    });

    expect(summary.mockRequests).toHaveLength(12);
    expect(JSON.stringify(summary)).not.toContain(privateText);
    expect(summary).toMatchObject({
      ownedChildCount: 1,
      matchingTaskCount: 1,
      childHasFinalText: true,
      resultContainsChild: false,
    });
  });
});
