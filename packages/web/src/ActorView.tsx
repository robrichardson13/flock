/**
 * One actor, as this board knows them (#49).
 *
 * The board is full of avatars — a card row's assignee, the header stack, the roster, every
 * thread bubble — and until now none of them answered the only question they raise: who is
 * that, and what have they done here? Tapping any of them opens this, a sheet on the phone
 * and a right-hand panel on desktop, at its own route (`#/b/<slug>/a/<name>`) so it survives
 * a refresh and can be linked to.
 *
 * There is no "the card they are on", singular: nothing in flock limits an actor to one
 * claim (the CAS in `claimCard` is per card), so Doing is a list like the others.
 *
 * Data is one fetch of `GET /api/boards/:b/actors/:name`, mirroring `Flock.actorProfile`.
 * The board snapshot the caller already holds seeds the header and the cards they hold, so
 * the sheet opens on real content and the fetch only adds the history behind it (#43); a
 * skeleton stands in only where the snapshot has nothing to say.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type ActorCard, type ActorProfile, type ActorTelemetryTotals, type Card, type HarnessSessionTelemetry, type TeamMember } from "./api.ts";
import { groupActorCards, rolesCaption, sharedRoles, shortAge } from "./people.ts";
import { ActorTelemetryStrip, useLivePoll, useNow } from "./Telemetry.tsx";
import { hasLiveSession } from "./telemetry-format.ts";
import { Avatar, EMPTY_TEXT, RuntimeTag, Sheet, SheetBack } from "./ui.tsx";

/** ADR 0026: the two fields `GET /api/boards/:b/actors/:name` adds on top of `ActorProfile`.
 *  Optional here (rather than folded into `ActorProfile` itself) so `seedProfile` below —
 *  which answers from the board snapshot alone, before this route has ever been fetched —
 *  never has to fake a telemetry reading it does not have. */
type FullProfile = ActorProfile & { telemetry?: HarnessSessionTelemetry[]; totals?: ActorTelemetryTotals };

/** What the caller can hand over from the board snapshot without another request. */
export interface ActorSeed {
  member?: TeamMember;
  /** The cards this actor holds right now, from the snapshot's own list. */
  holding: Card[];
}

const GROUPS: { key: "doing" | "done" | "other"; label: string }[] = [
  { key: "doing", label: "Doing" },
  { key: "done", label: "Done" },
  { key: "other", label: "Other" },
];

/** Seeded profile: everything the snapshot alone can answer, with the same shape as the fetch. */
function seedProfile(name: string, seed: ActorSeed): FullProfile | null {
  if (!seed.member && seed.holding.length === 0) return null;
  return {
    name,
    kind: seed.member?.kind ?? "agent",
    lastSeen: seed.member?.lastSeen ?? null,
    events: seed.member?.events ?? 0,
    harness: seed.member?.harness,
    model: seed.member?.model,
    effort: seed.member?.effort,
    cards: seed.holding.map((c) => ({ ...c, roles: ["holding"], lastTouchedAt: c.updatedAt })),
  };
}

export function ActorSheet({
  open,
  boardRef,
  name,
  seed,
  onClose,
  onBack,
  showBack,
  swap,
  renderCard,
}: {
  open: boolean;
  /** Board slug or id, whichever the route carries — the API takes either. */
  boardRef: string;
  name: string;
  seed: ActorSeed;
  onClose: () => void;
  /**
   * Back to the roster this actor was reached from (#31).
   */
  onBack: () => void;
  /**
   * Whether the control above is worth showing at all. A roster row is a real "I came from
   * the list", and so is a `#/b/<slug>/a/<name>` deep link — that reader has not seen the
   * list, which is the best reason of all to show them the way to it. An avatar tapped from
   * a card, the header stack, a thread bubble or any other in-app view has nowhere it needs
   * the roster to be — offering a way to a list the reader never opened just reads as a
   * stray button, so this stays false for that path.
   */
  showBack: boolean;
  /** Replacing the roster in the same rect: crossfade rather than slide (see `Sheet`). */
  swap?: boolean;
  /** The board's own card row, so this list is the list, not a copy of it. */
  renderCard: (card: ActorCard) => ReactNode;
}) {
  // Seeded synchronously, so an actor whose cards are already on screen opens on them.
  const [profile, setProfile] = useState<FullProfile | null>(() => (open ? seedProfile(name, seed) : null));
  const [err, setErr] = useState<string | null>(null);

  // Card 100: pulled out of the mount effect below so the live-poll interval can call the
  // same fetch without also resetting `profile` back to the seed on every tick the way the
  // mount effect does — that reset is only right the moment the sheet opens or the actor it
  // names changes, never on a routine refresh of an already-loaded profile. `currentKey`
  // stands in for the old effect's `cancelled` flag: a poll in flight when the sheet is
  // reopened on a different actor must not paint that actor's profile over the new one.
  const currentKey = useRef(`${boardRef}:${name}`);
  useEffect(() => {
    currentKey.current = `${boardRef}:${name}`;
  }, [boardRef, name]);
  const fetchProfile = useCallback(() => {
    const key = `${boardRef}:${name}`;
    api
      .actorProfile(boardRef, name)
      .then((p) => {
        if (currentKey.current === key) setProfile(p);
      })
      .catch((e: Error) => {
        if (currentKey.current === key) setErr(e.message);
      });
  }, [boardRef, name]);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setProfile(seedProfile(name, seed));
    fetchProfile();
    // `seed` is a fresh object every render of the board; the actor and the board are what
    // actually decide whose profile this is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, boardRef, name]);

  // While the sheet is open on an actor with a session still running or idle, keep its
  // cost/context/tool/liveness readings moving on their own (card 100) — the same signal and
  // interval the card page's Run block polls on, just keyed off the session's own liveness
  // rather than a card status, since one actor's sessions span many cards. `nowMs` drives the
  // strip's own duration count-up and "last heard" text the same way the card page's clock
  // does; both go still the moment nothing here is live any more, or the sheet closes.
  const live = open && hasLiveSession(profile?.telemetry ?? []);
  const nowMs = useNow(live);
  useLivePoll(live, fetchProfile);

  const groups = groupActorCards(profile?.cards ?? []);
  const kind = profile?.kind ?? "agent";
  // A role every one of their cards carries is no reason for any one of them to be in the
  // list (#31): conductor created all 26, so 26 rows read "created" and said nothing.
  const everywhere = sharedRoles(profile?.cards ?? []);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      tall
      className="actor-sheet side-panel"
      title={name}
      lead={showBack ? <SheetBack label="Team" onClick={onBack} /> : undefined}
      swap={swap}
    >
      {/* The name is the sheet's own title; this line is everything else known about them. */}
      <div className="actor-head">
        <Avatar name={name} kind={kind} size={44} plain />
        {/* Nothing is asserted about someone the board turns out not to know: the error
            speaks below instead. */}
        <div className="actor-meta muted small">
          {profile ? kind : ""}
          {profile?.model && <RuntimeTag harness={profile.harness} model={profile.model} effort={profile.effort} />}
          {profile?.lastSeen ? ` · last ${shortAge(profile.lastSeen)}` : ""}
          {profile && profile.events > 0 ? ` · ${profile.events} ${profile.events === 1 ? "write" : "writes"}` : ""}
        </div>
      </div>

      {profile?.telemetry && profile.telemetry.length > 0 && profile.totals && (
        <ActorTelemetryStrip telemetry={profile.telemetry} totals={profile.totals} nowMs={nowMs} />
      )}

      {err && !profile && <p className="muted">{err}</p>}
      {!err && !profile && <ActorSkeleton />}
      {profile &&
        GROUPS.map(({ key, label }) =>
          groups[key].length === 0 ? null : (
            <section className="section actor-section" key={key}>
              <div className="section-head">
                <h2>{label}</h2>
                <span className="section-count">{groups[key].length}</span>
              </div>
              <div className="list">
                {groups[key].map((c) => {
                  const why = rolesCaption(c.roles, everywhere);
                  return (
                    <div className="actor-card" key={c.num}>
                      {renderCard(c)}
                      {why && <span className="actor-why muted">{why}</span>}
                    </div>
                  );
                })}
              </div>
            </section>
          ),
        )}
      {profile && profile.cards.length === 0 && <p className="muted">{EMPTY_TEXT}</p>}
    </Sheet>
  );
}

/** Only for an actor the board snapshot knew nothing about: the head is already drawn. */
function ActorSkeleton() {
  return (
    <section className="section sk" aria-hidden>
      <div className="section-head"><span className="sk-line sk-head" style={{ ["--sk-w" as string]: "46px" }} /></div>
      <div className="list">
        {["78%", "56%", "88%"].map((w) => (
          <div className="list-row card-row sk-row" key={w}>
            <div className="card-row-line"><div className="list-title"><span className="sk-line" style={{ ["--sk-w" as string]: w }} /></div></div>
            <span className="sk-line sk-side" style={{ ["--sk-w" as string]: "22px" }} />
          </div>
        ))}
      </div>
    </section>
  );
}
