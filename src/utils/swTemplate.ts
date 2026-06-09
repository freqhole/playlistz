// vite-only: re-exports generateSwJs with the ?raw import baked in at build time.
// do not import this from Node cli code - use the injected constant in src/cli/init.ts instead.
import swJsContent from "../../public/sw.js?raw";

export function generateSwJs(): string {
  return swJsContent;
}
