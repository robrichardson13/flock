import type { CardStatus } from "./api.ts";

/**
 * Which actions a card offers, and which of them are worth a button.
 *
 * The card page used to draw every applicable verb as a button in one row: Claim/Release,
 * Unassign, Hold/Release hold and Mark done, four labels of unequal weight that wrapped into a
 * ragged block on the phone and overflowed the drawer's 44px header on desktop, pushing the
 * "…" menu itself off the edge (card 99). The row is the wrong home for a verb nobody reaches
 * for, and a row that can grow is a row that will one day wrap.
 *
 * So this module owns the ranking, not the component: the top `ROW_MAX` go in the row, the rest
 * fall through to the overflow menu the card already has. Pure, so the rules are testable
 * without a DOM — the same split `details.ts` makes for the Details list.
 */

/** Every verb the card page can perform on a card. The component maps these to API calls. */
export type CardActionKey = "claim" | "release" | "unassign" | "hold" | "unhold" | "done" | "reopen";

export interface CardAction {
  key: CardActionKey;
  /** What the button or menu item says. Carries the assignee's name for `unassign`. */
  label: string;
  /** `ok` is the affirmative fill (Mark done); `ghost` is the quiet one beside a solid button. */
  tone?: "ok" | "ghost";
}

export interface CardActionSet {
  /** At most `ROW_MAX`, most-reached first. Drawn as equal-width buttons. */
  row: CardAction[];
  /** Everything else, in the "…" menu. Never empty of a verb that is not in the row. */
  overflow: CardAction[];
}

/**
 * Two. The row is a fixed-width grid of this many columns, which is what makes wrapping
 * impossible rather than merely unlikely — the failure card 30 patched with `flex-wrap`.
 */
export const ROW_MAX = 2;

export interface CardActionsInput {
  status: CardStatus;
  assignee: string | null;
  held: boolean;
  /** A blocked card can still be claimed, but the label says so. */
  blocked: boolean;
  /** The viewer, for telling "Release" (mine) from "Unassign <name>" (someone else's). */
  me: string;
}

function isClosed(status: CardStatus): boolean {
  return status === "done" || status === "wontfix";
}

/**
 * The verbs that may take a button. `unassign` and `done` are deliberately not among them: one
 * carries an agent's whole name as its label — the string that broke both layouts — and the
 * other already has two better routes. Both stay one tap away in the "…" menu.
 */
const ROW_ELIGIBLE: ReadonlySet<CardActionKey> = new Set<CardActionKey>(["claim", "release", "hold", "unhold", "reopen"]);

/**
 * Ranked, most-reached first. A closed card has exactly one thing to say; an open one leads
 * with whatever undoes its current state — a hold before anything else, since a held card is a
 * person's instruction and lifting it is why you opened the card — then the assignment verb,
 * then Hold, then the two nobody reaches for from here.
 */
function rank({ status, assignee, held, blocked, me }: CardActionsInput): CardAction[] {
  if (isClosed(status)) return [{ key: "reopen", label: "Reopen" }];
  const mine = assignee === me;
  const out: CardAction[] = [];
  if (held) out.push({ key: "unhold", label: "Release hold" });
  // A held card hides Claim rather than disabling it: claiming one always 409s, and a control
  // that cannot succeed is worse than no control.
  if (!assignee && !held) out.push({ key: "claim", label: blocked ? "Claim anyway" : "Claim" });
  if (mine) out.push({ key: "release", label: "Release" });
  if (!held) out.push({ key: "hold", label: "Hold", tone: "ghost" });
  if (assignee && !mine) out.push({ key: "unassign", label: `Unassign ${assignee}` });
  // Mark done is last on purpose: the Status row's Move sheet closes a card, and so does the
  // composer's Resolve mode, which is the route that also records why.
  out.push({ key: "done", label: "Mark done", tone: "ok" });
  return out;
}

/**
 * Split the ranked verbs into the row and the overflow menu. The row takes the first `ROW_MAX`
 * eligible ones in rank order; everything left over keeps that order in the menu, so nothing a
 * card can do is ever unreachable.
 */
export function buildCardActions(input: CardActionsInput): CardActionSet {
  const ranked = rank(input);
  const picked = ranked.filter((a) => ROW_ELIGIBLE.has(a.key)).slice(0, ROW_MAX);
  // Ghost is a relationship, not a property: it says "quieter than the button next to me". A
  // lone ghost button spanning the row is just centred text under a list, so the only action
  // on offer always gets the solid treatment.
  const row = picked.length === 1 ? picked.map((a) => ({ ...a, tone: undefined })) : picked;
  const inRow = new Set(row.map((a) => a.key));
  return { row, overflow: ranked.filter((a) => !inRow.has(a.key)) };
}
