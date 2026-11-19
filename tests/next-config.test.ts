import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

// Regression guard for privacy-relevant Next.js settings (N1). The network
// behaviour itself was measured with a logging proxy (docs/PROGRESS.md); this
// test only stops the settings from being removed or changed by accident.
describe("next.config.ts privacy settings", () => {
  it("disables the automatic agent upgrade check (no registry query on build/dev)", () => {
    expect(nextConfig.experimental?.agentUpgrade).toBe(false);
  });

  it("does not print Server Function calls and their arguments in `next dev` (M2.3)", () => {
    expect(nextConfig.logging).not.toBe(false);
    expect(typeof nextConfig.logging === "object" && nextConfig.logging.serverFunctions).toBe(false);
  });

  it("keeps the existing settings", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.agentRules).toBe(false);
    expect(typeof nextConfig.headers).toBe("function");
  });
});
