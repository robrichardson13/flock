#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CARD_STATUSES,
  DB_DIRNAME,
  DB_FILENAME,
  Flock,
  FlockError,
  exportBoard,
  commentRef,
  importBoard,
  messageRef,
  parseCommentRef,
  resolveDbPath,
  sniffImageMime,
  taskItems,
  type Actor,
  type Card,
  type CardStatus,
  type Decision,
  type Event,
  type Message,
} from "@flock/core";
import { bool, list, parseArgs, str } from "./args.ts";
import { baseUrl, resolveHost } from "./dev.ts";
import { handoffMarkdown } from "./handoff.ts";
import { actorWasDefaulted, resolveActor } from "./identity.ts";
import { flockHome } from "./paths.ts";
import { openForCli } from "./schema-policy.ts";
import { embeddedAssets, installScriptPath, versionLine } from "./runtime.ts";
import { maybeSpawnUpdateCheck } from "./update.ts";

const HELP = `flock — mission control for a team of agents

FOR AGENTS
  Asked to add or file a ticket? One line does it:
    flock card new "<title>" --body "<markdown>" --as <your-name>
  Attribution: pass --as <name> or export FLOCK_ACTOR=<name>. Omit it and the write
  silently files under the OS user, as a human rather than as you.
  The board is resolved from the working directory; confirm it with \`flock boards --here\`.
  Working cards on a board? Run \`flock handoff\` first.

USAGE
  flock <command> [args] [--as NAME] [--json] [--db PATH]

SCOPE
  One board per project directory (a repo or a worktree). Run \`flock init\` in the directory
  once; after that every command below resolves BOARD from the working directory, so the
  BOARD argument is optional. Name it (slug or id) to act on a different board.

CARDS   (BOARD optional, see SCOPE; N is the card number, "#12" or "12")
  cards [BOARD] [--frontier] [--blocked] [--held] [--mine] [--open] [--status S,S] [--label L] [--assignee A]
                                      --blocked: only cards still waiting on an open blocker
                                      --held: only cards a human has parked
  card new [BOARD] TITLE [--body MD | --body-file F] [--label L]... [--blocked-by N,M] [--assign A] [--status S]
  card show [BOARD] N
  card edit [BOARD] N [--title T] [--body MD | --body-file F] [--label L] [--unlabel L] [--position N]
                                      --position reorders the card among its board's cards
  card check [BOARD] N TASK [--uncheck]   Tick a "- [ ] " item in the body; TASK is its number in card show
  card uncheck [BOARD] N TASK
  claim [BOARD] N [--force]             Compare-and-swap claim (409 if taken, blocked or held;
                                        --force claims past a blocker, never past a hold)
  release [BOARD] N
  hold [BOARD] N [--reason TEXT]        Park a card: no agent may claim it until it is unheld
  unhold [BOARD] N                      Lift the hold; the card is claimable again
  assign [BOARD] N ACTOR | --none
  move [BOARD] N STATUS [--reason TEXT]  ${CARD_STATUSES.join(" | ")}
                                      Reopening a done/wontfix card back to todo/doing needs
                                      --reason; it's recorded as a comment on the card
  done [BOARD] N [--resolution TEXT] [--wontfix]
  block [BOARD] N --by M                Add a blocking edge (M must close before N starts)
  unblock [BOARD] N --by M
  comment [BOARD] N TEXT [--attach PATH]...   Comment on a card; --attach is repeatable and
                                      uploads an image (comment text is optional with one)

IDENTITY
  --as NAME        Act as NAME (implies --agent). Env: FLOCK_ACTOR, FLOCK_ACTOR_KIND
  --human/--agent  Override the kind
  --harness NAME   Runtime harness, e.g. claude-code@2.1.261. Env: FLOCK_HARNESS. Auto-detected for Claude Code.
  --model NAME     Model name, e.g. opus-5. Env: FLOCK_MODEL. Never auto-detected; pass it or it stays unknown.
  --effort LEVEL   Reasoning effort, e.g. high. Env: FLOCK_EFFORT. Auto-detected from CLAUDE_EFFORT when present.
  --json           Machine-readable output
  --db PATH        Database file. Env: FLOCK_DB. Default: ~/.flock/flock.db, or a .flock/ found walking up from cwd
  --host H         Bind host for serve/up. Precedence: --host, FLOCK_HOST, "host" in
                    ~/.flock/config.json, then the default 0.0.0.0 (every interface). Use
                    127.0.0.1 to bind loopback only. A bare up/restart with none of these given
                    keeps a running daemon's own host rather than resetting it. See docs/adr/0015.
  --tailscale       Front the browser-facing port with \`tailscale serve\` for an HTTPS origin on
  --no-tailscale    the tailnet (https://<machine>.<tailnet>.ts.net). Precedence: --tailscale/
                    --no-tailscale, FLOCK_TAILSCALE, "tailscale" in ~/.flock/config.json, then off.
                    FLOCK_TAILSCALE_BIN overrides where the tailscale binary is found. Refuses
                    (never warns) when tailscale is missing, logged out, or the port is already
                    mounted elsewhere. A bare up/restart keeps a running daemon's own choice, like
                    --host. \`flock down\` tears the mount down. \`url\`/\`status\`/the up and serve
                    banners list the https URL first once a mount is active. See docs/adr/0019
                    and docs/config.md.

BOARDS
  boards [--all] [--here]             List boards (--here: only this directory's)
  board new TITLE [--project DIR] [--slug S] [--body MD | --body-file F]
  board show [BOARD]                  Full picture: body, decisions, cards, frontier
  board edit [BOARD] [--title T] [--body MD | --body-file F] [--project DIR|none] [--archive | --activate]
  board delete [BOARD] [--yes]        Delete a board and everything on it. Asks first unless --yes
  board export [BOARD] [--out FILE]   Board as markdown
  board import FILE [--project DIR] [--slug S]   New board from markdown

HUMAN IN THE LOOP
  ask [BOARD] N QUESTION                Park the card as awaiting-human
  answer [BOARD] N TEXT                 Reply and hand the card back

TEAM
  handoff [BOARD]                     Print the agent onboarding text
  needs-me                            Cards waiting on a human, across all boards
  say [BOARD] TEXT [--attach PATH]...   Post to the board channel; --attach is repeatable and
                                      uploads an image (message text is optional with one).
                                      Prints the new message's ref (m<n>) for later \`flock react\`
  react [BOARD] REF EMOJI [--remove]    React to a channel message or a card comment; REF is
                                      "m7"/a bare "7" (message) or "4.2" (comment #2 on card #4).
                                      --remove removes the actor's reaction instead of adding it
  attachment get [BOARD] ID [--out PATH]   Fetch an attachment's bytes (stdout if --out omitted);
                                      --json prints its metadata only, never bytes
  chat [BOARD] [--limit 50]             Read the channel; each message shows its ref (m<n>) and
                                      any reactions
  decide [BOARD] GIST [--card N] [--supersedes D]   Record a decision; --supersedes archives D
  decisions [BOARD] [--archived | --all] [--card N] [--by ACTOR]   Standing decisions by default
  decision archive [BOARD] [D...] [--card N] [--by ACTOR] [--before YYYY-MM-DD] [--reason TEXT]
                    [--dry-run] [--yes]           A selector matching >10 needs --yes
  decision restore [BOARD] [D...] [--card N] [--by ACTOR] [--before YYYY-MM-DD] [--dry-run] [--yes]
  help formatting                     The markdown subset the web UI renders
  log [BOARD] [--all] [--since SEQ] [--wait | --follow] [--for NAME] [--timeout MS]
                                      --wait: block until a matching event, then exit. --all: every board
  actors                              Who has touched this database

SETUP
  init [TITLE] [--body MD | --body-file F] [--local]
                                      Create this directory's board (title defaults to the dir name).
                                      --local also creates an isolated .flock/ database here.
  serve [--port 4747] [--host 0.0.0.0] [--open]
                                      Run the web UI + HTTP API in the foreground. Binds every
                                      interface by default; --host 127.0.0.1 (or FLOCK_HOST) for
                                      loopback only. Prints the https tailnet URL first when its
                                      parent (\`up --foreground --tailscale\`) established a mount;
                                      --open still opens the loopback address.
  setup [--no-start] [--skill-only]   Write ~/.claude/skills/flock/SKILL.md, then \`flock up\`
                                      (a symlinked destination is left alone). --skill-only
                                      does just the skill; --no-start skips starting the daemon.
                                      Reports ~/.flock/skill.md (your personalization of the
                                      skill, see docs/config.md) when it exists; silent when not.
  up [--port N] [--host H] [--isolated | --db PATH] [--foreground] [--open]
     [--tailscale | --no-tailscale]
                                      Start the daemon in the background (detached; survives the
                                      terminal). In a checkout it starts the dev environment
                                      instead: bun --watch + vite on this checkout's ports.
                                      Idempotent: already running / started / restarted with new
                                      settings. --foreground runs \`serve\` here instead. --tailscale
                                      fronts the browser-facing port with \`tailscale serve\`; --open
                                      always opens the loopback address, never the tailnet one.
  down [--all]                        Stop this directory's daemon (--all: every one on the machine).
                                      Tears down its tailscale mount first, if it made one.
  restart                             Stop it and start it again (keeps its tailscale choice, like host)
  status                              This directory's daemon, plus every other one running. Adds a
                                      \`tls\` line naming the tailscale mount when one is active.
  logs [-f] [-n 40]                   Tail ~/.flock/logs/<name>.log
  url                                 Print the URL. Leads with the https tailnet URL when a
                                      tailscale mount is active (see --tailscale above), then:
                                      bound to 0.0.0.0 (the default): loopback, then LAN and
                                      Tailscale addresses. Bound to loopback only: just the
                                      loopback URL, plus a hint to reach it elsewhere (dropped once
                                      a tailscale mount already provides one).
  upgrade [--version=V]               Reinstall flock: re-runs the installer beside this binary,
                                      refreshes the skill and restarts a running daemon. An
                                      installed flock also does this on its own once a day; set
                                      FLOCK_NO_UPDATE=1, or {"autoupdate": false} in
                                      ~/.flock/config.json, to turn that off.
`;

/** Top-level daemon verbs, handled before the database is opened. `start`/`stop` alias `up`/`down`. */
const DAEMON_COMMANDS = new Set(["up", "start", "down", "stop", "restart", "status", "logs", "url"]);

const FORMATTING_HELP = `flock — message formatting

Text you write with \`say\`, \`comment\`, \`done --resolution\`, \`ask\` and \`answer\` is stored exactly as
you type it. The web UI renders a small markdown subset when it displays it; the CLI and \`--json\`
always show the raw text.

  **bold**        _italic_ or *italic*        ~~strikethrough~~
  \`inline code\`   \`\`\`fenced code blocks\`\`\`
  - bullet, one per line
  > blockquote, one \`> \` per line
  # through ###### headings
  https://example.com          bare links are clickable
  [text](https://example.com)  or name them

Newlines are preserved. Nothing else is interpreted: no tables, no HTML. Links open in a new tab
and only http, https and mailto are followed; anything else stays plain text.

This is a convenience, not a format. A one-line status message needs no markup. Reach for it when a
human is going to skim: a short bulleted list of what you found, a path or flag in backticks, a
bolded blocker.
`;

type Ctx = { flock: Flock; actor: Actor; json: boolean; dbPath: string; flags: ReturnType<typeof parseArgs>["flags"] };

function out(ctx: Ctx, data: unknown, human: () => void) {
  if (ctx.json) console.log(JSON.stringify(data, null, 2));
  else human();
}

/** Ask the human one question on the terminal. Callers check isTTY first. */
async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((res) => {
      rl.question(question, res);
      rl.once("close", () => res("")); // EOF answers nothing, which reads as "no"
    });
  } finally {
    rl.close();
  }
}

function readBody(flags: Ctx["flags"]): string | undefined {
  const file = str(flags["body-file"]);
  if (file) return readFileSync(file === "-" ? 0 : file, "utf8");
  return str(flags.body);
}

const STATUS_ICON: Record<CardStatus, string> = { todo: "·", doing: "▶", "awaiting-human": "?", done: "✓", wontfix: "✗" };

/**
 * Number the task-list items of a body in place, so `card show` tells a reader the
 * TASK argument `card check` wants. Everything else in the body is left verbatim.
 */
function numberTasks(body: string): string {
  const lines = body.split("\n");
  for (const t of taskItems(body)) {
    lines[t.line] = lines[t.line]!.replace(/^(\s*)([-*+]|\d+[.)])\s+\[/, `$1${t.index + 1}. [`);
  }
  return lines.join("\n");
}

function fmtCard(c: Card): string {
  const bits = [`${STATUS_ICON[c.status]} #${String(c.num).padStart(3)} ${c.title}`];
  if (c.assignee) bits.push(`@${c.assignee}`);
  if (c.labels.length) bits.push(`[${c.labels.join(", ")}]`);
  if (c.held) bits.push(c.holdReason ? `(on hold: ${c.holdReason})` : "(on hold)");
  if (c.blocked) bits.push(`(blocked by #${c.blockedBy.join(", #")})`);
  else if (c.blockedBy.length) bits.push(`(was blocked by #${c.blockedBy.join(", #")})`);
  return bits.join("  ");
}

function fmtEvent(e: Event): string {
  const who = `${e.actor}${e.actorKind === "agent" ? "🤖" : ""}`;
  const card = e.cardNum ? ` #${e.cardNum}` : "";
  const d = e.data as Record<string, any>;
  const detail =
    e.type === "card.created" ? `: ${d.title}` :
    e.type === "card.claimed" ? `${d.title ? `: ${d.title}` : ""}` :
    e.type === "card.moved" ? `: ${d.from} → ${d.to}` :
    e.type === "card.closed" ? `: ${d.to}` :
    e.type === "card.asked" ? `: ${d.question}` :
    e.type === "card.answered" ? `: ${d.answer}` :
    e.type === "message.posted" ? `: ${d.body || (d.attachments ? `sent ${d.attachments} image${d.attachments === 1 ? "" : "s"}` : "")}` :
    e.type === "comment.posted" ? `: ${String(d.body ?? "").split("\n")[0] || (d.attachments ? `sent ${d.attachments} image${d.attachments === 1 ? "" : "s"}` : "")}` :
    e.type === "decision.recorded" ? `: ${d.gist}` :
    e.type === "decision.archived" ? `: archived d${d.num}` :
    e.type === "decision.restored" ? `: restored d${d.num}` :
    e.type === "card.blocked" || e.type === "card.unblocked" ? ` by #${d.by}` :
    e.type === "card.held" ? `${d.reason ? `: ${d.reason}` : ""}` :
    e.type === "message.reacted" ? ` ${d.emoji} ${d.ref} (${d.messageAuthor}: "${d.gist}")` :
    e.type === "message.unreacted" ? ` removed ${d.emoji} from ${d.ref} (${d.messageAuthor}: "${d.gist}")` :
    e.type === "comment.reacted" ? ` ${d.emoji} ${d.ref} (${d.commentAuthor}: "${d.gist}")` :
    e.type === "comment.unreacted" ? ` removed ${d.emoji} from ${d.ref} (${d.commentAuthor}: "${d.gist}")` : "";
  return `${String(e.seq).padStart(5)}  ${e.createdAt.slice(11, 19)}  ${who.padEnd(14)} ${e.type}${card}${detail}`;
}

/** Decision numbers parse as `7` or `d7`, mirroring `Flock.parseCardRef`'s `#7`/`7`. */
function parseDecisionNum(ref: string): number {
  const n = Number.parseInt(ref.replace(/^[dD]/, ""), 10);
  if (!Number.isInteger(n) || n <= 0) throw new FlockError(`"${ref}" is not a decision number`, "invalid");
  return n;
}

/**
 * `flock react`'s REF is either a comment ref (`4.2`, core's `parseCommentRef`) or a message ref
 * (`m7`/a bare `7`). Tried in that order since a comment ref always contains a dot a message ref
 * never has; a ref matching neither is a usage error, not a not-found.
 */
function parseReactRef(ref: string): { kind: "comment"; cardNum: number; num: number } | { kind: "message"; num: number } {
  const comment = parseCommentRef(ref);
  if (comment) return { kind: "comment", ...comment };
  const n = Number.parseInt(ref.replace(/^[mM]/, ""), 10);
  if (/^[mM]?\d+$/.test(ref.trim()) && Number.isInteger(n) && n > 0) return { kind: "message", num: n };
  throw new FlockError(`"${ref}" is not a message reference (m<n>) or a comment reference (<card>.<n>)`, "invalid");
}

/** `  👍 2 (rob, conductor)` — one line per emoji, under a message in `chat` output. */
function fmtReactions(m: Pick<Message, "reactions">): string[] {
  return m.reactions.map((r) => `  ${r.emoji} ${r.count} (${r.actors.join(", ")})`);
}

function mentions(e: Event, name: string): boolean {
  const hay = JSON.stringify(e.data).toLowerCase();
  const n = name.toLowerCase();
  return e.actor.toLowerCase() === n || hay.includes(n) || hay.includes(`@${n}`);
}

const EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Fallback for `--attach` (say and comment) when magic-byte sniffing can't identify the file. */
function extensionMime(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return (ext && EXT_MIME[ext]) ?? null;
}

/** Read a `--attach PATH` off disk and upload it, returning the id to bind. Shared by `say` and `comment`. */
function uploadAttachment(flock: Flock, actor: Actor, board: string, path: string): string {
  const bytes = new Uint8Array(readFileSync(path));
  const mime = sniffImageMime(bytes) ?? extensionMime(path) ?? "application/octet-stream";
  return flock.attach(actor, board, { mime, bytes, name: basename(path) }).id;
}

/** The verb this process ran, for the post-command auto-update hook at the bottom of the file. */
let ranCommand: string | undefined;

async function main(argv: string[]) {
  const { positional, flags } = parseArgs(argv);
  let cmd = positional[0];
  ranCommand = cmd;
  let rest = positional.slice(1);
  // Before the `--version` check below, because `version` is a boolean flag: `flock upgrade
  // --version v2026.09.07.1` parses the tag as a positional, and `--version=<tag>` as a string.
  if (cmd === "upgrade" || cmd === "self-update") {
    const { updateCommand } = await import("./update.ts");
    await updateCommand({
      json: bool(flags.json),
      ifNewer: bool(flags["if-newer"]),
      version: str(flags.version) ?? rest[0],
      quiet: cmd === "self-update",
    });
    return;
  }
  if (bool(flags.version) || cmd === "--version") {
    console.log(versionLine());
    return;
  }
  if (!cmd || cmd === "help" || bool(flags.help) || bool(flags.h)) {
    console.log(rest[0] === "formatting" ? FORMATTING_HELP : HELP);
    return;
  }

  if (cmd === "setup") {
    const { setupCommand } = await import("./setup.ts");
    await setupCommand({ json: bool(flags.json), noStart: bool(flags["no-start"]), skillOnly: bool(flags["skill-only"]) });
    return;
  }

  if (DAEMON_COMMANDS.has(cmd)) {
    const { daemonCommand, foregroundPort } = await import("./daemon.ts");
    const opts = {
      json: bool(flags.json),
      isolated: bool(flags.isolated),
      db: str(flags.db),
      host: str(flags.host),
      port: str(flags.port) ? Number(str(flags.port)) : undefined,
      webPort: str(flags["web-port"]) ? Number(str(flags["web-port"])) : undefined,
      open: bool(flags.open),
      all: bool(flags.all),
      follow: bool(flags.follow) || bool(flags.f),
      lines: str(flags.n) ? Number(str(flags.n)) : str(flags.lines) ? Number(str(flags.lines)) : undefined,
      // --tailscale / --no-tailscale > FLOCK_TAILSCALE > "tailscale" in config.json > off; see
      // resolveTailscale in tailscale.ts. undefined here means "not specified on this invocation".
      tailscale: bool(flags["no-tailscale"]) ? false : bool(flags.tailscale) ? true : undefined,
    };
    // `up --foreground` is `serve` on the port this checkout would have used: fall through.
    if ((cmd === "up" || cmd === "start") && bool(flags.foreground)) {
      if (!str(flags.port)) process.env.FLOCK_PORT = String(foregroundPort(opts));
      const { resolveTailscale, establishTailscale, releaseTailscale, spawnRunner, findTailscaleReal } = await import("./tailscale.ts");
      if (resolveTailscale(opts.tailscale, process.env)) {
        const host = resolveHost(opts.host, process.env);
        const port = Number(process.env.FLOCK_PORT);
        const bin = findTailscaleReal();
        const mount = establishTailscale({ run: spawnRunner, bin, host, port });
        process.env.FLOCK_TAILSCALE_URL = mount.url;
        let released = false;
        const cleanup = () => {
          if (released) return;
          released = true;
          releaseTailscale({ run: spawnRunner, bin, target: mount.target });
        };
        // A SIGKILLed foreground `serve` leaves the mount behind; the next `flock up --tailscale`
        // re-asserts it and `flock down` clears it.
        process.on("SIGINT", () => {
          cleanup();
          process.exit(0);
        });
        process.on("SIGTERM", () => {
          cleanup();
          process.exit(0);
        });
        process.on("exit", cleanup);
      }
      cmd = "serve";
    } else {
      await daemonCommand(cmd, opts);
      return;
    }
  }

  if (cmd === "init" && bool(flags.local)) {
    const dir = resolve(str(flags.dir) ?? process.cwd());
    const localDb = join(dir, DB_DIRNAME, DB_FILENAME);
    mkdirSync(dirname(localDb), { recursive: true });
    const gi = join(dir, DB_DIRNAME, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*.db\n*.db-wal\n*.db-shm\n");
    new Flock(localDb).close();
    console.error(`Created isolated database ${localDb}`);
  }

  // ADR 0021: a worktree never stamps the shared database; it gets a private copy instead.
  const { flock, dbPath } = openForCli(resolveDbPath(str(flags.db)).path);
  const ctx: Ctx = { flock, actor: resolveActor(flags), json: bool(flags.json), dbPath, flags };
  try {
    await run(ctx, cmd, rest);
  } finally {
    flock.close();
  }
}

async function run(ctx: Ctx, cmd: string, a: string[]) {
  // `a` is reassigned as board/subcommand positionals are consumed.
  const { flock, actor, flags } = ctx;
  const need = (i: number, what: string): string => {
    if (a[i] === undefined) throw new FlockError(`Missing ${what}. Run \`flock help\`.`, "invalid");
    return a[i];
  };
  const cwd = process.cwd();
  /**
   * BOARD is optional everywhere: if the first positional names a board use it, otherwise
   * resolve the board scoped to the working directory. Returns the board ref and the rest.
   */
  const pickBoard = (): { board: string; rest: string[] } => {
    if (a[0] !== undefined && flock.findBoard(a[0])) return { board: a[0], rest: a.slice(1) };
    const here = flock.boardForDir(cwd);
    if (here) return { board: here.id, rest: a };
    throw new FlockError(`No board for ${cwd}. Run \`flock init\` here, or name a board: flock boards`, "not_found");
  };

  switch (cmd) {
    case "init": {
      const project = resolve(str(flags.dir) ?? cwd);
      const existing = flock.boardForDir(project);
      if (existing && existing.project === project) {
        return out(ctx, existing, () => console.log(`${project} already has board "${existing.title}" (${existing.slug})`));
      }
      const title = a[0] ?? str(flags.title) ?? basename(project);
      const b = flock.createBoard(actor, { title, slug: str(flags.slug), body: readBody(flags), project });
      return out(ctx, b, () => console.log(`Created board "${b.title}" (${b.slug}) for ${project}\n  db: ${ctx.dbPath}`));
    }

    case "serve": {
      const { serve } = await import("@flock/server");
      const port = Number(str(flags.port) ?? process.env.FLOCK_PORT ?? 4747);
      // A compiled binary has no `packages/web/dist` on disk: import.meta.dir resolves, but into
      // the virtual /$bunfs filesystem. There the embedded assets map (from assets.generated.ts,
      // via runtime.ts) is the only source; a checkout falls back to the built dist off disk.
      const staticDir = resolve(import.meta.dir, "../../web/dist");
      const assets = await embeddedAssets();
      const hostname = resolveHost(str(flags.host), process.env);
      const server = serve({ flock, dbPath: ctx.dbPath, port, hostname, staticDir, assets, installScriptPath, flockHome: flockHome() });
      // The first advertisedUrls entry, never the literal bind host: a wildcard bind would
      // otherwise print/--open the unusable `http://0.0.0.0:PORT`. `FLOCK_TAILSCALE_URL` is set by
      // `up --foreground --tailscale` just above, before this same process fell through to
      // `serve` — it leads the printed banner (ADR 0019 §8), same as `flock url`/`status`.
      const loopback = baseUrl(hostname, server.port ?? port);
      const url = process.env.FLOCK_TAILSCALE_URL || loopback;
      const ui = assets?.["/index.html"] ? "embedded" : existsSync(join(staticDir, "index.html")) ? "built" : "not built (run `bun run build`, or use `bun run dev`)";
      console.log(`flock serving ${url}\n  db: ${ctx.dbPath}\n  ui: ${ui}`);
      // Spawned by `flock up`? Write the runfile now that we are listening: it is up's readiness signal.
      const { announceListening } = await import("./daemon.ts");
      announceListening({ apiPort: server.port ?? port, host: hostname, db: ctx.dbPath });
      // A long-lived daemon is the one process that can keep itself current: 60s + jitter, then 6h.
      const { startDaemonUpdateChecks } = await import("./update.ts");
      startDaemonUpdateChecks();
      // Deliberately `loopback`, not `url`: `--open` puts a browser tab on this machine, so it
      // stays off the tailnet round-trip even when the banner above led with the https origin.
      if (bool(flags.open)) Bun.spawn(["open", loopback]);
      await new Promise(() => {});
      return;
    }

    case "handoff": {
      const b = a[0] ? flock.board(a[0]) : flock.boardForDir(cwd);
      flock.touchActor(actor);
      console.log(
        handoffMarkdown({
          board: b?.slug,
          project: b?.project,
          actor: actor.name,
          model: actor.model,
          dbPath: ctx.dbPath,
          defaulted: actorWasDefaulted(flags),
        }),
      );
      return;
    }

    case "needs-me": {
      const cards = flock.needsHuman();
      return out(ctx, cards, () => {
        if (!cards.length) return console.log("Nothing needs you.");
        for (const c of cards) {
          console.log(`${c.boardSlug} #${c.num}  ${c.title}  (asked by ${c.questionBy})`);
          console.log(`    ? ${c.question}`);
          console.log(`    → flock answer ${c.boardSlug} ${c.num} "..."`);
        }
      });
    }

    case "actors":
      return out(ctx, flock.listActors(), () => {
        for (const x of flock.listActors()) {
          const hm = [x.harness, x.model].filter(Boolean).join("/");
          const runtime = [hm, x.effort].filter(Boolean).join(" · ");
          console.log(`${x.kind === "agent" ? "🤖" : "👤"} ${x.name.padEnd(16)} ${runtime ? runtime.padEnd(28) + " " : ""}${x.lastSeen}`);
        }
      });

    case "boards": {
      let boards = flock.boardSummaries({ includeArchived: bool(flags.all) });
      if (bool(flags.here)) {
        const here = flock.boardForDir(cwd, { includeArchived: bool(flags.all) });
        boards = here ? boards.filter((b) => b.id === here.id) : [];
      }
      return out(ctx, boards, () => {
        if (!boards.length) return console.log(bool(flags.here) ? `No board for ${cwd}. Create one: flock init` : "No boards. Create one: flock init (in a project directory)");
        for (const b of boards) {
          const ah = b.counts["awaiting-human"];
          const here = b.project && (cwd === b.project || cwd.startsWith(b.project + "/")) ? " ←" : "";
          console.log(`${b.slug.padEnd(24)} ${b.title}  [${b.counts.todo} todo, ${b.counts.doing} doing, ${b.counts.done} done${ah ? `, ${ah} NEED YOU` : ""}]${b.status === "archived" ? "  (archived)" : ""}`);
          console.log(`${"".padEnd(24)} ${b.project ?? "(no project directory)"}${here}`);
        }
      });
    }

    case "board": {
      const sub = need(0, "subcommand (new|show|edit|delete|export|import)");
      if (sub === "new") {
        const project = str(flags.project) ? resolve(str(flags.project)!) : null;
        const b = flock.createBoard(actor, { title: need(1, "title"), slug: str(flags.slug), body: readBody(flags), project });
        return out(ctx, b, () => console.log(`Created board "${b.title}" (${b.slug})${b.project ? ` for ${b.project}` : ""}`));
      }
      a = a.slice(1);
      const picked = sub === "import" || sub === "delete" ? null : pickBoard();
      if (sub === "show") {
        const s = flock.snapshot(picked!.board);
        return out(ctx, s, () => {
          console.log(`# ${s.board.title}  (${s.board.slug})${s.board.status === "archived" ? "  ARCHIVED" : ""}`);
          console.log(`${s.board.project ?? "no project directory"}\n`);
          if (s.board.body.trim()) console.log(`${s.board.body.trim()}\n`);
          if (s.decisions.length) {
            console.log("## Decisions so far");
            for (const d of s.decisions) console.log(`- d${d.num}  ${d.cardNum ? `#${d.cardNum}: ` : ""}${d.gist}  (${d.author})`);
            console.log();
          }
          for (const status of CARD_STATUSES) {
            const cards = s.cards.filter((c) => c.status === status);
            if (!cards.length) continue;
            console.log(`## ${status} (${cards.length})`);
            for (const c of cards) console.log(fmtCard(c));
            console.log();
          }
          console.log(`Frontier: ${s.frontier.length ? s.frontier.map((n) => `#${n}`).join(", ") : "empty"}${s.held.length ? `   on hold: ${s.held.map((n) => `#${n}`).join(", ")}` : ""}   last event: ${s.lastSeq}`);
        });
      }
      if (sub === "edit") {
        const patch: Record<string, unknown> = {};
        if (str(flags.title)) patch.title = str(flags.title);
        const body = readBody(flags);
        if (body !== undefined) patch.body = body;
        if (str(flags.slug)) patch.slug = str(flags.slug);
        if (bool(flags.archive)) patch.status = "archived";
        if (bool(flags.activate)) patch.status = "active";
        const proj = str(flags.project);
        if (proj !== undefined) patch.project = proj === "none" ? null : resolve(proj);
        const b = flock.updateBoard(actor, picked!.board, patch);
        return out(ctx, b, () => console.log(`Updated ${b.slug}`));
      }
      if (sub === "delete") {
        // Unlike the other verbs, a named board that does not exist is an error rather than a
        // fall-through to this directory's board: a typo must not delete the wrong thing.
        const target = a[0] !== undefined ? flock.board(a[0]) : flock.board(pickBoard().board);
        const count = flock.listCards(target.id).length;
        if (!bool(flags.yes)) {
          if (!process.stdin.isTTY) throw new FlockError(`Refusing to delete ${target.slug} without confirmation. Pass --yes.`, "invalid");
          const answer = await ask(`Delete board ${target.slug} and ${count} cards? [y/N] `);
          if (!/^y(es)?$/i.test(answer.trim())) return console.error("Cancelled");
        }
        const deleted = flock.deleteBoard(actor, target.id);
        return out(ctx, { deleted: deleted.slug }, () => console.log(`Deleted board ${deleted.slug} and ${deleted.cards} cards`));
      }
      if (sub === "export") {
        const md = exportBoard(flock, picked!.board);
        const outFile = str(flags.out);
        if (outFile) {
          writeFileSync(outFile, md);
          console.log(`Wrote ${outFile}`);
        } else process.stdout.write(md);
        return;
      }
      if (sub === "import") {
        const file = need(0, "file");
        const md = readFileSync(file === "-" ? 0 : file, "utf8");
        const project = str(flags.project) ? resolve(str(flags.project)!) : null;
        const warnings: string[] = [];
        const b = importBoard(flock, actor, md, { slug: str(flags.slug), title: str(flags.title), project, warnings });
        for (const w of warnings) console.error(`warning: ${w}`);
        return out(ctx, flock.snapshot(b.id), () => console.log(`Imported board "${b.title}" (${b.slug}) with ${flock.listCards(b.id).length} cards`));
      }
      throw new FlockError(`Unknown board subcommand "${sub}"`);
    }

    case "cards": {
      const { board } = pickBoard();
      const cards = flock.listCards(board, {
        frontier: bool(flags.frontier),
        open: bool(flags.open),
        status: list(flags.status).length ? (list(flags.status) as CardStatus[]) : undefined,
        label: str(flags.label),
        assignee: bool(flags.mine) ? actor.name : str(flags.assignee),
        held: bool(flags.held) ? true : undefined,
      }).filter((c) => !bool(flags.blocked) || c.blocked);
      return out(ctx, cards, () => {
        if (!cards.length) return console.log("No matching cards.");
        for (const c of cards) console.log(fmtCard(c));
      });
    }

    case "card": {
      const sub = need(0, "subcommand (new|show|edit|check|uncheck)");
      a = a.slice(1);
      const { board, rest } = pickBoard();
      a = rest;
      if (sub === "new") {
        const c = flock.createCard(actor, board, {
          title: need(0, "title"),
          body: readBody(flags),
          labels: list(flags.label),
          blockedBy: list(flags["blocked-by"]).map((n) => Flock.parseCardRef(n)),
          assignee: str(flags.assign) ?? null,
          status: str(flags.status) as CardStatus | undefined,
        });
        return out(ctx, c, () => console.log(`Created ${fmtCard(c)}`));
      }
      if (sub === "show") {
        const n = need(0, "card number");
        const c = flock.card(board, n);
        const comments = flock.comments(board, n);
        const blocks = flock.dependents(board, n).map((d) => d.num);
        return out(ctx, { card: c, comments, blocks }, () => {
          console.log(fmtCard(c));
          console.log(`   status: ${c.status}   created by ${c.createdBy} ${c.createdAt.slice(0, 16)}   updated ${c.updatedAt.slice(0, 16)}`);
          if (blocks.length) console.log(`   blocks: #${blocks.join(", #")}`);
          if (c.held) console.log(`   on hold since ${c.heldAt!.slice(0, 16)} by ${c.heldBy}${c.holdReason ? ` — ${c.holdReason}` : ""}`);
          if (c.question) console.log(`\n   ? ${c.question}   (asked by ${c.questionBy})`);
          if (c.body.trim()) console.log(`\n${numberTasks(c.body.trim()).replace(/^/gm, "   ")}`);
          if (comments.length) {
            console.log("\n   --- comments ---");
            for (const cm of comments) {
              const imgs = cm.attachments.length ? `  [+${cm.attachments.length} image${cm.attachments.length === 1 ? "" : "s"}]` : "";
              console.log(`   ${commentRef(cm.cardNum, cm.num)}  [${cm.kind}] ${cm.author} ${cm.createdAt.slice(0, 16)}${imgs}\n${cm.body.replace(/^/gm, "     ")}`);
              for (const line of fmtReactions(cm)) console.log(`   ${line}`);
            }
          }
        });
      }
      if (sub === "check" || sub === "uncheck") {
        const n = need(0, "card number");
        const i = Number.parseInt(need(1, "task number"), 10);
        if (!Number.isInteger(i) || i < 1) throw new FlockError(`"${need(1, "task number")}" is not a task number; they start at 1`, "invalid");
        const checked = sub === "check" ? !bool(flags.uncheck) : false;
        // Task numbers are 1-based for a human reading `card show`; core counts from 0,
        // so range errors are worded here rather than letting core's index leak out.
        const before = flock.card(board, n);
        const total = taskItems(before.body).length;
        if (i > total) {
          throw new FlockError(
            total === 0 ? `#${before.num} has no "- [ ] " items in its body` : `#${before.num} has ${total} task${total === 1 ? "" : "s"}; there is no task ${i}`,
            "not_found",
          );
        }
        const c = flock.toggleCardTask(actor, board, n, i - 1, checked);
        const item = taskItems(c.body)[i - 1]!;
        return out(ctx, c, () => console.log(`${item.checked ? "Checked" : "Unchecked"} ${i}. ${item.text}   ${fmtCard(c)}`));
      }
      if (sub === "edit") {
        const n = need(0, "card number");
        const c = flock.updateCard(actor, board, n, { title: str(flags.title), body: readBody(flags), addLabels: list(flags.label), removeLabels: list(flags.unlabel), position: str(flags.position) ? Number(str(flags.position)) : undefined });
        return out(ctx, c, () => console.log(`Updated ${fmtCard(c)}`));
      }
      throw new FlockError(`Unknown card subcommand "${sub}"`);
    }

    case "claim": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.claimCard(actor, board, need(0, "card number"), { force: bool(flags.force) });
      return out(ctx, c, () => console.log(`Claimed ${fmtCard(c)}`));
    }
    case "release": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.releaseCard(actor, board, need(0, "card number"));
      return out(ctx, c, () => console.log(`Released ${fmtCard(c)}`));
    }
    case "hold": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.holdCard(actor, board, need(0, "card number"), { reason: str(flags.reason) ?? a[1] });
      return out(ctx, c, () => console.log(`Held ${fmtCard(c)}`));
    }
    case "unhold": {
      const { board, rest } = pickBoard(); a = rest;
      const before = flock.card(board, need(0, "card number"));
      const c = flock.unholdCard(actor, board, need(0, "card number"));
      return out(ctx, c, () => console.log(before.held ? `Unheld ${fmtCard(c)}` : `#${c.num} was not on hold.`));
    }
    case "assign": {
      const { board, rest } = pickBoard(); a = rest;
      const who = bool(flags.none) ? null : need(1, "actor name (or --none)");
      const c = flock.assignCard(actor, board, need(0, "card number"), who);
      return out(ctx, c, () => console.log(`Assigned ${fmtCard(c)}`));
    }
    case "move": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.moveCard(actor, board, need(0, "card number"), need(1, "status") as CardStatus, { reason: str(flags.reason) });
      return out(ctx, c, () => console.log(`Moved ${fmtCard(c)}`));
    }
    case "done":
    case "close": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.closeCard(actor, board, need(0, "card number"), { resolution: str(flags.resolution) ?? a[1], status: bool(flags.wontfix) ? "wontfix" : "done" });
      return out(ctx, c, () => console.log(`Closed ${fmtCard(c)}`));
    }
    case "block": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.addBlocker(actor, board, need(0, "card number"), str(flags.by) ?? need(1, "--by M"));
      return out(ctx, c, () => console.log(`${fmtCard(c)}`));
    }
    case "unblock": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.removeBlocker(actor, board, need(0, "card number"), str(flags.by) ?? need(1, "--by M"));
      return out(ctx, c, () => console.log(`${fmtCard(c)}`));
    }
    case "comment": {
      const { board, rest } = pickBoard(); a = rest;
      const num = need(0, "card number");
      const attachPaths = list(flags.attach);
      if (attachPaths.length === 0 && a[1] === undefined) throw new FlockError("Missing text. Run `flock help`.", "invalid");
      const attachmentIds = attachPaths.map((p) => uploadAttachment(flock, actor, board, p));
      const cm = flock.addComment(actor, board, num, a[1] ?? "", "comment", { attachments: attachmentIds });
      return out(ctx, cm, () => console.log(`Commented on #${flock.card(board, num).num}${cm.attachments.length ? `  + ${cm.attachments.length} attachments` : ""}`));
    }
    case "ask": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.askHuman(actor, board, need(0, "card number"), need(1, "question"));
      return out(ctx, c, () => console.log(`#${c.num} is now awaiting-human. Watch with: flock log ${flock.board(board).slug} --wait --for ${actor.name}`));
    }
    case "answer": {
      const { board, rest } = pickBoard(); a = rest;
      const c = flock.answerHuman(actor, board, need(0, "card number"), need(1, "answer"));
      return out(ctx, c, () => console.log(`Answered. ${fmtCard(c)}`));
    }
    case "say": {
      const { board, rest } = pickBoard(); a = rest;
      const attachPaths = list(flags.attach);
      if (attachPaths.length === 0 && a[0] === undefined) throw new FlockError("Missing message. Run `flock help`.", "invalid");
      const attachmentIds = attachPaths.map((p) => uploadAttachment(flock, actor, board, p));
      const m = flock.say(actor, board, a[0] ?? "", { attachments: attachmentIds });
      return out(ctx, m, () => console.log(`${messageRef(m.num)}  ${m.author}: ${m.body}${m.attachments.length ? `  + ${m.attachments.length} attachments` : ""}`));
    }
    case "react": {
      const { board, rest } = pickBoard(); a = rest;
      const target = parseReactRef(need(0, "reference (m<n> or <card>.<n>)"));
      const emoji = need(1, "emoji");
      const remove = bool(flags.remove);
      if (target.kind === "comment") {
        const result = remove
          ? flock.unreactFromComment(actor, board, target.cardNum, target.num, emoji)
          : flock.reactToComment(actor, board, target.cardNum, target.num, emoji);
        return out(ctx, result, () => {
          const ref = commentRef(target.cardNum, target.num);
          if (!result.changed) return console.log(remove ? "not reacted" : "already reacted");
          console.log(`${emoji} ${ref} (${actor.name})${remove ? " removed" : ""}`);
          if (!remove && result.answeredCard) console.log(`answered #${result.answeredCard.num} with ${emoji}`);
        });
      }
      const result = remove ? flock.unreact(actor, board, target.num, emoji) : flock.react(actor, board, target.num, emoji);
      return out(ctx, result, () => {
        const ref = messageRef(target.num);
        if (!result.changed) return console.log(remove ? "not reacted" : "already reacted");
        console.log(`${emoji} ${ref} (${actor.name})${remove ? " removed" : ""}`);
      });
    }
    case "attachment": {
      const sub = need(0, "subcommand (get)");
      a = a.slice(1);
      if (sub !== "get") throw new FlockError(`Unknown attachment subcommand "${sub}". Run \`flock help\`.`, "invalid");
      const { board, rest } = pickBoard(); a = rest;
      const id = need(0, "attachment id");
      const { meta, bytes } = flock.attachment(board, id);
      if (ctx.json) {
        console.log(JSON.stringify(meta, null, 2));
        return;
      }
      const outPath = str(flags.out);
      if (!outPath || outPath === "-") {
        process.stdout.write(bytes);
      } else {
        writeFileSync(outPath, bytes);
        console.log(`Wrote ${meta.size} bytes to ${outPath}`);
      }
      return;
    }
    case "chat": {
      const { board } = pickBoard();
      const ms = flock.messages(board, { limit: Number(str(flags.limit) ?? 50) });
      return out(ctx, ms, () => {
        if (!ms.length) return console.log("Channel is empty.");
        for (const m of ms) {
          const attach = m.attachments.length ? `  [+${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}]` : "";
          console.log(`${messageRef(m.num)}  ${m.createdAt.slice(5, 16)}  ${m.author}${m.authorKind === "agent" ? "🤖" : ""}: ${m.body}${attach}`);
          for (const line of fmtReactions(m)) console.log(line);
        }
      });
    }
    case "decide": {
      const { board, rest } = pickBoard(); a = rest;
      const supersedes = str(flags.supersedes) !== undefined ? parseDecisionNum(str(flags.supersedes)!) : undefined;
      const d = flock.decide(actor, board, need(0, "gist"), str(flags.card) ?? null, { supersedes });
      return out(ctx, d, () => console.log(`Recorded d${d.num}${supersedes !== undefined ? ` (supersedes d${supersedes})` : ""}: ${d.gist}`));
    }
    case "decisions": {
      const { board } = pickBoard();
      const archived: boolean | "all" | undefined = bool(flags.all) ? "all" : bool(flags.archived) ? true : undefined;
      const card = str(flags.card) !== undefined ? Number(str(flags.card)) : undefined;
      const by = str(flags.by);
      const ds = flock.decisions(board, { archived, card, author: by });
      return out(ctx, ds, () => {
        for (const d of ds) {
          let status = "";
          if (d.supersededBy) status = ` [superseded by d${d.supersededBy}]`;
          else if (d.archivedAt) status = " [archived]";
          console.log(`- d${d.num}  ${d.cardNum ? `#${d.cardNum}: ` : ""}${d.gist}  (${d.author}, ${d.createdAt.slice(0, 10)})${status}`);
        }
        if (!ds.length) console.log(archived === true ? "No archived decisions." : "No decisions yet.");
        // The hint runs the same filters as the listing, and prints on an empty listing too:
        // a board whose decisions are *all* archived is exactly the case that must not read
        // as "No decisions yet." with nothing else said.
        if (archived === undefined) {
          const hidden = flock.decisions(board, { archived: true, card, author: by }).length;
          if (hidden > 0) console.log(`(${hidden} archived — flock decisions --archived)`);
        }
      });
    }
    case "decision": {
      const sub = need(0, "subcommand (archive|restore)");
      if (sub !== "archive" && sub !== "restore") throw new FlockError(`Unknown decision subcommand "${sub}". Run \`flock help\`.`, "invalid");
      a = a.slice(1);
      const { board, rest } = pickBoard(); a = rest;
      const nums = a.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean).map(parseDecisionNum);
      const card = str(flags.card) !== undefined ? Number(str(flags.card)) : undefined;
      const by = str(flags.by);
      const before = str(flags.before);
      if (nums.length === 0 && card === undefined && by === undefined && before === undefined) {
        throw new FlockError("Nothing to select. Pass decision numbers, or --card/--by/--before.", "invalid");
      }
      const usingFilter = nums.length === 0;
      const sel = usingFilter ? { card, author: by, before } : { nums };
      const past = sub === "archive" ? "archived" : "restored";
      const Past = sub === "archive" ? "Archived" : "Restored";
      // Resolve the same way core's selector would, for the --yes gate and --dry-run preview.
      // Explicit nums: not_found on the first missing one, matching resolveDecisionSelector.
      // Rows already in the target state are dropped, because core skips them silently: a
      // preview that promises to archive ten rows the write will not touch is worse than none,
      // and the gate should count the blast radius, not the match.
      const wouldChange = (d: Decision) => (sub === "archive" ? !d.archivedAt : !!d.archivedAt);
      const resolveMatched = (): Decision[] => {
        if (usingFilter) {
          return flock.decisions(board, { archived: "all", card, author: by })
            .filter((d) => (before === undefined || d.createdAt < before) && wouldChange(d));
        }
        const byNum = new Map(flock.decisions(board, { archived: "all" }).map((d) => [d.num, d]));
        return nums.map((n) => {
          const d = byNum.get(n);
          if (!d) throw new FlockError(`No decision d${n} on board "${flock.board(board).slug}"`, "not_found");
          return d;
        }).filter(wouldChange);
      };
      const dryRun = bool(flags["dry-run"]);
      if (usingFilter && !dryRun && !bool(flags.yes)) {
        const matched = resolveMatched();
        if (matched.length > 10) {
          throw new FlockError(`${matched.length} decisions match. Re-run with --yes, or --dry-run to list them.`, "invalid");
        }
      }
      if (dryRun) {
        const matched = resolveMatched();
        return out(ctx, { dryRun: true, matched }, () => {
          if (!matched.length) return console.log(`Nothing to ${sub}.`);
          console.log(`Would ${sub} ${matched.length} decision${matched.length === 1 ? "" : "s"}: ${matched.map((d) => `d${d.num}`).join(", ")}`);
        });
      }
      const changed = sub === "archive"
        ? flock.archiveDecisions(actor, board, sel, { reason: str(flags.reason) })
        : flock.restoreDecisions(actor, board, sel);
      return out(ctx, { [past]: changed }, () => {
        if (!changed.length) return console.log(`Nothing to ${sub}.`);
        console.log(`${Past} ${changed.length} decision${changed.length === 1 ? "" : "s"}: ${changed.map((d) => `d${d.num}`).join(", ")}`);
      });
    }

    case "log":
    case "events": {
      // log: an explicit board, else this directory's board, else everything.
      const boardId = a[0] ? flock.board(a[0]).id : bool(flags.all) ? undefined : flock.boardForDir(cwd)?.id;
      const forName = str(flags.for);
      let since = str(flags.since) !== undefined ? Number(str(flags.since)) : bool(flags.follow) || bool(flags.wait) ? flock.lastSeq(boardId) : Math.max(0, flock.lastSeq(boardId) - 30);
      const timeout = Number(str(flags.timeout) ?? (bool(flags.follow) ? 0 : 30000));
      const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
      const print = (evs: Event[]) => {
        const shown = forName ? evs.filter((e) => mentions(e, forName)) : evs;
        if (ctx.json) for (const e of shown) console.log(JSON.stringify(e));
        else for (const e of shown) console.log(fmtEvent(e));
        return shown;
      };
      let batch = flock.events({ boardId, since });
      if (batch.length) since = batch[batch.length - 1].seq;
      let shown = print(batch);
      if (!bool(flags.follow) && !bool(flags.wait)) return;
      // --wait: block until something (matching --for) arrives, then exit. --follow: stream forever.
      while (bool(flags.follow) || shown.length === 0) {
        if (Date.now() >= deadline) return;
        batch = await flock.waitForEvents({ boardId, since, timeoutMs: Math.min(30000, Math.max(0, deadline - Date.now())) });
        if (batch.length) since = batch[batch.length - 1].seq;
        shown = print(batch);
      }
      return;
    }
    default:
      throw new FlockError(`Unknown command "${cmd}". Run \`flock help\`.`);
  }
}

main(process.argv.slice(2))
  .then(() => {
    // After the command's output, never before: this spawns a detached checker at most once a day
    // and returns. It is guarded on `isStandalone()` first, so a checkout pays nothing for it.
    maybeSpawnUpdateCheck(ranCommand);
  })
  .catch((err) => {
    // The same hook on the failure path: an update check must not depend on the command having
    // succeeded, and it changes neither the message below nor the exit code.
    maybeSpawnUpdateCheck(ranCommand);
    if (err instanceof FlockError) {
      if (process.argv.includes("--json")) console.log(JSON.stringify({ error: err.message, code: err.code }));
      else console.error(`error: ${err.message}`);
      process.exit(err.code === "conflict" ? 3 : err.code === "not_found" ? 2 : 1);
    }
    console.error(err);
    process.exit(1);
  });
