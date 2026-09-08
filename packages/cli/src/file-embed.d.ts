// `with { type: "file" }` imports (see runtime.ts's `installScriptPath` and `skillPath`) resolve
// at runtime to a string path; tsc has no built-in type for a `.sh` or `.md` module specifier.
declare module "*.sh" {
  const path: string;
  export default path;
}

declare module "*.md" {
  const path: string;
  export default path;
}
