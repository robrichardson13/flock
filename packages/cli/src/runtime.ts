/**
 * What the CLI knows about how it is running: from a checkout, or from a `bun build --compile`
 * binary that has the whole Bun runtime and the web app baked into it.
 */

// Embeds scripts/install.sh and skills/flock/SKILL.md into a compiled binary the same way
// assets.generated.ts embeds the web dist: `with { type: "file" }` makes the bundler carry the
// file along and hands back the path it lives at, which inside a binary is somewhere under the
// virtual `/$bunfs` filesystem. Both files are committed, so a plain static import works — no
// generated manifest needed.
import installScriptFile from "../../../scripts/install.sh" with { type: "file" };
import skillFile from "../../../skills/flock/SKILL.md" with { type: "file" };

/** Injected at build time with `bun build --define FLOCK_VERSION='"1.2.3"'`. Absent in a checkout. */
declare const FLOCK_VERSION: string | undefined;

/**
 * True inside a single-file executable.
 *
 * `Bun.isStandaloneExecutable` is documented but does not exist on the pinned Bun 1.3.4 — it reads
 * `undefined` both in the runtime and inside a compiled binary. So prefer it when a later Bun
 * defines it, and otherwise detect the virtual filesystem a standalone binary runs its modules from.
 */
export function isStandalone(): boolean {
  const flag = (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable;
  if (typeof flag === "boolean") return flag;
  return import.meta.dir.startsWith("/$bunfs") || import.meta.dir.startsWith("B:\\~BUN");
}

/** The released version, or `dev` when running from source — which is the point of printing it. */
export function version(): string {
  return typeof FLOCK_VERSION === "string" ? FLOCK_VERSION : "dev";
}

/** e.g. `flock 0.2.0 (bun-darwin-arm64, bun 1.3.4)`. The triple matches the release asset names. */
export function versionLine(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `flock ${version()} (bun-${os}-${process.arch}, bun ${Bun.version})`;
}

/**
 * The embedded web app, when there is one: request path to the file's location inside the binary.
 *
 * `scripts/gen-assets.ts` writes `assets.generated.ts`, which is build output and not committed, so
 * a plain checkout has no such module and falls back to serving `packages/web/dist` off disk.
 */
export async function embeddedAssets(): Promise<Record<string, string> | undefined> {
  try {
    const mod = await import("./assets.generated.ts");
    return mod.ASSETS;
  } catch {
    return undefined;
  }
}

/**
 * Path to the installer script, valid in both a checkout and a compiled binary. Passed to
 * `createApp` so `GET /install.sh` never has to resolve `scripts/` relative to `import.meta.dir`,
 * which points into `/$bunfs` at nothing inside a binary.
 */
export const installScriptPath: string = installScriptFile;

/** Path to the embedded Claude Code skill, valid in both a checkout and a compiled binary. */
export const skillPath: string = skillFile;
