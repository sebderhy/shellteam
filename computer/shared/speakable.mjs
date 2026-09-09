/**
 * Markdown -> speech. Turns an agent's final reply into something worth
 * hearing, and is the reason the prompt header can promise "put the paths and
 * links in the text anyway": they survive on screen and never reach the ear.
 *
 * The split is deliberate. Writing FOR the ear is judgment, so it belongs to
 * the agent (the composer's audio toggle tells it). Stripping the syntax an
 * agent still emits out of habit is mechanical, so it belongs here, where it
 * always happens and cannot be forgotten.
 */

/** Past this, a "reply" has become a lecture. Trimmed at a sentence boundary. */
export const MAX_SPOKEN_CHARS = 2400;

// The trailing `$(?![\s\S])` is end-of-STRING, not end-of-line: with /m a bare
// `$` would close an unterminated fence at the first newline and read the rest
// of the code out loud.
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|$(?![\s\S]))/gm;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const TABLE_ROW = /^[ \t]*\|.*$/gm;
const HORIZONTAL_RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const INLINE_CODE = /`([^`\n]+)`/g;
const HEADING = /^[ \t]*#{1,6}[ \t]*(.*)$/gm;
const BULLET = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm;
const BLOCKQUOTE = /^[ \t]*>[ \t]?/gm;
const EMPHASIS = /(\*{1,3}|~~)(?=\S)([\s\S]*?\S)\1/g;
// A colon counts as closed punctuation: it usually introduced a code block or
// table that is no longer there, and "Run this:." reads as a stumble.
const SENTENCE_END = /[.!?:;]["')\]]?$/;

/** Inline code worth hearing is a word ("run `pytest`"); a path or a flag is not. */
function isUnspeakableCode(text) {
  return /[/\\]/.test(text) || /^-{1,2}\w/.test(text) || text.length > 40;
}

/** A list item or heading read without a full stop runs into the next one. */
function asSentence(line) {
  const trimmed = line.trim();
  if (!trimmed) return "";
  return SENTENCE_END.test(trimmed) ? trimmed : `${trimmed}.`;
}

function stripSyntax(markdown) {
  return markdown
    .replace(FENCED_CODE, "")
    .replace(HTML_COMMENT, "")
    .replace(TABLE_ROW, "")
    .replace(HORIZONTAL_RULE, "")
    .replace(IMAGE, "")
    .replace(LINK, "$1")
    .replace(BARE_URL, "")
    .replace(INLINE_CODE, (_, code) => (isUnspeakableCode(code) ? "" : code))
    .replace(HTML_TAG, "")
    .replace(HEADING, (_, text) => asSentence(text))
    .replace(BLOCKQUOTE, "")
    .replace(BULLET, "")
    .replace(EMPHASIS, "$2");
}

function tidyWhitespace(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .map(asSentence)
    .join(" ")
    .trim();
}

/** Cut at the last sentence end that fits; fall back to the last word. */
function trimToLimit(text, limit) {
  const head = text.slice(0, limit);
  const lastSentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (lastSentence > limit * 0.5) return head.slice(0, lastSentence + 1);
  const lastWord = head.lastIndexOf(" ");
  return lastWord > 0 ? head.slice(0, lastWord) : head;
}

/**
 * @returns {{ text: string, truncated: boolean }} `text` is '' when the reply
 * was nothing but code, tables or links — the caller must then skip synthesis
 * rather than spend quota on silence.
 */
export function speakable(markdown, { limit = MAX_SPOKEN_CHARS } = {}) {
  const prose = tidyWhitespace(stripSyntax(String(markdown || "")));
  if (prose.length <= limit) return { text: prose, truncated: false };
  return { text: trimToLimit(prose, limit), truncated: true };
}
