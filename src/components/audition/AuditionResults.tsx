"use client";
import { useMemo, useState } from 'react';
import { AUDITION_CLOSE_THRESHOLD } from '@/domain/audition';
import type { AudienceRanking, PairComparison } from '@/domain/audition-compare';
import { decisionAnswer, decisionQuestion, type DecisionResult } from '@/domain/audition-decision';
import type { DomainAuditionView, ScoreResponse } from '@/domain/audition-view';
const DOMAIN_LABEL = { movie: 'Movies', videogame: 'Games' } as const;
function formatAffinity(value: number): string { return value.toFixed(3); }
export function AuditionResults({ result, savedAt }: { result: ScoreResponse; savedAt?: string | undefined }): React.JSX.Element {
  const [a, b] = result.audiences;
  const [activeAudience, setActiveAudience] = useState(result.decision?.audience_entity_id ?? a.entity_id);
  return (
    <section className="rt-audition__results" aria-label="Audience comparison" data-testid="audition-results">
      <h2 className="rt-audition__h2">
        {a.name} vs {b.name}
      </h2>
      <p className="rt-audition__summary">Movies: {result.domains.movie?.comparison.reversals ?? 0} reversals · Games: {result.domains.videogame?.comparison.reversals ?? 0} reversals</p>
      {result.decision !== null && <DecisionCard decision={result.decision} saved={savedAt !== undefined} />}
      <div className="rt-audition__switch" role="group" aria-label="Switch audience">
        {result.audiences.map((audience) => <button type="button" className="rt-button" key={audience.entity_id} aria-pressed={activeAudience === audience.entity_id} onClick={() => setActiveAudience(audience.entity_id)}>{audience.name} fans</button>)}
      </div>
      <p className="rt-audition__note" aria-live="polite">Reading {result.audiences.find((a) => a.entity_id === activeAudience)?.name} fans. Positions show the move from the other audience. Close pairs make no call.</p>
      <div className="rt-audition__domains">
        {(["movie", "videogame"] as const).map((domain) => {
          const view = result.domains[domain];
          return view === null ? (
            <div key={domain} className="rt-audition__panel" data-testid={`panel-${domain}`}>
              <h3 className="rt-audition__h3">{DOMAIN_LABEL[domain]}</h3>
              <p className="rt-audition__note">No confirmed {domain === "movie" ? "movie" : "game"} comps.</p>
            </div>
          ) : (
            <DomainPanel key={domain} view={view} activeAudience={activeAudience} savedAt={savedAt} audiences={result.audiences} />
          );
        })}
      </div>
      <p className="rt-audition__note">
        Movies and games are compared separately, never against each other. “Close” means the affinity gap is under{" "}
        {AUDITION_CLOSE_THRESHOLD}: a display rule of this tool, not statistical significance and not a Qloo confidence
        threshold.
      </p>
      {result.unconfirmed.length > 0 && (
        <p className="rt-audition__note" data-testid="audition-unconfirmed">
          Not scored (unconfirmed): {result.unconfirmed.map((u) => `“${u.query}”`).join(", ")}
        </p>
      )}
    </section>
  );
}

function DecisionCard({ decision, saved }: { decision: DecisionResult; saved: boolean }): React.JSX.Element {
  const scope = decision.domain === 'movie' ? 'movies' : 'games';
  return (
    <section className="rt-audition__decision" aria-label="Decision" data-testid="audition-decision" data-status={decision.outcome.status}>
      <span className="rt-label">Decision{saved ? ' · fixed example question, no model call' : ''}</span>
      <p className="rt-audition__decision-ask" data-testid="decision-question">{decisionQuestion(decision)}</p>
      <p className="rt-audition__decision-answer" data-testid="decision-answer">{decisionAnswer(decision)}</p>
      {decision.not_scored.length > 0 && <p className="rt-audition__note">Qloo returned no score for {decision.not_scored.map((c) => c.name).join(', ')}, so it took no part in this call.</p>}
      <p className="rt-audition__note" data-testid="decision-basis">
        Evidence: {saved ? `the synthetic saved affinities for ${decision.audience_name} fans, in Qloo’s response shape but not Qloo data,` : `Qloo audience affinity for ${decision.audience_name} fans,`} scored across your confirmed {scope} only. The call: this tool’s fixed rule — a lead needs a gap of at least {decision.threshold} over every other scored comp — not the assistant. Not a measure of project fit, demand or sales, and not statistical significance.
      </p>
    </section>
  );
}

function headline(view: DomainAuditionView, names: Map<string, string>): string {
  const { pairs, rankings } = view.comparison;
  const reversed = pairs.filter((pair) => pair.verdict === "reversal");
  if (reversed.length > 0) {
    const first = reversed[0]!;
    return `Switching audience reverses ${reversed.length === 1 ? "one pair" : `${reversed.length} pairs`}: ${names.get(first.a)} and ${names.get(first.b)} trade places.`;
  }
  if (pairs.length === 0) return "Only one comp here, so there is no order to switch.";
  if (pairs.every((pair) => pair.verdict === "holds")) return `The order holds for both ${rankings[0].audience_name} and ${rankings[1].audience_name}.`;
  return "No clear reversal: the gaps that would show one are close or missing.";
}

function verdictText(pair: PairComparison): string {
  switch (pair.verdict) {
    case "reversal":
      return "reversed";
    case "holds":
      return "same order";
    case "close":
      return "close — no call";
    case "incomplete":
      return "missing score";
  }
}

function DomainPanel({ view, activeAudience, savedAt, audiences }: { view: DomainAuditionView; activeAudience: string; savedAt?: string | undefined; audiences: ScoreResponse['audiences'] }): React.JSX.Element {
  const names = useMemo(() => new Map(view.comps.map((comp) => [comp.entity_id, comp.name])), [view]);
  return (
    <div className="rt-audition__panel" data-testid={`panel-${view.domain}`}>
      <h3 className="rt-audition__h3">{DOMAIN_LABEL[view.domain]}</h3>
      <p className="rt-audition__headline" data-testid={`headline-${view.domain}`}>
        {headline(view, names)}
      </p>
      <div className="rt-audition__columns">
        {view.comparison.rankings.map((ranking) => (
          <RankingColumn key={ranking.audience_entity_id} ranking={ranking} domain={view.domain} view={view} active={ranking.audience_entity_id === activeAudience} />
        ))}
      </div>
      {view.comparison.pairs.length > 0 && (
        <ul className="rt-audition__pairs" data-testid={`pairs-${view.domain}`}>
          {view.comparison.pairs.map((pair) => (
            <li key={`${pair.a}-${pair.b}`} className={`rt-audition__pair rt-audition__pair--${pair.verdict}`} data-verdict={pair.verdict}>
              {names.get(pair.a)} / {names.get(pair.b)}: <strong>{verdictText(pair)}</strong>
            </li>
          ))}
        </ul>
      )}
      <details className="rt-audition__evidence" data-testid={`evidence-${view.domain}`}>
        <summary>Qloo evidence</summary>
        {savedAt && <p className="rt-audition__note">Synthetic saved example dated {savedAt.slice(0, 10)}: every name, entity ID and affinity below is invented in Qloo’s response shape and is not a Qloo response. Replayed locally; no provider calls.</p>}
        <p className="rt-audition__note">
          Names come from the Qloo search result you confirmed. Affinity is the value Qloo returned for each audience in
          one request per audience, filtered to exactly your confirmed {view.domain === "movie" ? "movies" : "games"}.
        </p>
        <ul>
          {audiences.map((a) => <li key={a.entity_id} className="rt-audition__fact">{a.name} — Qloo {a.entity_id}, search result {a.original_rank}, capture {a.search_capture_id}</li>)}
          {view.comps.map((comp) => (
            <li key={comp.entity_id} className="rt-audition__fact">
              {comp.name} — Qloo {comp.entity_id}, search result {comp.original_rank}, capture {comp.search_capture_id}
            </li>
          ))}
          {view.evidence.map((item) => (
            <li key={item.audience_entity_id} className="rt-audition__fact">
              {item.request} · {item.cache} · {item.retrieved_at}
              {item.capture_id === null ? "" : ` · capture ${item.capture_id}`}
              {item.missing_entity_ids.length > 0 && ` · no score returned for ${item.missing_entity_ids.map((id) => names.get(id) ?? id).join(", ")}`}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function RankingColumn({ ranking, domain, view, active }: { ranking: AudienceRanking; domain: string; view: DomainAuditionView; active: boolean }): React.JSX.Element {
  const leaders = new Set(ranking.top.leaders);
  return (
    <div className="rt-audition__column" data-active={active} data-testid={`ranking-${domain}-${ranking.audience_entity_id}`}>
      <h4 className="rt-audition__h4">{ranking.audience_name} fans</h4>
      <p className="rt-audition__status" data-testid="top-status" data-status={ranking.top.status}>
        {ranking.top.status === "clear" && "Clear lead"}
        {ranking.top.status === "close" && "Close at the top — no single lead"}
        {ranking.top.status === "single" && "Only one comp scored"}
        {ranking.top.status === "none" && "No scores returned"}
      </p>
      <ol className="rt-audition__order">
        {ranking.ordered.map((row) => (
          <li key={row.entity_id} data-testid="ranked" data-entity={row.entity_id} data-reversed={view.comparison.pairs.some((p) => p.verdict === 'reversal' && (p.a === row.entity_id || p.b === row.entity_id))} className={leaders.has(row.entity_id) ? "rt-audition__lead" : undefined}>
            <span className="rt-audition__position" aria-label={"position " + row.position}>{row.position.toString().padStart(2, '0')}</span>
            <span className="rt-audition__comp-mark" aria-hidden="true">{String.fromCharCode(65 + view.comps.findIndex((c) => c.entity_id === row.entity_id))}</span>
            <span className="rt-audition__name">{row.name}</span>{" "}
            <span className="rt-audition__fact">affinity {formatAffinity(row.affinity)}</span>
            {active && <span className="rt-audition__movement">Position {view.comparison.rankings.find((r) => r.audience_entity_id !== ranking.audience_entity_id)?.ordered.find((r) => r.entity_id === row.entity_id)?.position ?? 'unscored'} → {row.position}</span>}
            {row.close_to_next && <span className="rt-audition__close"> close to next</span>}
          </li>
        ))}
      </ol>
      {ranking.unscored.length > 0 && (
        <p className="rt-audition__note">No score returned: {ranking.unscored.map((u) => u.name).join(", ")}</p>
      )}
    </div>
  );
}

