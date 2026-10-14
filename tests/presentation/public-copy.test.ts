import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The README is the first thing a judge reads. These checks keep it on the
 * audience comp audition, keep the three ways in — recorded Qloo evidence,
 * the invented record, and the live workflow — distinct from each other, and
 * keep its Qloo and decision claims to what the code computes.
 */

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README judge-facing claims", () => {
  it("leads with the audition tagline and its recorded, synthetic and live links", () => {
    expect(readme).toContain("Choose the comps. Switch the audience. See what changes.");
    expect(readme).toContain("https://firstplayable.vercel.app/audition");
    expect(readme).toContain("https://firstplayable.vercel.app/audition?mode=live");
    expect(readme).toContain("https://firstplayable.vercel.app/audition?mode=synthetic");
    expect(readme).toContain("docs/readme/audition-hero.png");
    expect(readme.indexOf("## The example")).toBeLessThan(readme.indexOf("## Architecture"));
  });

  it("presents the default example as real Qloo evidence replayed offline", () => {
    expect(readme).toContain("## Recorded demonstration vs live workflow");
    expect(readme).toMatch(/\*\*Real Qloo evidence\.\*\* Qloo's own entity ids/);
    expect(readme).toMatch(/\*\*Zero\.\*\* No session, database, Qloo or model call/);
    expect(readme).toContain("evidence/qloo/audition/");
    // The recorded run is one day's evidence, never a general preference claim.
    expect(readme).toMatch(/one bounded run on 7 October 2026/);
    expect(readme).toMatch(/not a general statement about those titles or artists/);
  });

  it("keeps the invented record distinct and still labelled as invented", () => {
    expect(readme).toMatch(/invented synthetic data, not Qloo\s+data/);
    expect(readme).toContain("fixtures/qloo/audition/");
    expect(readme).toMatch(/\*\*Synthetic\.\*\* Invented titles, artists, entity ids, affinities and timestamps/);
    // The default demo may never be described as synthetic.
    expect(readme).not.toMatch(/Saved example · synthetic demonstration data/);
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
