/** Run the API server (with reload) and the Vite dev server together. */
const root = import.meta.dir + "/..";
const port = process.env.FLOCK_PORT ?? "4747";
const env = { ...process.env, FLOCK_PORT: port };

const api = Bun.spawn(["bun", "--watch", "packages/cli/src/main.ts", "serve", "--port", port], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
const web = Bun.spawn(["bun", "run", "--cwd", "packages/web", "dev", "--open"], { cwd: root, env, stdout: "inherit", stderr: "inherit" });

const stop = () => {
  api.kill();
  web.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([api.exited, web.exited]);
stop();
