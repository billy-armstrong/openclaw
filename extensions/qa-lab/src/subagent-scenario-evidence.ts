// QA Lab subagent evidence ties scenario claims to one current parent/child/task chain.
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_DIAGNOSTIC_REQUESTS = 12;

type OwnedSubagentChild = {
  sessionKey: string;
  spawnedBy: string;
  label: string;
};

type SubagentTaskEvidence = {
  taskId?: string;
  requesterSessionKey: string;
  childSessionKey: string;
  label: string;
  status: string;
  deliveryStatus: string;
};

type HandoffSectionShape = {
  delegated: boolean;
  result: boolean;
  evidence: boolean;
  exactOrder: boolean;
  attributesChild: boolean;
};

type HandoffInputs = {
  requesterSessionKey: string;
  expectedChildLabel: string;
  sessionStore: unknown;
  tasksPayload: unknown;
  childFinalText?: unknown;
  parentFinalText?: unknown;
};

function readPromptData(value: string): string {
  return /<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/iu.exec(value)?.[1]?.trim() ?? value.trim();
}

function normalizeChildResult(value: unknown): string {
  const text = readPromptData(normalizeOptionalString(value) ?? "")
    .replace(/^child result(?:\s*\([^\r\n]*\))?\s*:\s*/iu, "")
    .replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/gmu, "")
    .replace(/^\s*```[^\r\n]*\r?\n|\r?\n\s*```\s*$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return normalizeLowercaseStringOrEmpty(text);
}

function isAcceptedOnlyResult(value: unknown): boolean {
  const text = readPromptData(normalizeOptionalString(value) ?? "");
  if (!text.startsWith("{")) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && parsed.status === "accepted";
  } catch {
    return false;
  }
}

function readOwnedChildren(
  sessionStore: unknown,
  requesterSessionKey: string,
  expectedChildLabel: string,
): OwnedSubagentChild[] {
  if (!isRecord(sessionStore)) {
    return [];
  }
  return Object.entries(sessionStore).flatMap(([sessionKey, entry]) => {
    if (!isRecord(entry)) {
      return [];
    }
    const spawnedBy = normalizeOptionalString(entry.spawnedBy) ?? "";
    const label = normalizeOptionalString(entry.label) ?? "";
    return spawnedBy === requesterSessionKey && label === expectedChildLabel
      ? [{ sessionKey, spawnedBy, label }]
      : [];
  });
}

function readTasks(tasksPayload: unknown): SubagentTaskEvidence[] {
  if (!isRecord(tasksPayload) || !Array.isArray(tasksPayload.tasks)) {
    return [];
  }
  return tasksPayload.tasks.flatMap((task) => {
    if (!isRecord(task)) {
      return [];
    }
    const requesterSessionKey = normalizeOptionalString(task.requesterSessionKey) ?? "";
    const childSessionKey = normalizeOptionalString(task.childSessionKey) ?? "";
    const label = normalizeOptionalString(task.label) ?? "";
    const status = normalizeOptionalString(task.status) ?? "";
    const deliveryStatus = normalizeOptionalString(task.deliveryStatus) ?? "";
    if (!requesterSessionKey || !childSessionKey || !label || !status || !deliveryStatus) {
      return [];
    }
    const taskId = normalizeOptionalString(task.taskId) ?? "";
    return [
      {
        ...(taskId ? { taskId } : {}),
        requesterSessionKey,
        childSessionKey,
        label,
        status,
        deliveryStatus,
      },
    ];
  });
}

function parseHandoffSections(value: unknown) {
  const text = normalizeOptionalString(value) ?? "";
  const matches = Array.from(
    text.matchAll(/(?:^|\n)\s*(delegated task|result|evidence)\s*:\s*/giu),
  );
  const counts = new Map<string, number>();
  for (const match of matches) {
    const name = normalizeLowercaseStringOrEmpty(match[1]);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const exactOrder =
    matches.length === 3 &&
    matches.map((match) => normalizeLowercaseStringOrEmpty(match[1])).join("|") ===
      "delegated task|result|evidence";
  const sections = new Map<string, string>();
  for (const [index, match] of matches.entries()) {
    const name = normalizeLowercaseStringOrEmpty(match[1]);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    sections.set(name, text.slice(start, end).trim());
  }
  const evidence = sections.get("evidence") ?? "";
  const shape: HandoffSectionShape = {
    delegated: counts.get("delegated task") === 1 && Boolean(sections.get("delegated task")),
    result: counts.get("result") === 1 && Boolean(sections.get("result")),
    evidence: counts.get("evidence") === 1 && Boolean(evidence),
    exactOrder,
    attributesChild: /\b(?:child|subagent|delegat(?:e|ed|ion))\b/iu.test(evidence),
  };
  return { sections, shape };
}

export function evaluateSubagentHandoffEvidence(params: HandoffInputs) {
  const children = readOwnedChildren(
    params.sessionStore,
    params.requesterSessionKey,
    params.expectedChildLabel,
  );
  const [child] = children;
  if (children.length !== 1 || !child) {
    return undefined;
  }
  const matchingTasks = readTasks(params.tasksPayload).filter(
    (task) =>
      task.requesterSessionKey === params.requesterSessionKey &&
      task.childSessionKey === child.sessionKey &&
      task.label === params.expectedChildLabel,
  );
  const [task] = matchingTasks;
  if (matchingTasks.length !== 1 || !task) {
    return undefined;
  }
  if (task.status !== "succeeded" || task.deliveryStatus !== "delivered") {
    return undefined;
  }
  const normalizedChildResult = normalizeChildResult(params.childFinalText);
  if (!normalizedChildResult || isAcceptedOnlyResult(params.childFinalText)) {
    return undefined;
  }
  const { sections, shape } = parseHandoffSections(params.parentFinalText);
  if (!shape.delegated || !shape.result || !shape.evidence || !shape.exactOrder) {
    return undefined;
  }
  if (
    !shape.attributesChild ||
    !normalizeChildResult(sections.get("result")).includes(normalizedChildResult)
  ) {
    return undefined;
  }
  return {
    child,
    task,
    parentFinalText: normalizeOptionalString(params.parentFinalText) ?? "",
  };
}

export function evaluateForkedSubagentEvidence(params: {
  requesterSessionKey: string;
  expectedChildLabel: string;
  contextNeedle: string;
  sessionStore: unknown;
  childTranscripts: unknown;
}) {
  const children = readOwnedChildren(
    params.sessionStore,
    params.requesterSessionKey,
    params.expectedChildLabel,
  );
  const [child] = children;
  if (children.length !== 1 || !child || !Array.isArray(params.childTranscripts)) {
    return undefined;
  }
  const transcript = params.childTranscripts.find(
    (candidate) => isRecord(candidate) && candidate.sessionKey === child.sessionKey,
  );
  const finalText = isRecord(transcript)
    ? (normalizeOptionalString(transcript.finalText) ?? "")
    : "";
  return finalText.includes(params.contextNeedle) ? { child } : undefined;
}

function summarizeMockRequest(request: unknown, expectedChildLabel: string) {
  if (!isRecord(request)) {
    return { validRecord: false };
  }
  const input = normalizeOptionalString(request.allInputText) ?? "";
  const eventStart = Math.max(
    input.lastIndexOf("[Internal task completion event]"),
    input.lastIndexOf(
      "A background task completed. Use this result to reply to the user in your normal assistant voice.",
    ),
  );
  const completion = eventStart < 0 ? "" : input.slice(eventStart);
  const parsed =
    /^Child result(?:\s*\([^\r\n]*\))?\s*:\s*\r?\n<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/imu.exec(
      completion,
    )?.[1];
  const completionTask = /^task:\s*([^\r\n]+)\s*$/imu.exec(completion)?.[1]?.trim();
  return {
    validRecord: true,
    plannedSpawn: request.plannedToolName === "sessions_spawn",
    plannedExpectedLabel: isRecord(request.plannedToolArgs)
      ? request.plannedToolArgs.label === expectedChildLabel
      : false,
    hasToolOutput: Boolean(request.toolOutput),
    hasCompletionMarker: eventStart >= 0,
    hasSourceSubagent: /^source:\s*subagent\s*$/imu.test(completion),
    hasExpectedTaskLabel: completionTask === expectedChildLabel,
    hasSuccessfulStatus:
      /^status:\s*(?:completed successfully|completed;\s*ready for parent review)\s*$/imu.test(
        completion,
      ),
    hasPromptData: /<prompt-data>[\s\S]*?<\/prompt-data>/iu.test(completion),
    hasNonemptyParsedChildResult: Boolean(parsed?.trim()),
    hasAcceptedParsedChildResult: isAcceptedOnlyResult(parsed),
    hasReadableCompletedHandoffResult: request.hasReadableCompletedHandoffResult === true,
    emittedAssistantHasDelegatedSection: request.emittedAssistantHasDelegatedSection === true,
    emittedAssistantHasResultSection: request.emittedAssistantHasResultSection === true,
    emittedAssistantHasEvidenceSection: request.emittedAssistantHasEvidenceSection === true,
    emittedAssistantContainsParsedChild: request.emittedAssistantContainsParsedChild === true,
    emittedAssistantIsFunctionCall: request.emittedAssistantIsFunctionCall === true,
  };
}

export function summarizeSubagentHandoffFailure(
  params: HandoffInputs & {
    mockRequests?: unknown;
  },
) {
  const ownedChildren = readOwnedChildren(
    params.sessionStore,
    params.requesterSessionKey,
    params.expectedChildLabel,
  );
  const child = ownedChildren.length === 1 ? ownedChildren[0] : undefined;
  const tasks = readTasks(params.tasksPayload);
  const matchingTasks = child
    ? tasks.filter(
        (task) =>
          task.requesterSessionKey === params.requesterSessionKey &&
          task.childSessionKey === child.sessionKey &&
          task.label === params.expectedChildLabel,
      )
    : [];
  const { sections, shape } = parseHandoffSections(params.parentFinalText);
  const normalizedChildResult = normalizeChildResult(params.childFinalText);
  return {
    ownedChildCount: ownedChildren.length,
    matchingTaskCount: matchingTasks.length,
    taskSucceeded: matchingTasks.length === 1 && matchingTasks[0]?.status === "succeeded",
    taskDelivered: matchingTasks.length === 1 && matchingTasks[0]?.deliveryStatus === "delivered",
    childHasFinalText: Boolean(normalizeOptionalString(params.childFinalText)),
    childHasUsableResult:
      Boolean(normalizedChildResult) && !isAcceptedOnlyResult(params.childFinalText),
    sections: shape,
    resultContainsChild:
      Boolean(normalizedChildResult) &&
      normalizeChildResult(sections.get("result")).includes(normalizedChildResult),
    mockRequests: Array.isArray(params.mockRequests)
      ? params.mockRequests
          .slice(-MAX_DIAGNOSTIC_REQUESTS)
          .map((request) => summarizeMockRequest(request, params.expectedChildLabel))
      : [],
  };
}

export function summarizeForkedSubagentFailure(params: {
  requesterSessionKey: string;
  expectedChildLabel: string;
  contextNeedle: string;
  sessionStore: unknown;
  childTranscripts: unknown;
}) {
  const ownedChildren = readOwnedChildren(
    params.sessionStore,
    params.requesterSessionKey,
    params.expectedChildLabel,
  );
  const transcriptCount = Array.isArray(params.childTranscripts)
    ? params.childTranscripts.length
    : 0;
  const transcriptContainsNeedle = Array.isArray(params.childTranscripts)
    ? params.childTranscripts.some(
        (candidate) =>
          isRecord(candidate) &&
          (normalizeOptionalString(candidate.finalText) ?? "").includes(params.contextNeedle),
      )
    : false;
  return { ownedChildCount: ownedChildren.length, transcriptCount, transcriptContainsNeedle };
}
