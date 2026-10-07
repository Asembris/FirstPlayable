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

import { useEffect, useState } from "react";
import {
  type AuditionSlot,
  type AuditionState,
  EMPTY_AUDITION_STATE,
  type InterpretResponse,
  type SlotKind,
  type SlotSearchView,
} from "@/domain/audition";
import { AuditionResults } from "./AuditionResults";
import type { ScoreResponse } from "@/domain/audition-view";
import { postJson, type RequestFailure } from "@/components/studio/shared";

const KIND_LABEL: Record<SlotKind, string> = {
  movie: "Movie comp",
  videogame: "Game comp",
  audience: "Audience",
};


const EXAMPLE = "Compare Moon, Arrival and O Brother for Radiohead and Kendrick Lamar fans.";

export function AuditionClient({ savedResult, example, startLive = false }: { savedResult: ScoreResponse; example: { title: string; concept: string; captured_at: string }; startLive?: boolean }): React.JSX.Element {
  const [live, setLive] = useState(startLive);
  const [session, setSession] = useState<'pending' | 'ready' | 'failed'>('pending');
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [state, setState] = useState<AuditionState>(EMPTY_AUDITION_STATE);
  const [searches, setSearches] = useState<Record<string, SlotSearchView>>({});
  const [message, setMessage] = useState(EXAMPLE);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [busy, setBusy] = useState<"interpret" | "score" | null>(null);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [result, setResult] = useState<ScoreResponse | null>(null);

  useEffect(() => {
    if (!live) return;
    let active = true;
    void postJson('/api/session', {}).then((response) => {
      if (!active) return;
      setSession(response.ok ? 'ready' : 'failed');
      if (!response.ok) setFailure(response.failure);
    });
    return () => { active = false; };
  }, [live, sessionAttempt]);

  const confirmedAudiences = state.slots.filter((s) => s.kind === "audience" && s.confirmed_entity_id !== null).length;
  const confirmedComps = state.slots.filter((s) => s.kind !== "audience" && s.confirmed_entity_id !== null).length;
  const canScore = confirmedAudiences === 2 && confirmedComps > 0 && busy === null && session === 'ready';

  async function send(): Promise<void> {
    const text = message.trim();
    if (text.length === 0 || session !== 'ready' || busy !== null) return;
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
      ...state,
      slots: state.slots.map((s) => (s.slot_id === slot.slot_id ? { ...s, confirmed_entity_id: entityId } : s)),
    });
    setResult(null);
  }

  async function score(): Promise<void> {
    if (!canScore) return;
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
          For game creators: choose the comps that represent your project. See how Qloo’s taste data orders the same titles for two artist audiences.
        </p>
      </header>

      <nav className="rt-audition__mode" aria-label="Audition mode">
        <button className="rt-button" type="button" aria-pressed={!live} onClick={() => { setLive(false); setFailure(null); }}>Saved example</button>
        <button className="rt-button" type="button" data-testid="try-own" aria-pressed={live} onClick={() => { if (!live) { setSession('pending'); setLive(true); } }}>Try your own</button>
      </nav>
      {!live && <>
        <section className="rt-audition__concept" aria-label="Game concept">
          <span className="rt-label">Saved example · real Qloo capture · no live calls</span>
          <h2 className="rt-audition__h2">{example.title}</h2>
          <p>{example.concept}</p>
          <p className="rt-audition__note">Comps chosen for isolation, first contact and exploration. The concept gives context; Qloo scores only the confirmed titles.</p>
        </section>
        <AuditionResults result={savedResult} savedAt={example.captured_at} />
      </>}
      {live && <>
      {session === 'pending' && <p role="status">Preparing your session…</p>}
      {session === 'failed' && <button className="rt-button" type="button" data-testid="session-retry" onClick={() => { setFailure(null); setSession('pending'); setSessionAttempt((v) => v + 1); }}>Retry session</button>}
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
          disabled={session !== 'ready' || busy !== null || message.trim().length === 0}
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

      {result !== null && <AuditionResults result={result} />}
      </>}
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
