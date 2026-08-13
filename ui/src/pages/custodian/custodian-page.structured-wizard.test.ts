/* @vitest-environment jsdom */

import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

describe("custodian structured wizard", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps a rejected typed answer active as a plain user turn", async () => {
    const step = {
      id: "port",
      type: "text" as const,
      message: "Gateway port",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "validation-session",
        reply: "Enter a port.",
        action: "none",
        wizardInputPending: true,
        step,
      })
      .mockResolvedValueOnce({
        sessionId: "validation-session",
        reply: "Enter port 18789.",
        action: "none",
        wizardInputPending: true,
        step,
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "banana";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    await waitForFast(() => expect(page.textContent).toContain("Enter port 18789."));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      wizardAnswer: { stepId: "port", value: "banana" },
    });
    expect(page.querySelector(".custodian__structured-response")).toBeNull();
    expect(page.querySelector(".custodian__wizard-step")).not.toBeNull();
    expect(page.querySelector(".chat-group.user")?.textContent).toContain("banana");
    const groups = [...page.querySelectorAll(".chat-group")];
    const rejectedTurnIndex = groups.findIndex(
      (group) => group.classList.contains("user") && group.textContent?.includes("banana"),
    );
    const guidanceIndex = groups.findIndex(
      (group) =>
        group.classList.contains("assistant") && group.textContent?.includes("Enter port 18789."),
    );
    expect(rejectedTurnIndex).toBeGreaterThanOrEqual(0);
    expect(guidanceIndex).toBeGreaterThanOrEqual(0);
    expect(rejectedTurnIndex).toBeLessThan(guidanceIndex);
  });

  it("keeps an ambiguously delivered sensitive answer masked as a plain user turn", async () => {
    const step = {
      id: "port",
      type: "text" as const,
      message: "Gateway port",
      sensitive: true,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "uncertain-session",
        reply: "Enter a port.",
        action: "none",
        sensitive: true,
        wizardInputPending: true,
        step,
      })
      .mockImplementationOnce(
        async (_method: string, _params: unknown, options: { onSent?: () => void }) => {
          options.onSent?.();
          throw new Error("connection closed after send");
        },
      );
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"][type="password"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "banana";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    await waitForFast(() =>
      expect(page.querySelector(".chat-group.user")?.textContent).toContain("Sensitive reply sent"),
    );
    expect(page.querySelector(".custodian__structured-response")).toBeNull();
    expect(page.querySelector(".custodian__wizard-step")).not.toBeNull();
    expect(page.innerHTML).not.toContain("banana");
  });

  it("keeps an in-flight answer after same-scope recovery replaces the transcript", async () => {
    const actionReply = createDeferred<{
      sessionId: string;
      reply: string;
      action: "none";
      wizardAction: { kind: "answer"; prompt: string };
    }>();
    const step = {
      id: "port",
      type: "text" as const,
      message: "Gateway port",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ turns: [] })
      .mockResolvedValueOnce({
        sessionId: "rotation-session",
        reply: "Enter a port.",
        action: "none",
        wizardInputPending: true,
        step,
      })
      .mockReturnValueOnce(actionReply.promise);
    const harness = createContext(request, ["openclaw.chat", "openclaw.chat.history"], {
      gatewayCapabilities: [
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL,
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_CHAT_HISTORY_SESSION_RECOVERY,
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_ACTION_RECEIPTS,
      ],
      recoveryScope: "principal-a",
    });
    const { page } = await mountPage(harness.context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "18789";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();
    await waitForFast(() => expect(page.textContent).toContain("Submitting answer"));

    const replacementRequest = vi.fn().mockResolvedValue({
      turns: [{ role: "assistant", text: "Enter a port.", at: 1 }],
      activeWizard: { sessionId: "rotation-session", step },
    });
    harness.setGatewaySnapshot({
      client: {
        request: replacementRequest,
        recoveryScope: "principal-a",
        recoveryScopeReady: true,
      } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(replacementRequest).toHaveBeenCalledOnce());
    expect(replacementRequest.mock.calls[0]?.[1]).toMatchObject({
      sessionId: "rotation-session",
    });
    actionReply.resolve({
      sessionId: "rotation-session",
      reply: "Accepted by the retired client.",
      action: "none",
      wizardAction: { kind: "answer", prompt: "Gateway port" },
    });

    await waitForFast(() =>
      expect(page.querySelector(".chat-group.user")?.textContent).toContain("18789"),
    );
    expect(page.textContent).not.toContain("Answer submitted");
    expect(page.querySelector(".custodian__structured-response")).toBeNull();
    expect(page.querySelector(".custodian__wizard-step")).not.toBeNull();
  });

  it("keeps older-Gateway wizard answers as plain user turns", async () => {
    const step = {
      id: "port",
      type: "text" as const,
      message: "Gateway port",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "legacy-validation-session",
        reply: "Enter a port.",
        action: "none",
        wizardInputPending: true,
        step,
      })
      .mockResolvedValueOnce({
        sessionId: "legacy-validation-session",
        reply: "Enter port 18789.",
        action: "none",
        wizardInputPending: true,
        step,
      });
    const { context } = createContext(request, ["openclaw.chat"], {
      gatewayCapabilities: [GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL],
    });
    const { page } = await mountPage(context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "banana";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    await waitForFast(() => expect(page.textContent).toContain("Enter port 18789."));
    expect(page.querySelector(".custodian__structured-response")).toBeNull();
    expect(page.querySelector(".chat-group.user")?.textContent).toContain("banana");
    expect(page.querySelector(".custodian__wizard-step")).not.toBeNull();
  });

  it("keeps server-authored guidance visible beside typed controls", async () => {
    const manifest = JSON.stringify(
      {
        display_information: {
          name: "OpenClaw",
          description: "OpenClaw connector for OpenClaw",
        },
      },
      null,
      2,
    );
    const question = "How do you want to provide this Slack bot token?";
    const request = vi.fn().mockResolvedValue({
      sessionId: "slack-wizard-session",
      reply: [
        [
          "**Slack socket mode tokens**",
          "1) Create the Slack app from the manifest below",
          "2) Enable Socket Mode",
        ].join("\n"),
        manifest,
        [
          question,
          "1. Enter Slack bot token — Stores the credential directly in OpenClaw config",
          "2. Use external secret provider — Stores a reference to an external provider",
          "Reply with a number.",
          "Say `cancel` to stop this setup.",
        ].join("\n"),
      ].join("\n\n"),
      action: "none",
      wizardInputPending: true,
      step: {
        id: "slack-token-source",
        type: "select",
        message: question,
        options: [
          {
            label: "Enter Slack bot token",
            value: "direct",
            hint: "Stores the credential directly in OpenClaw config",
          },
          {
            label: "Use external secret provider",
            value: "secret-ref",
            hint: "Stores a reference to an external provider",
          },
        ],
      },
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    await waitForFast(() => expect(page.querySelector(".custodian__wizard-step")).not.toBeNull());
    expect(page.querySelector(".chat-group.assistant")?.textContent).toContain(
      "Slack socket mode tokens",
    );
    expect(page.querySelector(".custodian__wizard-guidance")).toBeNull();
    expect(page.querySelectorAll('.custodian__wizard-step input[type="radio"]')).toHaveLength(2);
    expect(page.textContent).toContain("Reply with a number");
    expect(page.textContent).toContain("Say cancel");
  });
});
