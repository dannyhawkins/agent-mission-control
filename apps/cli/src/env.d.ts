// `import x from "./file.md" with { type: "text" }` inlines the file as a string (bundled into amc).
declare module "*.md" {
  const text: string;
  export default text;
}
