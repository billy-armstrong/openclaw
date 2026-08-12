import { html, nothing, type TemplateResult } from "lit";
import { icons, type IconName } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  SLASH_COMMANDS,
  findInlineSlashCompletion,
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { exportChatMarkdown } from "../export.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { findDirectInlineSlashArgumentInvocation } from "./chat-composer-inline-slash.ts";
import { commitComposerDraft, getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function resetSlashMenuState(state: ChatComposerState): void {
  state.slashMenuMode = "command";
  state.slashMenuCommand = null;
  state.slashMenuArgItems = [];
  state.slashMenuItems = [];
  state.slashMenuCompletion = null;
}

function hasVisibleSlashMenuState(state: ChatComposerState): boolean {
  return (
    state.slashMenuOpen ||
    state.slashMenuMode !== "command" ||
    state.slashMenuCommand !== null ||
    state.slashMenuArgItems.length > 0 ||
    state.slashMenuItems.length > 0
  );
}

function closeSlashMenuIfNeeded(state: ChatComposerState, requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState(state)) {
    return;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  if (!props.onSlashIntent || state.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  state.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    state.slashCommandRefreshPending = false;
    const nextValue = getCurrentValue?.() ?? props.getDraft?.() ?? value;
    if (state.slashMenuMode === "freeform-args" && state.slashMenuCompletion?.inline) {
      updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
      return;
    }
    if (state.slashMenuMode === "args" && state.slashMenuCompletion?.inline) {
      return;
    }
    const caret = state.composerTextarea?.selectionStart ?? nextValue.length;
    if (!findInlineSlashCompletion(nextValue, caret)) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
  });
}

export function updateSlashMenu(
  value: string,
  requestUpdate: () => void,
  props: ChatComposerProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  if (
    state.slashMenuMode === "freeform-args" &&
    state.slashMenuCompletion?.inline &&
    state.slashMenuCommand
  ) {
    const caret = state.composerTextarea?.selectionStart ?? value.length;
    const prefix = `/${state.slashMenuCommand.name} `;
    const start = state.slashMenuCompletion.start;
    if (caret >= start + prefix.length && value.slice(start, start + prefix.length) === prefix) {
      state.slashMenuCompletion.end = caret;
      requestUpdate();
      return;
    }
    resetSlashMenuState(state);
  }
  const argMatch = value.match(/^\/(\S+)\s(.*)$/);
  if (argMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const cmdName = argMatch[1]?.toLowerCase();
    const argFilter = argMatch[2]?.toLowerCase();
    if (cmdName === undefined || argFilter === undefined) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    const cmd = SLASH_COMMANDS.find((entry) => entry.name === cmdName);
    if (cmd?.argOptions?.length) {
      const filtered = argFilter
        ? cmd.argOptions.filter((arg) => arg.toLowerCase().startsWith(argFilter))
        : cmd.argOptions;
      if (filtered.length > 0) {
        state.slashMenuMode = "args";
        state.slashMenuCommand = cmd;
        state.slashMenuArgItems = filtered;
        state.slashMenuOpen = true;
        state.slashMenuIndex = 0;
        state.slashMenuItems = [];
        requestUpdate();
        return;
      }
    }
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }

  const caret = state.composerTextarea?.selectionStart ?? value.length;
  const completion = findInlineSlashCompletion(value, caret);
  if (completion) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const items = getSlashCommandCompletions(completion.query, {
      showAll: true,
      inlineOnly: completion.inline,
    });
    state.slashMenuCompletion = completion;
    state.slashMenuItems = items;
    state.slashMenuOpen = items.length > 0;
    state.slashMenuIndex = 0;
    state.slashMenuMode = "command";
    state.slashMenuCommand = null;
    state.slashMenuArgItems = [];
  } else {
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }
  requestUpdate();
}

function commitInlineSlashSelection(
  replacement: string,
  props: ChatComposerProps,
  state: ChatComposerState,
): boolean {
  const completion = state.slashMenuCompletion;
  if (!completion?.inline) {
    return false;
  }
  const target = state.composerTextarea;
  const current = target?.value ?? props.getDraft?.() ?? props.draft;
  const after = current.slice(completion.end);
  const separator = after.length === 0 || !/^\s/u.test(after) ? " " : "";
  const next = `${current.slice(0, completion.start)}${replacement}${separator}${after}`;
  const caret = completion.start + replacement.length + separator.length;
  if (target) {
    target.value = next;
    adjustTextareaHeight(target);
  }
  commitComposerDraft(props, next);
  queueMicrotask(() => {
    const textarea = state.composerTextarea;
    if (!textarea) {
      return;
    }
    textarea.focus({ preventScroll: true });
    textarea.selectionStart = caret;
    textarea.selectionEnd = caret;
  });
  return true;
}

function beginInlineFreeformSlashArguments(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  state: ChatComposerState,
): boolean {
  const completion = state.slashMenuCompletion;
  if (!completion?.inline) {
    return false;
  }
  const target = state.composerTextarea;
  const current = target?.value ?? props.getDraft?.() ?? props.draft;
  const replacement = `/${cmd.name} `;
  const next = `${current.slice(0, completion.start)}${replacement}${current.slice(completion.end)}`;
  const caret = completion.start + replacement.length;
  if (target) {
    target.value = next;
    adjustTextareaHeight(target);
  }
  commitComposerDraft(props, next);
  state.slashMenuCompletion = {
    query: cmd.name,
    start: completion.start,
    end: caret,
    inline: true,
  };
  queueMicrotask(() => {
    const textarea = state.composerTextarea;
    if (!textarea) {
      return;
    }
    textarea.focus({ preventScroll: true });
    textarea.selectionStart = caret;
    textarea.selectionEnd = caret;
  });
  return true;
}

function beginInlineSlashArguments(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  state: ChatComposerState,
  requestUpdate: () => void,
): boolean {
  if (
    !state.slashMenuCompletion?.inline ||
    cmd.source === "skill" ||
    !cmd.args ||
    !props.onSlashCommand
  ) {
    return false;
  }
  state.slashMenuCommand = cmd;
  state.slashMenuIndex = 0;
  state.slashMenuItems = [];
  if (cmd.argOptions?.length) {
    state.slashMenuMode = "args";
    state.slashMenuArgItems = cmd.argOptions;
    state.slashMenuOpen = true;
    requestUpdate();
    return true;
  }
  if (!beginInlineFreeformSlashArguments(cmd, props, state)) {
    return false;
  }
  state.slashMenuMode = "freeform-args";
  state.slashMenuArgItems = [];
  state.slashMenuOpen = false;
  requestUpdate();
  return true;
}

function removeInlineSlashSelection(props: ChatComposerProps, state: ChatComposerState): boolean {
  const completion = state.slashMenuCompletion;
  if (!completion?.inline) {
    return false;
  }
  const target = state.composerTextarea;
  const current = target?.value ?? props.getDraft?.() ?? props.draft;
  const before = current.slice(0, completion.start);
  let after = current.slice(completion.end);
  if (/\s$/u.test(before) && /^\s/u.test(after)) {
    after = after.slice(1);
  } else if (before.length === 0 && /^\s/u.test(after)) {
    after = after.slice(1);
  }
  const next = `${before}${after}`;
  const caret = before.length;
  if (target) {
    target.value = next;
    adjustTextareaHeight(target);
  }
  commitComposerDraft(props, next);
  queueMicrotask(() => {
    const textarea = state.composerTextarea;
    if (!textarea) {
      return;
    }
    textarea.focus({ preventScroll: true });
    textarea.selectionStart = caret;
    textarea.selectionEnd = caret;
  });
  return true;
}

export function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  if (beginInlineSlashArguments(cmd, props, state, requestUpdate)) {
    return;
  }
  if (
    state.slashMenuCompletion?.inline &&
    cmd.source !== "skill" &&
    props.onSlashCommand &&
    removeInlineSlashSelection(props, state)
  ) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    requestUpdate();
    props.onSlashCommand(`/${cmd.name}`);
    return;
  }
  if (commitInlineSlashSelection(`/${cmd.name}`, props, state)) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    requestUpdate();
    return;
  }
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = cmd.argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }

  if (cmd.executeLocal && !cmd.args) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    commitComposerDraft(props, `/${cmd.name}`);
    props.onSend();
  } else {
    commitComposerDraft(props, `/${cmd.name} `);
    closeSlashMenuIfNeeded(state, requestUpdate);
  }
}

export function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  if (beginInlineSlashArguments(cmd, props, state, requestUpdate)) {
    return;
  }
  if (commitInlineSlashSelection(`/${cmd.name}`, props, state)) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    requestUpdate();
    return;
  }
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = cmd.argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }
  commitComposerDraft(props, cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

export function selectSlashArg(
  arg: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  run: boolean,
) {
  const state = getChatComposerState(props.paneId);
  const command = state.slashMenuCommand;
  const cmdName = command?.name ?? "";
  if (
    run &&
    state.slashMenuCompletion?.inline &&
    command?.source !== "skill" &&
    props.onSlashCommand &&
    removeInlineSlashSelection(props, state)
  ) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    requestUpdate();
    props.onSlashCommand(`/${cmdName} ${arg}`);
    return;
  }
  if (
    !run &&
    state.slashMenuCompletion?.inline &&
    commitInlineSlashSelection(`/${cmdName} ${arg}`, props, state)
  ) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    requestUpdate();
    return;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  commitComposerDraft(props, `/${cmdName} ${arg}`);
  if (run) {
    props.onSend();
  }
  requestUpdate();
}

function submitInlineSlashArgument(props: ChatComposerProps, requestUpdate: () => void): boolean {
  const state = getChatComposerState(props.paneId);
  const command = state.slashMenuCommand;
  const completion = state.slashMenuCompletion;
  if (
    state.slashMenuMode !== "freeform-args" ||
    !completion?.inline ||
    !command ||
    !props.onSlashCommand
  ) {
    return false;
  }
  const target = state.composerTextarea;
  const current = target?.value ?? props.getDraft?.() ?? props.draft;
  const prefixEnd = completion.start + `/${command.name} `.length;
  const args = current.slice(prefixEnd, completion.end).trim();
  if (!removeInlineSlashSelection(props, state)) {
    return false;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
  props.onSlashCommand(`/${command.name}${args ? ` ${args}` : ""}`);
  return true;
}

function beginDirectInlineSlashArgument(
  props: ChatComposerProps,
  state: ChatComposerState,
): boolean {
  if (!props.onSlashCommand) {
    return false;
  }
  const target = state.composerTextarea;
  const current = target?.value ?? props.getDraft?.() ?? props.draft;
  const caret = target?.selectionStart ?? current.length;
  const invocation = findDirectInlineSlashArgumentInvocation(current, caret);
  if (!invocation) {
    return false;
  }
  state.slashMenuMode = "freeform-args";
  state.slashMenuCommand = invocation.command;
  state.slashMenuCompletion = invocation.completion;
  return true;
}

export function handleInlineSlashArgumentKeyDown(
  event: KeyboardEvent,
  props: ChatComposerProps,
  requestUpdate: () => void,
): boolean {
  const state = getChatComposerState(props.paneId);
  if (event.key === "Escape") {
    if (state.slashMenuMode !== "freeform-args" || !state.slashMenuCompletion?.inline) {
      return false;
    }
    event.preventDefault();
    resetSlashMenuState(state);
    requestUpdate();
    return true;
  }
  if (event.key !== "Enter") {
    return false;
  }
  if (
    (state.slashMenuMode !== "freeform-args" || !state.slashMenuCompletion?.inline) &&
    !beginDirectInlineSlashArgument(props, state)
  ) {
    return false;
  }
  event.preventDefault();
  return submitInlineSlashArgument(props, requestUpdate);
}

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

export function paneDomId(paneId: string, suffix: string): string {
  return `chat-${encodeURIComponent(paneId)}-${suffix}`;
}

function getSlashCommandOptionId(paneId: string, cmd: SlashCommandDef): string {
  return paneDomId(paneId, `slash-option-command-${slashOptionIdSegment(cmd.name)}`);
}

function getSlashArgOptionId(paneId: string, commandName: string, arg: string): string {
  return paneDomId(
    paneId,
    `slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`,
  );
}

export function isSlashMenuVisible(state: ChatComposerState): boolean {
  if (!state.slashMenuOpen) {
    return false;
  }
  if (state.slashMenuMode === "args") {
    return Boolean(state.slashMenuCommand && state.slashMenuArgItems.length > 0);
  }
  return state.slashMenuItems.length > 0;
}

export function getActiveSlashMenuOptionId(
  state: ChatComposerState,
  paneId: string,
): string | null {
  if (!isSlashMenuVisible(state)) {
    return null;
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? getSlashArgOptionId(paneId, commandName, arg) : null;
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(paneId, cmd) : null;
}

export function getActiveSlashMenuOptionLabel(state: ChatComposerState): string {
  if (!isSlashMenuVisible(state)) {
    return "";
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? `/${commandName} ${arg}` : "";
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${getSlashCommandDescription(cmd)}`;
}

export function scrollActiveSlashMenuOptionIntoView(
  state: ChatComposerState,
  paneId: string,
): void {
  const activeId = getActiveSlashMenuOptionId(state, paneId);
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const scrollRegion = activeOption?.closest<HTMLElement>(".slash-menu__scroll");
    if (!activeOption || !scrollRegion) {
      return;
    }
    const menuBounds = scrollRegion.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page. Keep
    // keyboard navigation owned by the menu so textarea focus stays stable.
    if (optionBounds.top < menuBounds.top) {
      scrollRegion.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      scrollRegion.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

function renderSlashIcon(name: string) {
  return icons[name as IconName] ?? icons.terminal;
}

export function exportMarkdown(props: Pick<ChatComposerProps, "messages" | "assistantName">): void {
  exportChatMarkdown(props.messages, props.assistantName);
}

export function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatComposerProps,
  draft: string,
): TemplateResult | typeof nothing {
  const state = getChatComposerState(props.paneId);
  const listboxId = paneDomId(props.paneId, "slash-menu-listbox");
  if (!state.slashMenuOpen) {
    return nothing;
  }

  if (
    state.slashMenuMode === "args" &&
    state.slashMenuCommand &&
    state.slashMenuArgItems.length > 0
  ) {
    return html`
      <div
        id=${listboxId}
        class="slash-menu"
        role="listbox"
        aria-label=${t("chat.commands.arguments")}
      >
        <div class="slash-menu__scroll">
          <div class="slash-menu-group">
            <div class="slash-menu-group__label">
              /${state.slashMenuCommand.name} ${getSlashCommandDescription(state.slashMenuCommand)}
            </div>
            ${state.slashMenuArgItems.map(
              (arg, i) => html`
                <div
                  id=${getSlashArgOptionId(props.paneId, state.slashMenuCommand?.name ?? "", arg)}
                  class="slash-menu-item ${i === state.slashMenuIndex
                    ? "slash-menu-item--active"
                    : ""}"
                  role="option"
                  aria-selected=${i === state.slashMenuIndex}
                  @click=${() => selectSlashArg(arg, props, requestUpdate, true)}
                  @mouseenter=${() => {
                    state.slashMenuIndex = i;
                    requestUpdate();
                  }}
                >
                  <span class="slash-menu-leading">
                    <span class="slash-menu-icon"
                      >${state.slashMenuCommand?.icon
                        ? renderSlashIcon(state.slashMenuCommand.icon)
                        : nothing}</span
                    >
                    <span class="slash-menu-name">${arg}</span>
                  </span>
                  <span class="slash-menu-trailing">
                    <span class="slash-menu-desc">/${state.slashMenuCommand?.name} ${arg}</span>
                  </span>
                </div>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  if (state.slashMenuItems.length === 0) {
    return nothing;
  }

  const groups: Array<[SlashCommandCategory, Array<{ cmd: SlashCommandDef; globalIdx: number }>]> =
    [];
  for (const [globalIdx, cmd] of state.slashMenuItems.entries()) {
    const category = cmd.category ?? "session";
    const group =
      draft === "/" ? groups.find(([groupCategory]) => groupCategory === category) : groups.at(-1);
    if (group?.[0] === category) {
      group[1].push({ cmd, globalIdx });
    } else {
      groups.push([category, [{ cmd, globalIdx }]]);
    }
  }

  const sections = groups.map(
    ([category, entries]) => html`
      <div class="slash-menu-group">
        <div class="slash-menu-group__label">${getSlashCommandCategoryLabel(category)}</div>
        ${entries.map(
          ({ cmd, globalIdx }) => html`
            <div
              id=${getSlashCommandOptionId(props.paneId, cmd)}
              class="slash-menu-item ${globalIdx === state.slashMenuIndex
                ? "slash-menu-item--active"
                : ""}"
              role="option"
              aria-selected=${globalIdx === state.slashMenuIndex}
              @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
              @mouseenter=${() => {
                state.slashMenuIndex = globalIdx;
                requestUpdate();
              }}
            >
              <span class="slash-menu-leading">
                <span class="slash-menu-icon"
                  >${cmd.icon ? renderSlashIcon(cmd.icon) : nothing}</span
                >
                <span class="slash-menu-name">/${cmd.name}</span>
                ${cmd.args ? html`<span class="slash-menu-args">${cmd.args}</span>` : nothing}
              </span>
              <span class="slash-menu-trailing">
                <span class="slash-menu-desc">${getSlashCommandDescription(cmd)}</span>
                ${cmd.argOptions?.length
                  ? html`<span class="slash-menu-badge"
                      >${t("chat.commands.optionCount", {
                        count: String(cmd.argOptions.length),
                      })}</span
                    >`
                  : nothing}
              </span>
            </div>
          `,
        )}
      </div>
    `,
  );

  return html`
    <div id=${listboxId} class="slash-menu" role="listbox" aria-label=${t("chat.commands.menu")}>
      <div class="slash-menu__scroll">${sections}</div>
    </div>
  `;
}
