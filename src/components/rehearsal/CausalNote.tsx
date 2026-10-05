/**
 * "Why this changed": the four causal layers, each in its own material.
 *
 *   Source       Qloo returned        mono catalogue slip (the only boxed element)
 *   Suggestion   FirstPlayable proposed   italic serif, pencil, dashed underline
 *   Decision     you edited + approved    upright serif ink with a left rule
 *   Consequence  the scene changed        revision stock
 *
 * Every string is a stored field of the canonical pair or derived from the
 * stored witness by the presentation model. No identifier, hash, or validator
 * sentence is shown.
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

export type CausalNoteProps = {
  readonly pair: CanonicalPair;
  /** "lines 02 · 05 · 06": the rows this note explains. */
  readonly lines: readonly string[];
  readonly id?: string;
  readonly hidden?: boolean;
  readonly testId?: string;
};

export function CausalNote(props: CausalNoteProps): React.ReactElement {
  const { causal, influenceName } = props.pair;
  const { source, proposed, decision } = causal;
  const suggestion = firstSentence(proposed.idea);
  const consequence = consequenceOf(props.pair);
  const headingId = `${props.id ?? "rt-note"}-heading`;
  const endings = causal.reachableEndings;
  return (
    <section
      id={props.id ?? "rt-note"}
      className="rt-note"
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
              #{source.rank} of the {source.kind}s returned for the artist you confirmed
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
              3 · Decision · {decision.editedByCreator ? "you edited, then approved" : "you approved"}
            </span>
            {decision.editedByCreator ? <span className="rt-edited">‸ edited</span> : null}
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
        Qloo supplied the reference. The interpretation is yours.
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
            <dt>What you wanted to change in play</dt>
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
