import {
  getSlashCommandCompletions,
  type InlineSlashCompletion,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";

export type InlineSlashArgumentInvocation = {
  command: SlashCommandDef;
  completion: InlineSlashCompletion;
};

export function findDirectInlineSlashArgumentInvocation(
  text: string,
  caret = text.length,
): InlineSlashArgumentInvocation | null {
  const boundedCaret = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, boundedCaret);
  const commandPattern = /(?:^|\s)\/([^\s/:]+)\s+/gu;
  let invocation: InlineSlashArgumentInvocation | null = null;

  for (const match of prefix.matchAll(commandPattern)) {
    const typedName = match[1]?.toLowerCase();
    if (!typedName || match.index === undefined) {
      continue;
    }
    const command = getSlashCommandCompletions(typedName, {
      showAll: true,
      inlineOnly: true,
    }).find(
      (entry) =>
        entry.name.toLowerCase() === typedName ||
        entry.aliases?.some((alias) => alias.replace(/^\//u, "").toLowerCase() === typedName),
    );
    if (!command?.args || command.source === "skill") {
      continue;
    }
    const start = match.index + match[0].indexOf("/");
    const args = prefix.slice(match.index + match[0].length).trim();
    if (!args) {
      continue;
    }
    invocation = {
      command,
      completion: {
        query: command.name,
        start,
        end: boundedCaret,
        inline:
          text.slice(0, start).trim().length > 0 || text.slice(boundedCaret).trim().length > 0,
      },
    };
  }

  return invocation?.completion.inline ? invocation : null;
}
