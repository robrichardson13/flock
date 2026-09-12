/** A registry of `HarnessReader`s keyed by the family they own. Adding a harness (Codex) is one
 * file plus one `register` call here — nothing else in the CLI or server names a reader. */
import { familyOf, type HarnessReader, type RunHint } from "./reader.ts";

export interface HarnessRegistry {
  register(reader: HarnessReader): void;
  /** The reader for a family name ("claude-code") or a full run key ("claude-code:<uuid>"). */
  readerFor(familyOrKey: string): HarnessReader | undefined;
  /** The reader that owns `hint.key`'s family, or undefined for an unregistered/unknown harness. */
  readerForHint(hint: RunHint): HarnessReader | undefined;
  readonly families: readonly string[];
}

export function createRegistry(readers: HarnessReader[] = []): HarnessRegistry {
  const byFamily = new Map<string, HarnessReader>();
  const register = (reader: HarnessReader): void => {
    byFamily.set(reader.family, reader);
  };
  for (const r of readers) register(r);

  return {
    register,
    readerFor: (familyOrKey) => byFamily.get(familyOf(familyOrKey)),
    readerForHint: (hint) => byFamily.get(familyOf(hint.key)),
    get families() {
      return [...byFamily.keys()];
    },
  };
}
