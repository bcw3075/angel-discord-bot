/* The /angel slash command and its subcommands. Registered for the server Angel is in (it shows up at once). */
import { SlashCommandBuilder } from "discord.js";

export const SUBCOMMANDS = ["join", "leave", "ask", "stop", "optout", "iam", "status", "rejoin"];

export function angelCommand() {
  return new SlashCommandBuilder()
    .setName("angel")
    .setDescription("Angel, the table's rules helper")
    .addSubcommand(s => s.setName("join").setDescription("Join your voice channel and start listening (answers go in this channel)"))
    .addSubcommand(s => s.setName("leave").setDescription("Stop listening and leave the voice channel"))
    .addSubcommand(s => s.setName("ask").setDescription("Ask a rules question by typing")
      .addStringOption(o => o.setName("question").setDescription("Your question").setRequired(true).setMaxLength(500)))
    .addSubcommand(s => s.setName("stop").setDescription("Stop Angel talking"))
    .addSubcommand(s => s.setName("optout").setDescription("Stop transcribing my voice (use again to start again)"))
    .addSubcommand(s => s.setName("iam").setDescription("Tell Angel your character's name, so the transcript uses it")
      .addStringOption(o => o.setName("name").setDescription("Your character's name").setRequired(true).setMaxLength(40)))
    .addSubcommand(s => s.setName("status").setDescription("What Angel is doing, and what this session has cost so far"))
    .addSubcommand(s => s.setName("rejoin").setDescription("Test: Angel leaves and rejoins the voice channel (only whoever started this session)"))
    .toJSON();
}

/* "Angel, …" (her name, then a comma, colon or question mark) or "hey Angel …" at the start of a typed message:
   the rest is the question. Plain "Angel wings sprout from her back" is table chat, not a question. */
export function typedQuestion(content, botId) {
  let text = String(content ?? "");
  const mentioned = botId ? new RegExp(`<@!?${botId}>`).test(text) : false;
  if (botId) text = text.replace(new RegExp(`<@!?${botId}>`, "g"), " ").trim();
  const prefix = /^\W*(?:(?:hey|hi|ok(?:ay)?|so)[\s,]+angel(?![a-z'])[\s,:;!?.-]*|angel(?![a-z'])\s*[,:;!?]+\s*)/i;
  const named = prefix.test(text);
  if (named) text = text.replace(prefix, "");
  text = text.trim();
  return { asked: (mentioned || named) && text.length > 0, mentioned, named, question: text };
}
