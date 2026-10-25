/**
 * CSF → a Markdown transcript an agent can read: what was asked, what was
 * answered, which tools ran with which inputs, and what they returned. Used to
 * hand one tab's whole conversation to another when tabs merge (SHE-128); any
 * family can read it, since it is plain text rather than a native session.
 */

import { capToolOutput } from "./csf.mjs";

function fence(text) {
  const body = String(text ?? "");
  const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${body}\n${ticks}`;
}

function toolInput(input) {
  if (input && typeof input.command === "string") return input.command;
  return JSON.stringify(input ?? {}, null, 2);
}

export function renderTranscript(csf) {
  const { session, events } = csf;
  const lines = [
    `# Conversation: ${session.title}`,
    "",
    `Agent: ${session.source.family} (${session.source.model}). Folder: ${session.cwd}.`,
  ];
  for (const ev of events) {
    if (ev.type === "message") {
      lines.push("", ev.role === "user" ? "## User" : "## Assistant");
      for (const part of ev.parts || []) {
        if (part.type === "text") lines.push("", part.text);
        else if (part.type === "tool_call") lines.push("", `Tool call \`${part.name}\` (${part.id}):`, fence(toolInput(part.input)));
      }
    } else if (ev.type === "tool_result") {
      lines.push("", `Tool result (${ev.callId})${ev.isError ? ", failed" : ""}:`, fence(capToolOutput(ev.output)));
    } else if (ev.type === "compaction") {
      lines.push("", "## (Context compacted here; the earlier part was summarized for the agent)", ev.summary ? `\n${ev.summary}` : "");
    }
  }
  return `${lines.join("\n")}\n`;
}
