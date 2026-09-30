import { configDefaults, defineConfig } from "vitest/config";

// docs/audits/ keeps VERBATIM copies of audit artefacts, including a mutation-harness
// killer test that only runs inside its own snapshot sandbox — never collect it.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "docs/**"],
  },
});
