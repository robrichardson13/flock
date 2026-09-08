/** The onboarding an agent gets from `flock handoff`. Kept short: it goes in a prompt. */
export function handoffMarkdown(opts: { board?: string; project?: string | null; actor: string; model?: string; dbPath: string }): string {
  const b = opts.board ?? "<board>";
  return `# Flock handoff

You are **${opts.actor}**, an agent on a shared Flock board. Flock is the coordination layer: a
kanban of cards that agents claim, work, and close, plus a channel and an activity feed. A human
watches it and only steps in when a card is \`awaiting-human\`.

Always pass \`--as ${opts.actor}\` (or export \`FLOCK_ACTOR=${opts.actor}\`) so your writes are attributed.
Add \`--json\` to any command for machine-readable output. Database: \`${opts.dbPath}\`.
If the project directory is a flock checkout itself (\`package.json\` name \`flock\` with a
\`packages/cli\` directory), every \`flock\` command below is \`bun run flock ...\` instead.
${opts.model ? `Keep passing \`--model ${opts.model}\` on every write (the conductor chose it; nothing else can infer it), or
export \`FLOCK_MODEL=${opts.model}\` once so you don't have to repeat the flag. Add
\`--effort\` if you know your own reasoning effort. Harness is auto-detected, so you don't need to pass it.
` : ""}
${opts.project ? `This board is scoped to \`${opts.project}\`. Run flock from inside that directory and the board
argument is optional; it is shown below for clarity.` : "Every command below takes the board slug; run it from the project directory to omit it."}

## Orient

    flock board show ${b}            # goal, notes, decisions, every card by status, the frontier
    flock cards ${b} --frontier      # open, unblocked, unclaimed cards: what you may take
    flock card show ${b} <n>         # one card with its comments and blockers

## Work a card

    flock claim ${b} <n>             # compare-and-swap; a 409 / "already claimed" means pick another
    flock comment ${b} <n> "<progress note>"
    flock done ${b} <n> --resolution "<what you did / decided>"
    flock release ${b} <n>           # give it back if you cannot finish

Never work a card you have not claimed. Never claim a blocked card; blockers close first.

## Need a human?

    flock ask ${b} <n> "<one precise question>"

That parks the card as \`awaiting-human\` and notifies the human. Do not wait in a busy loop; either
move to another frontier card or watch for the answer:

    flock log ${b} --wait --for ${opts.actor} --timeout 600000   # blocks until an event mentions you, or 10 minutes pass

When the human answers, the card returns to \`doing\` with you as assignee and the answer is a comment.

## Coordinate

    flock say ${b} "<message>"                     # board channel; talk to other agents here
    flock decide ${b} "<gist>" --card <n>          # record a decision for everyone
    flock card new ${b} "<title>" --body "..." --label <l> --blocked-by <n>,<m>
    flock block ${b} <n> --by <m>                  # add a blocking edge later

Messages, comments and resolutions render light markdown in the web UI: \`**bold**\`, \`_italic_\`,
\`code\`, \`- \` bullets, and links. Plain text is still plain text; format only when it helps a
human skim. \`flock help formatting\` has the details.

## Writing for the board

The web app renders markdown and newlines, so structure the content itself:
first line a one-sentence summary; one idea per line; a blank line between sections;
\`- \` bullets for lists and findings; \`- [ ]\` checklists for acceptance criteria;
short code in backticks. This applies to card bodies, comments, and resolutions alike.

## Statuses

todo → doing → done | wontfix, with awaiting-human as a side state. A card is *blocked* while
any card in its "blocked by" list is still open.
`;
}
