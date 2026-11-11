/**
 * project-move.mjs — what happens around moving a chat into a project (SHE-168).
 *
 * Two things besides the move itself (session-manager.moveSlot):
 *
 * 1. The "move in" prompt. A chat that grew in the home folder has files
 *    scattered around and knowledge that lives only in the conversation. The
 *    agent is the one who knows both, so it is asked to bring the files and
 *    write the project's first notes. The prompt gives the goal and trusts the
 *    agent with the details.
 *
 * 2. A record of the move, so the Reports tab can show the reports this chat
 *    wrote under its new project (api/services/report_catalog.py reads it).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HOME, SESSION_MOVES_FILE } from "./constants.mjs";

export function moveInPrompt({ project, createRepo }) {
  const folder = "~" + project.path.slice(HOME.length);
  const repoStep = createRepo
    ? `Put the project under git if it is not already. If it has no GitHub remote, create a PRIVATE GitHub repository for it with \`gh\` and push. Never make it public. Before the first commit, check that no secret and no large data file would be committed, and use .gitignore for them. If \`gh\` is not signed in, say so and skip this step.`
    : `Keep whatever git setup the folder already has. Do not create a remote repository.`;
  // A cockpit notice: the chat shows it as one folded line (the owner did not
  // type it), and it stays inspectable behind a click.
  return `<cockpit-notice>
This conversation has just been moved into the project "${project.name}" (${folder}). From now on you work in that folder, and everything we said so far came with you.

Please move in properly, so that this folder becomes the one home of this work:

1. Bring the work here. Find the files and folders you created or changed for this work that live outside ${folder} (for example under ~/tmp, ~/research or directly in the home folder) and move them into the project, in a sensible place. Leave alone anything that other work may depend on, and anything you are not sure belongs to this work: list it for me. Reports stay in ~/reports.

2. Make the project very well structured and very easy to navigate, for me and for the next agent that starts here with no memory of this conversation. It should contain everything about this work, the business side and the technical side. Write a README.md, and an AGENTS.md at the root (plus a one-line CLAUDE.md containing \`@AGENTS.md\`) with what a newcomer needs: the goal, who it is for and why it matters, the decisions made and why, how it is built, how to run and test it, what was tried and what came out, the current state, and the next steps. If these files already exist, update them, do not start over.

3. ${repoStep}

Use your own judgment for the details. When you are done, tell me in a few lines what you moved, what you wrote, and what you left for me to decide.
</cockpit-notice>`;
}

/** Append one move to the shared record (one JSON object per line). */
export function recordSessionMove({ sessionId, fromCwd, toCwd }) {
  mkdirSync(dirname(SESSION_MOVES_FILE), { recursive: true });
  appendFileSync(SESSION_MOVES_FILE, JSON.stringify({ session: sessionId, from: fromCwd, to: toCwd, ts: Date.now() }) + "\n");
}
