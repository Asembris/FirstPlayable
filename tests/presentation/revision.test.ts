import { describe, expect, it } from "vitest";
import withMoonJson from "../../docs/phase6-canonical-pair/with-moon.version.json";
import withoutMoonJson from "../../docs/phase6-canonical-pair/without-moon.version.json";
import { parseScene } from "../../src/domain/scene";
import {
  actionLabelIn,
  humanizeSummary,
  humanizeSummaryLine,
  labelActionIds,
  REVISION_LABEL_TEXT,
} from "../../src/presentation/revision";

/**
 * The revision summary in the creator's words, against the real stored
 * removal of Moon. The stored lines are the engine's; only their reading
 * changes, and a line the reader does not recognise is shown as stored.
 */

const withScene = parseScene(withMoonJson.scene);
const withoutScene = parseScene(withoutMoonJson.scene);
const scenes = [withoutScene, withScene];
const stored = withoutMoonJson.revision_diff.summary;

describe("the stored Moon removal, read for the creator", () => {
  it("names every changed action by its stored label, never by id", () => {
    const lines = humanizeSummary(stored, scenes);
    expect(lines).toEqual([
      "Interaction changed: after the same choices, “Return the letter” was locked and is now open.",
      "Interaction changed: after the same choices, “Ask Nia who the other name belongs to” was open and is now not offered.",
      "Interaction changed: after the same choices, “Examine the envelope closely” was open and is now not offered.",
    ]);
    for (const line of lines) expect(line).not.toMatch(/core\.|discovery\./);
  });

  it("keeps the stored direction: the revised version first, then the new one", () => {
    expect(actionLabelIn(scenes, "core.give")).toBe("Return the letter");
    expect(stored[0]).toContain("is locked before and enabled after");
    expect(humanizeSummaryLine(stored[0]!, scenes)).toContain("was locked and is now open");
  });
});

describe("other stored lines", () => {
  it("reads an explicit prefix as the actions' labels", () => {
    const line =
      'Interaction changed: after the choices core.ask_context -> core.inspect, "core.give" is enabled before and locked after.';
    expect(humanizeSummaryLine(line, scenes)).toBe(
      "Interaction changed: after “Ask Nia why she needs it back” → “Examine the letter”, “Return the letter” was open and is now locked.",
    );
  });

  it("names the fixed details instead of world, core, and ports, and keeps CHANGED loud", () => {
    expect(
      humanizeSummaryLine(
        "Fixed details preserved: world unchanged, core unchanged, ports unchanged.",
        scenes,
      ),
    ).toBe(
      "Fixed details preserved: the room, the people, and the object unchanged; the scene's own choices and endings unchanged; where influences attach unchanged.",
    );
    expect(
      humanizeSummaryLine(
        "Fixed details preserved: world unchanged, core CHANGED, ports unchanged.",
        scenes,
      ),
    ).toContain("the scene's own choices and endings CHANGED");
  });

  it("names an edited ending by its title", () => {
    const ending = withScene.core.endings[0]!;
    expect(humanizeSummaryLine(`Ending wording edited: ${ending.id}.`, scenes)).toBe(
      `Ending wording edited: “${ending.title}”.`,
    );
  });

  it("shows an unrecognised line, or an unknown id, exactly as stored", () => {
    const odd = "Outcome availability changed: after no choices, reachable endings go from a to b.";
    expect(humanizeSummaryLine(odd, scenes)).toBe(odd);
    expect(
      humanizeSummaryLine(
        'Interaction changed: after the same choices, "nowhere.x" is enabled before and hidden after.',
        scenes,
      ),
    ).toContain('"nowhere.x"');
  });
});

describe("the label", () => {
  it("keeps the engine's verdict words", () => {
    expect(REVISION_LABEL_TEXT.mechanical).toMatch(/^Mechanical change/);
    expect(REVISION_LABEL_TEXT.wording).toBe("Wording changed; interaction unchanged.");
    expect(REVISION_LABEL_TEXT.none).toBe("No change.");
  });
});

describe("a stored engine sentence", () => {
  it("reads quoted and bare action ids as labels, and nothing else", () => {
    expect(
      labelActionIds(
        'After core.ask_context then core.inspect, "core.give" is locked with the discovery influence and enabled without it.',
        [withScene],
      ),
    ).toBe(
      "After “Ask Nia why she needs it back” then “Examine the letter”, “Return the letter” is locked with the discovery influence and enabled without it.",
    );
    expect(labelActionIds("nothing to label here", [withScene])).toBe("nothing to label here");
  });
});
