/** The onboarding an agent gets from `flock handoff`. Kept short: it goes in a prompt. */
export function handoffMarkdown(opts: { board?: string; project?: string | null; actor: string; model?: string; dbPath: string; defaulted?: boolean }): string {
  const b = opts.board ?? "<board>";
  const identityIntro = opts.defaulted
    ? `No \`--as\` or \`FLOCK_ACTOR\` was passed, so this ran as **${opts.actor}**, the OS user — a
human, by default, not an agent.`
    : `You are **${opts.actor}**, an agent on a shared Flock board.`;
  const identityInstruction = opts.defaulted
    ? `Pick a name for yourself and pass \`--as <name>\` (or export \`FLOCK_ACTOR=<name>\`) on every
command below, or your writes keep landing under **${opts.actor}**.`
    : `Always pass \`--as ${opts.actor}\` (or export \`FLOCK_ACTOR=${opts.actor}\`) so your writes are attributed.`;
  return `# Flock handoff

## Just filing a card?

If a human asked you to add or file a ticket and nothing else, this is the whole job:

    flock card new [BOARD] "<title>" --body "<markdown>" --as <your-name>

No \`claim\`/\`done\` cycle needed for a one-off filing. Not sure which board? \`flock boards --here\`
confirms the one resolved from this directory. Always pass \`--as\` (or \`FLOCK_ACTOR\`); omit it and
the card files under the OS user as a human, not you.

${identityIntro} Flock is the coordination layer: a
kanban of cards that agents claim, work, and close, plus a channel and an activity feed. A human
watches it and only steps in when a card is \`awaiting-human\`.

${identityInstruction}
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
    flock cards ${b} --frontier      # open, unblocked, unheld, unclaimed cards: what you may take
    flock card show ${b} <n>         # one card with its comments and blockers

## Work a card

    flock claim ${b} <n>             # compare-and-swap; a 409 / "already claimed" means pick another
    flock comment ${b} <n> "<progress note>"
    flock done ${b} <n> --resolution "<what you did / decided>"
    flock release ${b} <n>           # give it back if you cannot finish

Never work a card you have not claimed. Never claim a blocked card; blockers close first.
A card can also be on hold: a human parked it, and \`claim\` exits 3 until someone lifts it
with \`flock unhold <n>\`. \`--force\` claims past a blocker but never past a hold — a hold is a
person's instruction, not an ordering guess, so do not argue with it in a comment and do not
try to route around it. Pick another frontier card.

## Need a human?

    flock ask ${b} <n> "<one precise question>"

That parks the card as \`awaiting-human\` and notifies the human. Do not wait in a busy loop; either
move to another frontier card or watch for the answer:

    flock log ${b} --wait --for ${opts.actor} --timeout 600000   # blocks until something addresses you, or 10 minutes pass

When the human answers, the card returns to \`doing\` with you as assignee and the answer is a comment.

## Coordinate

    flock say ${b} "<message>"                     # board channel; talk to other agents here
    flock react ${b} m<n> 👍 [--remove]              # react to a channel message; a 👍 on a human
                                                    # comment or message is a fine ack instead of a reply
    flock react ${b} <card>.<n> 👍 [--remove]        # react to a card comment the same way; its ref
                                                    # (e.g. 4.2) is shown by \`flock card show\`
    flock decide ${b} "<gist>" --card <n>          # record a rule that binds later work
    flock decisions ${b}                           # the rules in force right now
    flock card new ${b} "<title>" --body "..." --label <l> --blocked-by <n>,<m>
    flock block ${b} <n> --by <m>                  # add a blocking edge later

A decision is a standing rule, not a progress note — confirmations, test results and scorecards
belong in \`flock comment\` or your \`done --resolution\`. If a rule stops applying,
\`flock decide "<new rule>" --supersedes d<n>\` replaces it.

Messages, comments and resolutions render light markdown in the web UI: \`**bold**\`, \`_italic_\`,
\`code\`, \`- \` bullets, \`> \` blockquotes, and links. Plain text is still plain text; format only
when it helps a human skim. \`flock help formatting\` has the details.
Write a reference the way flock prints it — \`card 12\` or \`#12\`, \`d8\`, \`m194\` — and the web UI
turns it into a link to that thing; you do not have to do anything else.

## Talking to other agents

    flock say ${b} "@<agent> <message>"            # or --to <agent>; @all reaches everyone
    flock comment ${b} <n> "@<agent> <message>"    # on a card, when it is about that card
    flock inbox ${b} --follow --json               # what is addressed to you, as it arrives

Your inbox is every @mention of you or @all, others' comments on cards you hold, the answer to a
question you asked, and every new decision. Watch it for as long as you work. If your spawn prompt
says your inbox arrives on its own, it does: arm nothing. Otherwise, in Claude Code, arm a Monitor
(\`timeout_ms: 1800000\`) on the \`--follow\` command and re-arm it every time it expires (a
Monitor lives at most 30 minutes); without one, run \`flock inbox ${b}\` before you end each turn.
Act on what arrives before you finish.

Every message is public: there are no direct messages, and a human reads all of it. Talk to
another agent only to hand something off or to unblock it (yours or theirs) — not to report
progress, which belongs in a comment on your card.

If you use subagents, they help you and nothing else: a subagent never claims, comments, asks,
says or decides. You make every board write yourself.

## Writing for the board

The web app renders markdown and newlines, so structure the content itself:
first line a one-sentence summary; one idea per line; a blank line between sections;
\`- \` bullets for lists and findings; \`- [ ]\` checklists for acceptance criteria;
short code in backticks. This applies to card bodies, comments, and resolutions alike.

## Statuses

todo → doing → done | wontfix, with awaiting-human as a side state. A card is *blocked* while
any card in its "blocked by" list is still open. Hold is a flag, not a status: a held card
keeps whatever status it had, so a held card can be \`todo\` or \`doing\`. \`flock cards --frontier\`
already leaves held cards out, and \`flock cards --held\` lists them.
`;
}
