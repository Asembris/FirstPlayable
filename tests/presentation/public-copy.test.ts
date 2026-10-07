import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The README is the first thing a judge reads. These checks keep it on the
 * audience comp audition, keep the saved synthetic example distinct from the
 * live Qloo workflow, and keep its Qloo and decision claims to what the code
 * computes.
 */

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README judge-facing claims", () => {
  it("leads with the audition tagline and its saved and live links", () => {
    expect(readme).toContain("Choose the comps. Switch the audience. See what changes.");
    expect(readme).toContain("https://firstplayable.vercel.app/audition");
    expect(readme).toContain("https://firstplayable.vercel.app/audition?mode=live");
    expect(readme).toContain("docs/readme/audition-hero.png");
    expect(readme.indexOf("## The example")).toBeLessThan(readme.indexOf("## Architecture"));
  });

  it("keeps the saved synthetic example distinct from the live Qloo workflow", () => {
    expect(readme).toMatch(/invented synthetic data, not Qloo data/);
    expect(readme).toContain("## Saved demonstration vs live workflow");
    expect(readme).toMatch(/\*\*Zero\.\*\* No session, database, Qloo or model call/);
  });

  it("names 0.03 as a product convention and keeps the model out of the decision", () => {
    expect(readme).toContain("**product convention**");
    expect(readme).toMatch(/not statistical significance/);
    expect(readme).toMatch(/See an affinity, score, rank or pick a winner/);
  });

  it("drops the earlier product's positioning and overclaims", () => {
    expect(readme).not.toContain("Choose the influences. Play the consequences.");
    expect(readme).not.toMatch(/affinity is kept private/i);
    expect(readme).not.toMatch(/Qloo recommends|statistically significant|Qloo is load-bearing/i);
  });
});
