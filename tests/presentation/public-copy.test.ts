import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The README is the first thing a judge reads. These checks keep its Qloo
 * claim to what the workflow can show: Qloo supplies the artist-conditioned
 * references and their recorded evidence; it does not make references "real",
 * generate the mechanic, or prove the scene better.
 */

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README judge-facing claims", () => {
  it("leads with the synthetic Lanternfold → Qloo → Halcyon Relay example and the direct comparison", () => {
    expect(readme).toContain("Lanternfold → Qloo → Halcyon Relay");
    expect(readme).toContain("not a Qloo response");
    expect(readme).toContain("https://firstplayable.vercel.app/difference?view=compare");
    const example = readme.indexOf("Lanternfold → Qloo → Halcyon Relay");
    expect(example).toBeLessThan(readme.indexOf("## Verification and production evidence"));
    expect(example).toBeLessThan(readme.indexOf("## Architecture"));
  });

  it("states the narrow division of responsibility between Qloo and FirstPlayable", () => {
    expect(readme).toContain("Qloo helps determine which cultural material enters the experiment.");
    expect(readme).toContain(
      "FirstPlayable helps the creator interpret it, make it playable, and decide what\nto keep.",
    );
  });

  it("does not overclaim what removing Qloo, or the comparison, would show", () => {
    expect(readme).not.toMatch(/stop being real/i);
    expect(readme).not.toMatch(/Qloo is load-bearing/i);
  });
});
