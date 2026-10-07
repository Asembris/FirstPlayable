/**
 * "Why this changed": the four causal layers, each in its own material.
 *
 *   Source       Qloo returned        mono catalogue slip (the only boxed element)
 *   Suggestion   FirstPlayable proposed   italic serif, pencil, dashed underline
 *   Decision     the creator approved     upright serif ink with a left rule
 *   Consequence  the scene changed        revision stock
 *
 * Every string is a stored field of the canonical pair or derived from the
 * stored witness by the presentation model. No identifier, hash, or validator
 * sentence is shown.
 *
 * The saved example was decided by its creator, not by the visitor reading
 * it, so the note names "the creator" and never says "you approved".
 */

import type { CanonicalPair } from "../../presentation/canonical-pair";
import { consequenceOf, firstSentence, numberWord } from "../../presentation/rehearsal";
import type { Phrase } from "../../presentation/rehearsal";

export function PhraseText({ phrase }: { phrase: Phrase }): React.ReactElement {
  return (
    <>
      {phrase.map((part, index) =>
        typeof part === "string" ? part : <em key={index}>{part.em}</em>,
      )}
    </>
  );
}

/**
 * The proofreader's caret: this text is the creator's edit of a suggestion.
 * Drawn, because the UI face has no caret glyph and a fallback one reads as
 * an underscore.
 */
export function EditedMark({
  testId,
  label = "Edited by you",
}: {
  testId?: string;
  /** The studio's own creator reads "Edited by you"; a saved example names the creator. */
  label?: string;
}): React.ReactElement {
  return (
    <span className="rt-edited" data-testid={testId}>
      <svg className="rt-edited__caret" viewBox="0 0 10 9" aria-hidden="true" focusable="false">
        <path d="M1 8 L5 1.5 L9 8" />
      </svg>
      {label}
    </span>
  );
}

export type CausalNoteProps = {
  readonly pair: CanonicalPair;
  /** "lines 02 · 05 · 06": the rows this note explains. */
  readonly lines: readonly string[];
  readonly id?: string;
  readonly hidden?: boolean;
  readonly testId?: string;
  /** "sheet": the mobile bottom-sheet copy, always shown in full. */
  readonly variant?: "margin" | "sheet";
};

export function CausalNote(props: CausalNoteProps): React.ReactElement {
  const { causal, influenceName } = props.pair;
  const { artist, source, proposed, decision } = causal;
  const suggestion = firstSentence(proposed.idea);
  const consequence = consequenceOf(props.pair);
  const headingId = `${props.id ?? "rt-note"}-heading`;
  const endings = causal.reachableEndings;
  return (
    <section
      id={props.id ?? "rt-note"}
      className={props.variant === "sheet" ? "rt-note rt-note--sheet" : "rt-note"}
      aria-labelledby={headingId}
      data-testid={props.testId ?? "rt-note"}
      aria-hidden={props.hidden === true ? true : undefined}
      inert={props.hidden === true}
    >
      <div className="rt-note__head">
        <h2 id={headingId} className="rt-label rt-note__title">
          Why this changed
        </h2>
        <span className="rt-note__lines">
          {props.lines.length === 0 ? "lines marked *" : `lines ${props.lines.join(" · ")}`}
        </span>
      </div>

      <ol className="rt-note__layers">
        <li className="rt-layer">
          <p className="rt-layer__label">1 · Source · Qloo returned</p>
          <div className="rt-slip" data-testid="rt-layer-source">
            <div className="rt-slip__top">
              <span className="rt-slip__name">{source.name}</span>
              <span className="rt-slip__meta">
                {source.kind} · {source.year} · {source.maker}
              </span>
            </div>
            <p className="rt-slip__line">
              {artist.name} → Qloo → {source.name} · #{source.rank} of the {source.kind}s returned
            </p>
            {source.theme === null ? null : (
              <p className="rt-slip__evidence">Theme · “{source.theme}”</p>
            )}
          </div>
        </li>

        <li className="rt-layer">
          <p className="rt-layer__label">2 · Suggestion · FirstPlayable proposed</p>
          <p className="rt-suggestion" data-testid="rt-layer-proposed">
            {suggestion.head}
            {suggestion.truncated ? "…" : ""}
          </p>
        </li>

        <li className="rt-layer">
          <p className="rt-layer__label rt-layer__label--decision">
            <span>
              {/* The caret mark beside this label records that the creator edited it. */}
              3 · Decision · the creator approved
            </span>
            {decision.editedByCreator ? <EditedMark label="Edited by the creator" /> : null}
          </p>
          <blockquote className="rt-decision" data-testid="rt-layer-approved">
            {decision.approvedText}
          </blockquote>
        </li>

        {consequence === null ? null : (
          <li className="rt-layer">
            <p className="rt-layer__label rt-layer__label--change">4 · Consequence · the scene changed</p>
            <p className="rt-consequence" data-testid="rt-layer-consequence">
              <PhraseText phrase={consequence} />
            </p>
          </li>
        )}
      </ol>

      <p className="rt-note__foot">
        Qloo supplied the reference. The interpretation is the creator’s.
        {causal.witness === null ? "" : " The scene's own check confirmed the change."}
      </p>

      <details className="rt-note__more">
        <summary>The full record</summary>
        <dl className="rt-record">
          <div>
            <dt>FirstPlayable proposed</dt>
            <dd className="rt-suggestion">{proposed.idea}</dd>
          </div>
          <div>
            <dt>Suggested interaction</dt>
            <dd className="rt-suggestion">{proposed.interaction}</dd>
          </div>
          <div>
            <dt>What the creator wanted to change in play</dt>
            <dd>{decision.intendedEffect}</dd>
          </div>
          {source.tone === null ? null : (
            <div>
              <dt>Tone Qloo returned for {source.name}</dt>
              <dd className="rt-slip__evidence">“{source.tone}”</dd>
            </div>
          )}
          <div>
            <dt>Endings</dt>
            <dd>
              {endings.with === endings.without &&
              endings.with === props.pair.withScene.core.endings.length
                ? `All ${numberWord(endings.with)} endings are still reachable with and without ${influenceName}.`
                : `${endings.with} endings reachable with ${influenceName}, ${endings.without} without it.`}
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
