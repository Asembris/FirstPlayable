"use client";

/**
 * Artist search and explicit identity confirmation
 * (specification section 6, "Identity and silent-failure defense").
 *
 * The panel does three things, and deliberately not a fourth:
 *
 *   1. it takes a query and shows every artist that came back, in the order
 *      the API returned them;
 *   2. it shows the context needed to tell five similarly named acts apart —
 *      the short description, the disambiguation line, and which catalogues
 *      the row is linked to;
 *   3. it requires the creator to pick one and press Confirm.
 *
 * It never preselects a result, never highlights "the best match", and shows
 * no ranking score. There is no code path from typing a query to a confirmed
 * anchor that does not pass through a click on a specific artist.
 */

import { useState } from "react";
import type { AnchorView, ArtistSearchResponseSchema } from "@/domain/project";
import type { z } from "zod";
import type { ArtistCandidate } from "@/domain/qloo";
import { InlineFailure, postJson, putJson, type RequestFailure } from "./shared";

type SearchResponse = z.infer<typeof ArtistSearchResponseSchema>;

export type AnchorPanelProps = {
  projectId: string;
  revision: number;
  anchor: AnchorView | null;
  /** Called after a confirmation lands, so the parent can re-read the project. */
  onConfirmed: () => void;
};

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "done"; captureId: string | null; candidates: readonly ArtistCandidate[]; cache: string }
  | { status: "failed"; failure: RequestFailure };

export function AnchorPanel({
  projectId,
  revision,
  anchor,
  onConfirmed,
}: AnchorPanelProps): React.JSX.Element {
  const [query, setQuery] = useState(anchor?.query ?? "");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmFailure, setConfirmFailure] = useState<RequestFailure | null>(null);

  async function runSearch(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSearch({ status: "searching" });
    setChosen(null);
    setConfirmFailure(null);
    const result = await postJson<SearchResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/artist-search`,
      { query: query.trim() },
    );
    if (!result.ok) {
      setSearch({ status: "failed", failure: result.failure });
      return;
    }
    setSearch({
      status: "done",
      captureId: result.value.search.capture_id,
      candidates: result.value.search.candidates,
      cache: result.value.search.cache,
    });
  }

  async function confirm(entityId: string, captureId: string | null): Promise<void> {
    if (captureId === null) return;
    setConfirming(true);
    setConfirmFailure(null);
    const result = await putJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/anchor`,
      { expected_revision: revision, search_capture_id: captureId, entity_id: entityId },
    );
    setConfirming(false);
    if (!result.ok) {
      setConfirmFailure(result.failure);
      return;
    }
    onConfirmed();
  }

  return (
    <section className="panel" aria-labelledby="anchor-heading">
      <h2 className="panel__heading" id="anchor-heading">
        Cultural anchor
      </h2>

      {anchor !== null && (
        <div className="anchor" data-testid="anchor-confirmed">
          <p className="anchor__name">
            <span className="chip">Confirmed</span>{" "}
            <strong data-testid="anchor-name">{anchor.name}</strong>
            {anchor.disambiguation !== null && (
              <span className="studio__hint"> · {anchor.disambiguation}</span>
            )}
          </p>
          {anchor.short_description !== null && (
            <p className="studio__prose">{anchor.short_description}</p>
          )}
          <p className="studio__hint">
            Qloo retrieved this artist for “{anchor.query}” as result{" "}
            {anchor.original_rank}. You confirmed it.
          </p>
        </div>
      )}

      <form className="anchor__form" onSubmit={runSearch}>
        <label className="studio__label" htmlFor="artist-query">
          {anchor === null ? "Search for an artist" : "Search for a different artist"}
        </label>
        <div className="anchor__row">
          <input
            className="studio__input"
            id="artist-query"
            data-testid="artist-query"
            value={query}
            maxLength={80}
            minLength={2}
            required
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className="button button--primary"
            type="submit"
            data-testid="artist-search-submit"
            disabled={search.status === "searching" || query.trim().length < 2}
          >
            {search.status === "searching" ? "Searching…" : "Search"}
          </button>
        </div>
        <p className="studio__hint">
          Searching is not choosing. You will pick the exact artist yourself.
        </p>
      </form>

      {search.status === "searching" && (
        <p className="studio__note" aria-live="polite" data-testid="artist-searching">
          Looking up artists…
        </p>
      )}

      {search.status === "failed" && (
        <InlineFailure failure={search.failure} testId="artist-search-failure" />
      )}

      {search.status === "done" && search.candidates.length === 0 && (
        <p className="studio__note" data-testid="artist-no-match">
          No matching artist. Try the exact spelling, or another artist. Your brief
          is unchanged and nothing was retrieved.
        </p>
      )}

      {search.status === "done" && search.candidates.length > 0 && (
        <div className="anchor__results">
          <p className="studio__hint" data-testid="artist-results-note">
            {search.candidates.length} result
            {search.candidates.length === 1 ? "" : "s"} ·{" "}
            {search.cache === "live" ? "retrieved just now" : "from a recent lookup"} ·
            choose the one you mean
          </p>
          <ul className="anchor__list" data-testid="artist-results">
            {search.candidates.map((candidate) => {
              const selected = chosen === candidate.entity_id;
              return (
                <li key={candidate.entity_id} className="anchor__item">
                  <label className="anchor__choice">
                    <input
                      type="radio"
                      name="artist"
                      value={candidate.entity_id}
                      checked={selected}
                      data-testid={`artist-option-${candidate.original_rank}`}
                      onChange={() => setChosen(candidate.entity_id)}
                    />
                    <span>
                      <strong>{candidate.name}</strong>
                      {candidate.disambiguation !== null && (
                        <span className="studio__hint"> · {candidate.disambiguation}</span>
                      )}
                      {candidate.short_description !== null && (
                        <span className="anchor__description">
                          {candidate.short_description}
                        </span>
                      )}
                      {candidate.identity_hints.length > 0 && (
                        <span className="studio__hint">
                          Also listed on {candidate.identity_hints.join(", ")}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          {confirmFailure !== null && (
            <InlineFailure failure={confirmFailure} testId="anchor-confirm-failure" />
          )}

          <div className="studio__actions">
            <button
              className="button button--primary"
              type="button"
              data-testid="anchor-confirm"
              disabled={chosen === null || confirming}
              onClick={() => {
                if (chosen !== null) void confirm(chosen, search.captureId);
              }}
            >
              {confirming ? "Confirming…" : "Confirm this artist"}
            </button>
          </div>
          {anchor !== null && (
            <p className="studio__hint" data-testid="anchor-rebranch-warning">
              Confirming a different artist discards influences approved for the
              current one. You will be asked again before that happens.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
