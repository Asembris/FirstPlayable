/**
 * The trusted offline player, as it runs from `file://`.
 *
 * This file is the *source* of the bundled script an exported HTML file carries.
 * It is bundled at build time by `scripts/build-export-runtime.ts`, and the
 * bundle is committed so a deployment serves exactly the reviewed bytes.
 *
 * Three properties are load-bearing, and all three are visible here:
 *
 *   * **No network, ever.** There is no `fetch`, no `XMLHttpRequest`, no
 *     `import()`, no image, no font, and no stylesheet from anywhere. The scene
 *     arrives as inert base64 in the same file. A test asserts the bundle
 *     contains none of those identifiers.
 *   * **No generated code.** Nothing here evaluates a string, and the bundle is
 *     built from the engine and this file alone — not from the Zod contract,
 *     whose fast path constructs functions at runtime. The load check is
 *     `src/export/guard.ts`.
 *   * **The same engine.** `initialState`, `availableActions`, `step`, and
 *     `speakerLabel` are imported from `src/engine/interpreter.ts`: the exact
 *     module the server validated the scene with and the studio plays it with.
 *     There is no second interpreter in this repository.
 *
 * Every string the scene carries reaches the page through `textContent` or
 * `createTextNode`. Nothing is assigned to `innerHTML`, so a scene containing
 * `</script>`, an event-handler attribute, or a URL renders as the characters it
 * is made of.
 */

import type { Id, Scene } from "../domain/scene";
import type { State } from "../engine/interpreter";
import {
  availableActions,
  initialState,
  speakerLabel,
  step,
} from "../engine/interpreter";
import { loadOfflinePlayable, type LoadedPlayable } from "./guard";

/** The element ids the HTML template provides. Nothing else is touched. */
const DATA_ID = "fp-data";
const ROOT_ID = "fp-root";

declare const atob: (value: string) => string;

function decodeDataBlock(raw: string): unknown {
  // base64 of UTF-8 JSON. Encoding the data this way is what makes it
  // impossible for a scene string to terminate the script element it sits in.
  const binary = atob(raw.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function element(
  tag: string,
  className: string | null,
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  if (className !== null) node.className = className;
  // textContent, never innerHTML. This is the whole XSS answer.
  if (text !== undefined) node.textContent = text;
  return node;
}

type Entry =
  | { kind: "choice"; label: string }
  | { kind: "line"; speaker: string; text: string }
  | { kind: "blocked"; text: string };

function render(root: HTMLElement, playable: LoadedPlayable): void {
  const scene: Scene = playable.scene;
  let state: State = initialState(scene);
  let transcript: Entry[] = [];
  let endingId: Id | null = null;

  const header = element("header", "fp-header");
  header.append(element("h1", "fp-title", playable.title));
  header.append(
    element(
      "p",
      "fp-meta",
      `Offline playable · version ${playable.versionId} · exported ${playable.exportedAt}`,
    ),
  );
  header.append(
    element(
      "p",
      "fp-meta",
      "This file plays entirely in your browser. It makes no network request and needs no account.",
    ),
  );
  root.append(header);

  const stage = element("main", "fp-stage");
  root.append(stage);

  const draw = (): void => {
    stage.replaceChildren();

    const room = element("section", "fp-room");
    room.append(element("h2", "fp-room-name", scene.world.room.name));
    room.append(element("p", "fp-room-text", scene.world.room.description));
    const npc = scene.world.characters[0];
    room.append(
      element(
        "p",
        "fp-room-text",
        `You are the ${scene.world.player_role.toLowerCase()}. ${npc.name} — ${npc.role.toLowerCase()}.`,
      ),
    );
    stage.append(room);

    const object = element("section", "fp-object");
    object.append(element("h3", "fp-object-name", scene.world.object.name));
    object.append(element("p", "fp-room-text", scene.world.object.description));
    stage.append(object);

    const log = element("ol", "fp-transcript");
    for (const entry of transcript) {
      if (entry.kind === "choice") {
        log.append(element("li", "fp-choice-made", `> ${entry.label}`));
      } else if (entry.kind === "blocked") {
        log.append(element("li", "fp-blocked", entry.text));
      } else {
        const item = element("li", "fp-line");
        item.append(element("span", "fp-speaker", entry.speaker));
        item.append(element("p", "fp-line-text", entry.text));
        log.append(item);
      }
    }
    stage.append(log);

    if (endingId !== null) {
      const ending =
        scene.core.endings.find((candidate) => candidate.id === endingId) ?? null;
      const closed = element("section", "fp-ending");
      closed.append(element("h3", "fp-ending-title", ending?.title ?? "The end"));
      closed.append(element("p", "fp-line-text", endingText(scene, endingId)));
      const again = element("button", "fp-button fp-button-primary", "Play it again");
      again.setAttribute("type", "button");
      again.addEventListener("click", () => {
        state = initialState(scene);
        transcript = [];
        endingId = null;
        draw();
      });
      closed.append(again);
      stage.append(closed);
    } else {
      const choices = element("section", "fp-choices");
      choices.append(element("h3", "fp-choices-heading", "What do you do?"));
      const offered = availableActions(scene, state);
      if (offered.length === 0) {
        choices.append(element("p", "fp-line-text", "Nothing is left to do here."));
      }
      for (const choice of offered) {
        const button = element(
          "button",
          choice.enabled ? "fp-button fp-choice" : "fp-button fp-choice fp-choice-locked",
        );
        button.setAttribute("type", "button");
        button.append(document.createTextNode(choice.label));
        if (choice.blocked !== null) {
          button.append(element("span", "fp-choice-reason", choice.blocked.text));
        }
        if (!choice.enabled) button.setAttribute("disabled", "disabled");
        button.addEventListener("click", () => {
          take(choice.action_id, choice.label);
        });
        choices.append(button);
      }
      const restart = element("button", "fp-button", "Start over");
      restart.setAttribute("type", "button");
      restart.addEventListener("click", () => {
        state = initialState(scene);
        transcript = [];
        endingId = null;
        draw();
      });
      choices.append(restart);
      stage.append(choices);
    }

    if (playable.provenance.length > 0) {
      const details = document.createElement("details");
      details.className = "fp-provenance";
      const summary = document.createElement("summary");
      summary.textContent = "Where these ideas came from";
      details.append(summary);
      for (const line of playable.provenance) {
        const block = element("div", "fp-provenance-line");
        block.append(
          element(
            "p",
            "fp-meta",
            line.referenceName === null
              ? line.slot
              : `${line.slot} · ${line.referenceName}${line.domain === null ? "" : ` (${line.domain})`}`,
          ),
        );
        if (line.proposed !== null) {
          block.append(
            element("p", "fp-line-text", `Proposed interpretation: ${line.proposed}`),
          );
        }
        block.append(
          element(
            "p",
            "fp-line-text",
            `Approved by the creator${line.editedByCreator ? " (edited)" : ""}: ${line.approvedText}`,
          ),
        );
        if (line.sceneChanged !== null) {
          block.append(element("p", "fp-line-text", line.sceneChanged));
        }
        details.append(block);
      }
      details.append(
        element(
          "p",
          "fp-meta",
          "Each line records retrieval, interpretation, the creator's decision, and what the engine observed. It is not a claim that this mechanic could only have been reached this way.",
        ),
      );
      stage.append(details);
    }

    const footer = element("footer", "fp-footer");
    footer.append(
      element(
        "p",
        "fp-meta",
        `Validated before export by ${playable.identifiers.validator ?? "the shared engine"}.`,
      ),
    );
    stage.append(footer);
  };

  const take = (actionId: Id, label: string): void => {
    const result = step(scene, state, actionId);
    if (!result.ok) {
      transcript = [...transcript, { kind: "blocked", text: result.message }];
      draw();
      return;
    }
    const added: Entry[] = [{ kind: "choice", label }];
    for (const line of result.dialogue) {
      added.push({
        kind: "line",
        speaker: speakerLabel(scene, line.speaker_id),
        text: line.text,
      });
    }
    state = result.state;
    transcript = [...transcript, ...added];
    endingId = result.ending === null ? null : result.ending.id;
    draw();
  };

  draw();
}

/** The composed ending text, including a creator wording override. */
function endingText(scene: Scene, endingId: Id): string {
  const override = scene.ending_copy_overrides.find(
    (candidate) => candidate.ending_id === endingId,
  );
  if (override !== undefined) return override.text;
  return scene.core.endings.find((candidate) => candidate.id === endingId)?.text ?? "";
}

function fail(root: HTMLElement, reason: string): void {
  root.replaceChildren();
  root.append(element("h1", "fp-title", "This playable could not be loaded"));
  root.append(element("p", "fp-line-text", reason));
  root.append(
    element(
      "p",
      "fp-meta",
      "Nothing was run. This file carries its scene inside itself, so a failure here means the file itself is damaged or was made for another version.",
    ),
  );
}

export function start(): void {
  const root = document.getElementById(ROOT_ID);
  if (root === null) return;
  const block = document.getElementById(DATA_ID);
  if (block === null) {
    fail(root, "The embedded playable is missing.");
    return;
  }
  let decoded: unknown;
  try {
    decoded = decodeDataBlock(block.textContent ?? "");
  } catch {
    fail(root, "The embedded playable could not be decoded.");
    return;
  }
  const loaded = loadOfflinePlayable(decoded);
  if (!loaded.ok) {
    fail(root, `The embedded playable did not pass its load check: ${loaded.reason}.`);
    return;
  }
  try {
    render(root, loaded.playable);
  } catch {
    fail(root, "The embedded playable could not be rendered.");
  }
}

start();
