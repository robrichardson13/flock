#!/usr/bin/env bun
/**
 * Build every flock release artifact: the web app, the embedded-asset manifest, then one
 * `bun build --compile` binary per target, tarballed with a sha256 alongside it.
 *
 * Usage:
 *   bun run scripts/build-release.ts --version 0.2.0 [--targets bun-darwin-arm64,bun-linux-x64] [--out dist]
 *
 * `--version` is required (bare, no leading "v" — strip a tag's "v" before calling this).
 * `--targets` restricts the build to a comma-separated subset, default is all six; useful for a
 * fast local smoke build. `--out` defaults to `dist/` at the repo root, which is gitignored.
 *
 * The asset name is the installer's contract: `flock-bun-<os>-<arch>[-musl].tar.gz`. Do not change
 * the naming scheme here without updating scripts/install.sh (card E) and .github/workflows/release.yml.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

// target -> asset name suffix. Six targets per ADR 0012: no Windows.
const ALL_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
] as const;

function assetName(target: string): string {
  // bun-linux-x64        -> flock-bun-linux-x64
  // bun-linux-x64-musl   -> flock-bun-linux-x64-musl
  return `flock-${target}`;
}

function parseArgs(argv: string[]) {
  let version: string | undefined;
  let targets: string[] = [...ALL_TARGETS];
  let outdir = join(repoRoot, "dist");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") version = argv[++i];
    else if (a === "--targets") targets = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--out" || a === "--outdir") outdir = resolve(argv[++i] ?? outdir);
    else {
      console.error(`build-release: unknown argument ${a}`);
      process.exit(1);
    }
  }
  if (!version) {
    console.error("build-release: --version <x.y.z> is required");
    process.exit(1);
  }
  for (const t of targets) {
    if (!(ALL_TARGETS as readonly string[]).includes(t)) {
      console.error(`build-release: unknown target ${t}`);
      process.exit(1);
    }
  }
  return { version, targets, outdir };
}

function run(cmd: string[], opts: { cwd?: string } = {}) {
  console.error(`$ ${cmd.join(" ")}`);
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? repoRoot,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error(`build-release: command failed (exit ${res.status}): ${cmd.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

/** Is `cmd` on PATH? Used to decide whether we can ad-hoc sign a darwin binary locally. */
function has(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

/**
 * Ad-hoc sign a compiled darwin binary, and verify the signature.
 *
 * `bun build --compile --target=bun-darwin-*` appends the payload to a prebuilt, already-signed
 * bun, which invalidates that signature. On macOS the linker re-signs the result; on any other
 * host it cannot, and Apple Silicon SIGKILLs a binary whose signature is present but broken. So
 * the darwin targets must be built on a macOS runner, and signed here (`codesign -s -`) so a local
 * release build behaves exactly like CI's. Silently skipped off darwin — the workflow builds the
 * darwin targets on macOS, and this keeps a Linux-hosted build of them from failing outright.
 */
function codesignDarwin(target: string, binary: string) {
  if (!target.startsWith("bun-darwin-")) return;
  if (process.platform !== "darwin") {
    console.error(`build-release: not on darwin, skipping codesign of ${target} (this binary will NOT run on macOS)`);
    return;
  }
  if (!has("codesign")) {
    console.error(`build-release: codesign not found on PATH, skipping ${target}`);
    return;
  }
  run(["codesign", "--force", "--sign", "-", binary]);
  run(["codesign", "--verify", "--strict", binary]);
}

async function main() {
  const { version, targets, outdir } = parseArgs(process.argv.slice(2));

  mkdirSync(outdir, { recursive: true });

  console.error(`build-release: building version ${version} for ${targets.length} target(s)`);

  // 1. Vite build, then the embedded-asset manifest (must run after every vite build — Vite hashes
  //    its own output filenames on each run). `bun run build` at the repo root does exactly this.
  run(["bun", "run", "build"]);

  const entry = join(repoRoot, "packages/cli/src/main.ts");

  for (const target of targets) {
    const name = assetName(target);
    const binName = name;
    const outfile = join(outdir, binName);

    console.error(`\nbuild-release: compiling ${target}`);
    const res = spawnSync(
      "bun",
      [
        "build",
        "--compile",
        "--minify",
        `--target=${target}`,
        "--define",
        // spawnSync passes argv directly with no shell, so no shell-quoting is needed (or wanted)
        // here — the value bun build --define expects is a JSON literal, i.e. a double-quoted string.
        `FLOCK_VERSION="${version}"`,
        entry,
        "--outfile",
        outfile,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (res.status !== 0) {
      console.error(`build-release: compile failed for ${target} (exit ${res.status})`);
      process.exit(res.status ?? 1);
    }

    codesignDarwin(target, outfile);

    // Tarball. tar's -C plus a bare filename keeps the archive member name flat (no leading path
    // component), matching what the installer expects to find with `find -maxdepth 1`.
    const tarball = `${name}.tar.gz`;
    run(["tar", "-czf", tarball, binName], { cwd: outdir });

    // sha256, written as "<hash>  <asset>.tar.gz" so `grep " $asset\$"` in install.sh finds it,
    // and matching shasum's own two-space output format.
    const shaRes = spawnSync("shasum", ["-a", "256", tarball], { cwd: outdir, encoding: "utf8" });
    const sha =
      shaRes.status === 0
        ? shaRes.stdout
        : (() => {
            const alt = spawnSync("sha256sum", [tarball], { cwd: outdir, encoding: "utf8" });
            if (alt.status !== 0) {
              console.error(`build-release: no shasum or sha256sum available to hash ${tarball}`);
              process.exit(1);
            }
            return alt.stdout;
          })();
    // Awaited: the summary listing below (and the workflow's upload step) reads the directory as
    // soon as this loop ends, and an in-flight write would not be there yet.
    await Bun.write(join(outdir, `${tarball}.sha256`), sha);

    // The bare binary is only needed to build the tarball; remove it so dist/ holds only the
    // release artifacts (tarball + sha256), matching what actually ships.
    rmSync(outfile);

    console.error(`build-release: wrote ${tarball} and ${tarball}.sha256`);
  }

  const produced = readdirSync(outdir).sort();
  console.error(`\nbuild-release: done. ${outdir} contains:`);
  for (const f of produced) console.error(`  ${f}`);
}

main();
