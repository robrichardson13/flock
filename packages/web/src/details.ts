import type { CardStatus } from "./api.ts";
import { STATUS_LABEL } from "./ui.tsx";

/**
 * The Details list on a card page: the card's own facts as an iOS grouped-inset list rather
 * than a drift of chip rows. This module owns which rows exist and what each one's trailing
 * value says; the component only draws them. Keeping it pure means the rules — which rows
 * hide, when a row is tappable, what "no value" reads as — are testable without a DOM.
 */

/** One `#n` in a trailing value. `open` drives the padlock and the warn tint. */
export interface CardToken {
  num: number;
  status?: CardStatus;
  open: boolean;
}

export type DetailRow =
  | { key: "status"; label: string; tappable: true; status: CardStatus; value: string }
  | { key: "assignee"; label: string; tappable: false; assignee: string | null; kind: "human" | "agent"; runtime: string | null }
  | { key: "labels"; label: string; tappable: true; labels: string[] }
  | { key: "blockedBy"; label: string; tappable: true; tokens: CardToken[] }
  | { key: "blocks"; label: string; tappable: boolean; tokens: CardToken[] }
  | { key: "hold"; label: string; tappable: false; heldBy: string; heldAt: string; reason: string | null };

/** A card is open until it is closed one way or the other. */
export function isOpenStatus(status: CardStatus | undefined): boolean {
  return status !== "done" && status !== "wontfix";
}

/**
 * The muted suffix after an assignee's name: the model, and the effort when it is known.
 * Harness stays out of the line — it is in the tooltip on `RuntimeTag` and never the field
 * worth a second of a reader's attention.
 */
export function runtimeText(runtime?: { model?: string; effort?: string }): string | null {
  if (!runtime?.model) return null;
  return runtime.effort ? `${runtime.model} · ${runtime.effort}` : runtime.model;
}

export interface DetailsInput {
  card: {
    status: CardStatus;
    assignee: string | null;
    labels: string[];
    blockedBy: number[];
    held: boolean;
    heldBy: string | null;
    heldAt: string | null;
    holdReason: string | null;
  };
  /** Cards this one blocks, from `api.card`. */
  blocks: number[];
  /** Every card on the board, for resolving a number's status. */
  allCards: { num: number; status: CardStatus }[];
  /** The assignee's roll-up, when there is an assignee we know something about. */
  holder?: { kind?: string; model?: string; effort?: string };
}

function tokens(nums: number[], allCards: { num: number; status: CardStatus }[]): CardToken[] {
  return nums.map((num) => {
    const c = allCards.find((x) => x.num === num);
    return { num, status: c?.status, open: isOpenStatus(c?.status) };
  });
}

/**
 * Status, Assignee, Labels and Blocked by always render — a card always has a status, and
 * the other three are how you give it one. Blocks is the exception: nothing on this card
 * can add one, so with no blocks the row would be an empty statement, and it is dropped.
 */
export function buildDetailRows({ card, blocks, allCards, holder }: DetailsInput): DetailRow[] {
  const rows: DetailRow[] = [
    { key: "status", label: "Status", tappable: true, status: card.status, value: STATUS_LABEL[card.status] },
    {
      key: "assignee",
      label: "Assignee",
      tappable: false,
      assignee: card.assignee,
      kind: holder?.kind === "human" ? "human" : "agent",
      runtime: card.assignee ? runtimeText(holder) : null,
    },
    { key: "labels", label: "Labels", tappable: true, labels: card.labels },
    { key: "blockedBy", label: "Blocked by", tappable: true, tokens: tokens(card.blockedBy, allCards) },
  ];
  if (card.held && card.heldBy && card.heldAt) {
    rows.push({ key: "hold", label: "On hold", tappable: false, heldBy: card.heldBy, heldAt: card.heldAt, reason: card.holdReason });
  }
  if (blocks.length > 0) {
    rows.push({ key: "blocks", label: "Blocks", tappable: true, tokens: tokens(blocks, allCards) });
  }
  return rows;
}

/** The tooltip/aria-label on a held card's row/tile badge, and the card page's hold row. */
export function holdTitle(card: { heldAt: string | null; heldBy: string | null; holdReason: string | null }): string {
  const since = card.heldAt ? card.heldAt.slice(0, 10) : "unknown";
  return `On hold since ${since}, held by ${card.heldBy}${card.holdReason ? `: ${card.holdReason}` : ""}`;
}
