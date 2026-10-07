"use client";

/**
 * The comp audition vertical slice: ask, confirm, score, compare.
 *
 * The browser holds the task state and nothing else. It speaks only to this
 * application's own same-origin routes; every comp and audience name it shows
 * after confirmation came back from the server, which copied it out of a
 * stored Qloo capture. Ordering, "close", and reversals are rendered exactly
 * as `compareAudiences` produced them: this component sorts and judges
 * nothing on its own.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AUDITION_CLOSE_THRESHOLD,
  type AuditionSlot,
  type AuditionState,
  EMPTY_AUDITION_STATE,
  type InterpretResponse,
  type SlotKind,
  type SlotSearchView,
} from "@/domain/audition";
import type { AudienceRanking, PairComparison } from "@/domain/audition-compare";
import type { DomainAuditionView, ScoreResponse } from "@/domain/audition-view";
import { postJson, type RequestFailure } from "@/components/studio/shared";

const KIND_LABEL: Record<SlotKind, string> = {
  movie: "Movie comp",
  videogame: "Game comp",
  audience: "Audience",
};

const DOMAIN_LABEL = { movie: "Movies", videogame: "Games" } as const;

const EXAMPLE = "Compare Moon, Arrival and O Brother for Radiohead and Kendrick Lamar fans.";

function formatAffinity(value: number): string {
  return value.toFixed(3);
}

export function AuditionClient(): React.JSX.Element {
  const [state, setState] = useState<AuditionState>(EMPTY_AUDITION_STATE);
  const [searches, setSearches] = useState<Record<string, SlotSearchView>>({});
  const [message, setMessage] = useState(EXAMPLE);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [busy, setBusy] = useState<"interpret" | "score" | null>(null);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [result, setResult] = useState<ScoreResponse | null>(null);

  useEffect(() => {
    void postJson("/api/session", {});
  }, []);

  const confirmedAudiences = state.slots.filter((s) => s.kind === "audience" && s.confirmed_entity_id !== null).length;
  const confirmedComps = state.slots.filter((s) => s.kind !== "audience" && s.confirmed_entity_id !== null).length;
  const canScore = confirmedAudiences === 2 && confirmedComps > 0 && busy === null;

  async function send(): Promise<void> {
    const text = message.trim();
    if (text.length === 0) return;
    setBusy("interpret");
    setFailure(null);
    const response = await postJson<InterpretResponse>("/api/audition/interpret", { message: text, state });
    setBusy(null);
    if (!response.ok) {
      setFailure(response.failure);
      return;
    }
    const value = response.value;
    setState(value.state);
    setSearches((previous) => {
      const live = new Set(value.state.slots.map((s) => s.slot_id));
      const next: Record<string, SlotSearchView> = {};
      for (const [id, view] of Object.entries(previous)) if (live.has(id)) next[id] = view;
      for (const view of value.searches) next[view.slot_id] = view;
      return next;
    });
    const lines = [
      `You: ${text}`,
      ...value.applied.map((a) =>
        a.op === "remove" ? `Agent: removed ${KIND_LABEL[a.kind].toLowerCase()} ${a.slot_id}` : `Agent: ${a.op === "add" ? "searching" : "replacing with"} ${KIND_LABEL[a.kind].toLowerCase()} “${a.query}”`,
      ),
      ...value.skipped.map((s) => `Agent: skipped — ${s}`),
      ...(value.clarification === null ? [] : [`Agent asks: ${value.clarification}`]),
    ];
    setTranscript((previous) => [...previous, ...lines]);
    setMessage("");
    setResult(null);
  }

  function confirm(slot: AuditionSlot, entityId: string | null): void {
    setState({
      slots: state.slots.map((s) => (s.slot_id === slot.slot_id ? { ...s, confirmed_entity_id: entityId } : s)),
    });
    setResult(null);
  }

  async function score(): Promise<void> {
    setBusy("score");
    setFailure(null);
    const response = await postJson<ScoreResponse>("/api/audition/score", { state });
    setBusy(null);
    if (!response.ok) setFailure(response.failure);
    else setResult(response.value);
  }

  return (
    <main className="rt rt-audition" data-testid="audition">
      <header className="rt-audition__head">
        <span className="rt-wordmark">FirstPlayable</span>
        <h1 className="rt-audition__title">Choose the comps. Switch the audience. See what changes.</h1>
        <p className="rt-audition__lede">
          You decide which titles represent your game. Qloo supplies how each audience relates to them. Plain code orders
          them and marks close calls and reversals. The assistant only turns your words into searches.
        </p>
      </header>

      <section className="rt-audition__ask" aria-label="Request">
        <label className="rt-audition__label" htmlFor="audition-message">
          Ask
        </label>
        <textarea
          id="audition-message"
          data-testid="audition-message"
          className="rt-audition__input"
          rows={2}
          maxLength={400}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button
          type="button"
          className="rt-button rt-button--primary"
          data-testid="audition-send"
          disabled={busy !== null || message.trim().length === 0}
          onClick={() => void send()}
        >
          {busy === "interpret" ? "Searching…" : "Send"}
        </button>
        {transcript.length > 0 && (
          <ol className="rt-audition__transcript" data-testid="audition-transcript">
            {transcript.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
        )}
      </section>

      {failure !== null && (
        <p className="rt-audition__failure" role="alert" data-testid="audition-failure">
          {failure.message} <span className="rt-audition__fact">({failure.code})</span>
        </p>
      )}

      {state.slots.length > 0 && (
        <section className="rt-audition__slots" aria-label="Confirm comps and audiences" data-testid="audition-slots">
          <h2 className="rt-audition__h2">Confirm what Qloo found</h2>
          <p className="rt-audition__note">Nothing is scored until you pick the exact match.</p>
          {state.slots.map((slot) => (
            <SlotRow key={slot.slot_id} slot={slot} search={searches[slot.slot_id] ?? null} onConfirm={confirm} />
          ))}
          <button
            type="button"
            className="rt-button rt-button--primary"
            data-testid="audition-score"
            disabled={!canScore}
            onClick={() => void score()}
          >
            {busy === "score" ? "Scoring with Qloo…" : "Score with Qloo"}
          </button>
          {!canScore && busy === null && (
            <span className="rt-audition__note"> Confirm two audiences and at least one comp.</span>
          )}
        </section>
      )}

      {result !== null && <Results result={result} />}
    </main>
  );
}

function SlotRow({
  slot,
  search,
  onConfirm,
}: {
  slot: AuditionSlot;
  search: SlotSearchView | null;
  onConfirm: (slot: AuditionSlot, entityId: string | null) => void;
}): React.JSX.Element {
  return (
    <fieldset className="rt-audition__slot" data-testid={`slot-${slot.slot_id}`}>
      <legend>
        <span className="rt-audition__kind">{KIND_LABEL[slot.kind]}</span> searched as{" "}
        <span className="rt-audition__query">“{slot.query}”</span>
      </legend>
      {search === null ? (
        <p className="rt-audition__note">Not searched yet.</p>
      ) : search.candidates.length === 0 ? (
        <p className="rt-audition__note">Qloo returned no match for this search.</p>
      ) : (
        <ul className="rt-audition__candidates">
          {search.candidates.map((candidate) => (
            <li key={candidate.entity_id}>
              <label>
                <input
                  type="radio"
                  name={`confirm-${slot.slot_id}`}
                  checked={slot.confirmed_entity_id === candidate.entity_id}
                  onChange={() => onConfirm(slot, candidate.entity_id)}
                  data-testid={`confirm-${slot.slot_id}-${candidate.original_rank}`}
                />{" "}
                {candidate.name}
                {candidate.hint !== null && <span className="rt-audition__hint"> · {candidate.hint}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function Results({ result }: { result: ScoreResponse }): React.JSX.Element {
  const [a, b] = result.audiences;
  return (
    <section className="rt-audition__results" aria-label="Audience comparison" data-testid="audition-results">
      <h2 className="rt-audition__h2">
        {a.name} vs {b.name}
      </h2>
      <p className="rt-audition__note">
        Movies and games are compared separately, never against each other. “Close” means the affinity gap is under{" "}
        {AUDITION_CLOSE_THRESHOLD}: a display rule of this tool, not statistical significance and not a Qloo confidence
        threshold.
      </p>
      <div className="rt-audition__domains">
        {(["movie", "videogame"] as const).map((domain) => {
          const view = result.domains[domain];
          return view === null ? (
            <div key={domain} className="rt-audition__panel" data-testid={`panel-${domain}`}>
              <h3 className="rt-audition__h3">{DOMAIN_LABEL[domain]}</h3>
              <p className="rt-audition__note">No confirmed {domain === "movie" ? "movie" : "game"} comps.</p>
            </div>
          ) : (
            <DomainPanel key={domain} view={view} />
          );
        })}
      </div>
      {result.unconfirmed.length > 0 && (
        <p className="rt-audition__note" data-testid="audition-unconfirmed">
          Not scored (unconfirmed): {result.unconfirmed.map((u) => `“${u.query}”`).join(", ")}
        </p>
      )}
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

function DomainPanel({ view }: { view: DomainAuditionView }): React.JSX.Element {
  const names = useMemo(() => new Map(view.comps.map((comp) => [comp.entity_id, comp.name])), [view]);
  return (
    <div className="rt-audition__panel" data-testid={`panel-${view.domain}`}>
      <h3 className="rt-audition__h3">{DOMAIN_LABEL[view.domain]}</h3>
      <p className="rt-audition__headline" data-testid={`headline-${view.domain}`}>
        {headline(view, names)}
      </p>
      <div className="rt-audition__columns">
        {view.comparison.rankings.map((ranking) => (
          <RankingColumn key={ranking.audience_entity_id} ranking={ranking} domain={view.domain} />
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
        <summary>Evidence</summary>
        <p className="rt-audition__note">
          Names come from the Qloo search result you confirmed. Affinity is the value Qloo returned for each audience in
          one request per audience, filtered to exactly your confirmed {view.domain === "movie" ? "movies" : "games"}.
        </p>
        <ul>
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

function RankingColumn({ ranking, domain }: { ranking: AudienceRanking; domain: string }): React.JSX.Element {
  const leaders = new Set(ranking.top.leaders);
  return (
    <div className="rt-audition__column" data-testid={`ranking-${domain}-${ranking.audience_entity_id}`}>
      <h4 className="rt-audition__h4">{ranking.audience_name} fans</h4>
      <p className="rt-audition__status" data-testid="top-status" data-status={ranking.top.status}>
        {ranking.top.status === "clear" && "Clear lead"}
        {ranking.top.status === "close" && "Close at the top — no single lead"}
        {ranking.top.status === "single" && "Only one comp scored"}
        {ranking.top.status === "none" && "No scores returned"}
      </p>
      <ol className="rt-audition__order">
        {ranking.ordered.map((row) => (
          <li key={row.entity_id} data-testid="ranked" className={leaders.has(row.entity_id) ? "rt-audition__lead" : undefined}>
            <span className="rt-audition__name">{row.name}</span>{" "}
            <span className="rt-audition__fact">affinity {formatAffinity(row.affinity)}</span>
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
