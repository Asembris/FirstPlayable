/**
 * Fixture verification. Runs the real engine over every Phase 1 fixture and
 * prints the evidence recorded in docs/BUILD_STATUS.md. Exits non-zero on any
 * failure, so it is usable as a gate.
 *
 * No network, no database, no provider. Run with: npm run check:fixtures
 */

import {
  APPROVED_APPROVAL_IDS,
  CANONICAL_REPLAY_PREFIX,
  SECOND_COPY_BASE,
  SECOND_COPY_BRIEF,
  SECOND_COPY_DISCOVERY_V1,
  SECOND_COPY_DISCOVERY_V2,
  SECOND_COPY_VERSIONS,
} from "../fixtures/second-copy";
import type { Scene } from "../src/domain/scene";
import { cleanBase, removeModule } from "../src/engine/compose";
import {
  compareVersions,
  mechanicalSignature,
  observeReplayPrefix,
  sceneHashes,
} from "../src/engine/diff";
import { canonicalJson, hashCanonical } from "../src/engine/hash";
import {
  describeFindings,
  validateScene,
  validateSceneSubsets,
} from "../src/engine/validate";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail === "" ? "" : `\n      ${detail}`}`);
}

function withoutSceneId(scene: Scene): string {
  const { scene_id: _sceneId, ...rest } = scene;
  return canonicalJson(rest);
}

console.log("FirstPlayable — Phase 1 fixture verification");
console.log(`Node ${process.version}\n`);

/* ---------------------------------------------- per-version validation */

for (const version of SECOND_COPY_VERSIONS) {
  const report = validateScene(version.scene, SECOND_COPY_BRIEF, {
    approvedApprovalIds: APPROVED_APPROVAL_IDS,
  });
  check(
    `${version.key} (${version.scene.scene_id}) validates`,
    report.ok,
    report.ok ? "" : describeFindings(report),
  );
  const graph = report.graph;
  if (graph === null) continue;
  console.log(
    `      reachable nonterminal states: ${graph.reachable_nonterminal_states}` +
      `  edges: ${graph.edges}` +
      `  longest run: ${graph.max_actions_in_a_run} actions`,
  );
  console.log(
    `      reachable endings: ${graph.reachable_endings.join(", ")}` +
      `  minimum actions: ${JSON.stringify(graph.min_actions_to_ending)}`,
  );
  console.log(
    `      ending-closing nonterminal edges: ${graph.ending_closing_edges}` +
      `  consequential edges: ${graph.consequential_edges}`,
  );
  check(
    `${version.key} reaches all three endings`,
    graph.reachable_endings.length === 3,
    graph.reachable_endings.join(", "),
  );
  for (const [slot, witness] of Object.entries(report.module_witnesses)) {
    console.log(
      `      ${slot} mechanical witness: ${witness.mechanical ? "proven" : "NOT PROVEN"}` +
        ` after ${witness.pairs_explored} pairs` +
        (witness.overflow ? " (overflow)" : ""),
    );
  }
}

/* ------------------------------------------------------ module subsets */

for (const scene of [SECOND_COPY_DISCOVERY_V1, SECOND_COPY_DISCOVERY_V2]) {
  const subsets = validateSceneSubsets(scene, SECOND_COPY_BRIEF, {
    approvedApprovalIds: APPROVED_APPROVAL_IDS,
  });
  for (const entry of subsets.subsets) {
    const name = entry.slots.length === 0 ? "base" : entry.slots.join("+");
    check(
      `${scene.scene_id} subset [${name}] validates`,
      entry.report.ok,
      entry.report.ok ? "" : describeFindings(entry.report),
    );
  }
}

/* ------------------------------------------- world and core preservation */

const hashes = {
  base: sceneHashes(SECOND_COPY_BASE),
  v1: sceneHashes(SECOND_COPY_DISCOVERY_V1),
  v2: sceneHashes(SECOND_COPY_DISCOVERY_V2),
};
check(
  "world hash identical across base, v1, and v2",
  hashes.base.world === hashes.v1.world && hashes.v1.world === hashes.v2.world,
  hashes.v1.world,
);
check(
  "core hash identical across base, v1, and v2",
  hashes.base.core === hashes.v1.core && hashes.v1.core === hashes.v2.core,
  hashes.v1.core,
);
check(
  "ports hash identical across base, v1, and v2",
  hashes.base.ports === hashes.v1.ports && hashes.v1.ports === hashes.v2.ports,
  hashes.v1.ports,
);
check(
  "v1 and v2 Discovery modules genuinely differ",
  hashes.v1.modules.discovery !== hashes.v2.modules.discovery,
);

/* ------------------------------------------------------ module removal */

for (const [key, scene] of [
  ["v1", SECOND_COPY_DISCOVERY_V1],
  ["v2", SECOND_COPY_DISCOVERY_V2],
] as const) {
  const removed = removeModule(scene, "discovery");
  check(
    `removing Discovery from ${key} restores the clean base exactly (scene id aside)`,
    withoutSceneId(removed) === withoutSceneId(SECOND_COPY_BASE),
  );
  check(
    `cleanBase(${key}) leaves no influence or provenance record behind`,
    cleanBase(scene).influences.length === 0 && cleanBase(scene).provenance.length === 0,
  );
}

/* ---------------------------------------------- canonical same-prefix replay */

const replay = observeReplayPrefix(
  SECOND_COPY_DISCOVERY_V1,
  SECOND_COPY_DISCOVERY_V2,
  CANONICAL_REPLAY_PREFIX,
);
console.log(`\nCanonical replay prefix: ${CANONICAL_REPLAY_PREFIX.join(" -> ")}`);
console.log(`      v1 availability: ${JSON.stringify(replay.before)}`);
console.log(`      v2 availability: ${JSON.stringify(replay.after)}`);
check(
  "the prefix is legal in both versions",
  replay.prefix_legal_in_before && replay.prefix_legal_in_after,
);
check(
  "core.give is available in v1 after the prefix",
  replay.before["core.give"] === "enabled",
  String(replay.before["core.give"]),
);
check(
  "core.give is unavailable in v2 after the prefix",
  replay.after["core.give"] === "locked",
  String(replay.after["core.give"]),
);
check(
  "core.give is the only action whose availability changed",
  replay.changed_action_ids.length === 1 && replay.changed_action_ids[0] === "core.give",
  replay.changed_action_ids.join(", "),
);

/* -------------------------------------------------- v2 keeps end.give reachable */

const v2Report = validateScene(SECOND_COPY_DISCOVERY_V2, SECOND_COPY_BRIEF, {
  approvedApprovalIds: APPROVED_APPROVAL_IDS,
});
check(
  "end.give is still globally reachable in v2 before disclosure",
  (v2Report.graph?.reachable_endings ?? []).includes("end.give") &&
    v2Report.graph?.min_actions_to_ending["end.give"] === 3,
  `minimum actions to end.give: ${v2Report.graph?.min_actions_to_ending["end.give"]}`,
);

/* ---------------------------------------------------------- mechanical diff */

const diff = compareVersions(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_DISCOVERY_V2, {
  replayPrefix: CANONICAL_REPLAY_PREFIX,
});
check("v1 -> v2 is reported as a mechanical change", diff.mechanical_change);
check(
  "v1 -> v2 preserves world, core, and ports",
  diff.unchanged.world && diff.unchanged.core && diff.unchanged.ports,
);
for (const line of diff.summary) console.log(`      ${line}`);

const proseOnly: Scene = {
  ...SECOND_COPY_DISCOVERY_V1,
  scene_id: "fixture_second_copy_v1_prose",
  core: {
    ...SECOND_COPY_DISCOVERY_V1.core,
    endings: SECOND_COPY_DISCOVERY_V1.core.endings.map((ending) =>
      ending.id === "end.give"
        ? { ...ending, text: "Nia takes the letter, unopened. What happens next is hers." }
        : ending,
    ),
  },
};
const proseDiff = compareVersions(SECOND_COPY_DISCOVERY_V1, proseOnly);
check(
  "a prose-only edit is not classified as mechanical",
  !proseDiff.mechanical_change && proseDiff.wording_change_only,
  proseDiff.summary.join(" "),
);
check(
  "a prose-only edit leaves the mechanical signature identical",
  hashCanonical(mechanicalSignature(SECOND_COPY_DISCOVERY_V1)) ===
    hashCanonical(mechanicalSignature(proseOnly)),
);

/* --------------------------------------------------------- provenance honesty */

for (const version of SECOND_COPY_VERSIONS) {
  for (const influence of version.scene.influences) {
    check(
      `${version.key} influence "${influence.reference_id}" is still labelled design_fixture`,
      influence.source_kind === "design_fixture",
      influence.source_kind,
    );
  }
}

console.log(`\n${failures === 0 ? "All fixture checks passed." : `${failures} fixture check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
