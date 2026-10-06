"use client";

/**
 * The brief: establish an owner session, submit one frozen brief, and hand off
 * to the project page.
 *
 * It still proves the four Phase 2 things end to end on a real deployment: an
 * anonymous owner session is established, a valid brief persists, the project
 * can be revisited by id, and a database failure produces an honest finished
 * state with the saved example still reachable. Phase 6 sets it on the
 * Rehearsal Table desk as the first sheet of the prompt book: the creator's
 * own words in serif ink, the fixed world beside them.
 *
 * Everything it knows about the database arrives through this application's own
 * same-origin API. There is no Supabase client here, no credential, and no
 * direct request to any third party.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Brief, Tone } from "@/domain/brief";
import { ErrorPanel, postJson, type RequestFailure } from "./shared";
import { StudioDesk } from "./StudioDesk";

/**
 * Opaque world identifiers. They are addresses, not display text, so the shell
 * uses three fixed ones rather than deriving them from creator wording.
 */
const WORLD_IDS = { room: "room", character: "npc", object: "object" } as const;

const TONES: readonly Tone[] = ["tense", "intimate", "wry"];

type FormState = {
  title: string;
  premise: string;
  roomName: string;
  roomDescription: string;
  playerRole: string;
  characterName: string;
  characterRole: string;
  objectName: string;
  objectDescription: string;
  tone: Tone;
};

const INITIAL_FORM: FormState = {
  title: "",
  premise:
    "The station is closing and one sealed letter is still behind the counter. The visitor who left it wants it back before the last train, and will not say who it is for.",
  roomName: "Lost-property counter",
  roomDescription: "The station is closing. You have one letter left to return.",
  playerRole: "Station attendant",
  characterName: "Nia",
  characterRole: "Visitor asking for her letter",
  objectName: "Sealed letter",
  objectDescription: "One envelope, left behind earlier today.",
  tone: "tense",
};

function toBrief(form: FormState): Brief {
  return {
    title: form.title.trim().length === 0 ? null : form.title.trim(),
    premise: form.premise.trim(),
    player_role: form.playerRole.trim(),
    room: {
      id: WORLD_IDS.room,
      name: form.roomName.trim(),
      description: form.roomDescription.trim(),
    },
    character: {
      id: WORLD_IDS.character,
      name: form.characterName.trim(),
      role: form.characterRole.trim(),
    },
    object: {
      id: WORLD_IDS.object,
      name: form.objectName.trim(),
      description: form.objectDescription.trim(),
    },
    tone: form.tone,
    // Phase 3 resolves a cultural anchor. Phase 2 never claims one.
    cultural_anchor_query: null,
    forbidden_wording: [],
  };
}

type SessionState =
  | { status: "starting" }
  | { status: "ready"; expiresAt: string }
  | { status: "failed"; failure: RequestFailure };

export function StudioClient(): React.JSX.Element {
  const router = useRouter();
  const [session, setSession] = useState<SessionState>({ status: "starting" });
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);

  const startSession = useCallback(async () => {
    setSession({ status: "starting" });
    const result = await postJson<{ established: boolean; expires_at: string }>(
      "/api/session",
      {},
    );
    if (result.ok) {
      setSession({ status: "ready", expiresAt: result.value.expires_at });
    } else {
      setSession({ status: "failed", failure: result.failure });
    }
  }, []);

  useEffect(() => {
    void startSession();
  }, [startSession]);

  const field = <K extends keyof FormState>(key: K) => ({
    value: form[key],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) => setForm((current) => ({ ...current, [key]: event.target.value as FormState[K] })),
  });

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setFailure(null);
    const result = await postJson<{ project: { id: string } }>("/api/projects", {
      brief: toBrief(form),
    });
    if (result.ok) {
      router.push(`/studio/${result.value.project.id}`);
      return;
    }
    setFailure(result.failure);
    setSubmitting(false);
  }

  return (
    <StudioDesk crumb="Create your scene">
      <header className="rt-desk__head">
        <p className="rt-label rt-studio__eyebrow">01 · The brief</p>
        <h1 className="rt-desk__title">Create your scene</h1>
        <p className="rt-studio__lede">
          Write one encounter. The room, the other character, and the object stay fixed while
          you try cultural influences on it. Saving the brief generates nothing yet.
        </p>
      </header>

      <section className="rt-desk__status" aria-live="polite">
        {session.status === "starting" && <p className="rt-studio__note">Starting a session…</p>}
        {session.status === "ready" && (
          <p className="rt-studio__note" data-testid="session-ready">
            Editing access lives in this browser only. There is no account and no recovery:
            clearing cookies loses it.
          </p>
        )}
        {session.status === "failed" && (
          <ErrorPanel
            heading="This browser could not start a session"
            failure={session.failure}
            onRetry={() => void startSession()}
          />
        )}
      </section>

      {session.status === "ready" && (
        <form className="rt-brief" onSubmit={submit}>
          <fieldset className="rt-brief__set" disabled={submitting}>
            <legend className="rt-label rt-brief__legend">The encounter</legend>

            <div className="rt-field">
              <label className="rt-field__label" htmlFor="title">
                Title <span className="rt-field__hint">optional</span>
              </label>
              <input
                className="rt-field__input rt-field__input--title"
                id="title"
                maxLength={60}
                {...field("title")}
              />
            </div>

            <div className="rt-field">
              <label className="rt-field__label" htmlFor="premise">
                Premise <span className="rt-field__hint">40–600 characters</span>
              </label>
              <textarea
                className="rt-field__input"
                id="premise"
                rows={5}
                required
                {...field("premise")}
              />
            </div>

            <div className="rt-field">
              <label className="rt-field__label" htmlFor="playerRole">
                Your role
              </label>
              <input
                className="rt-field__input rt-field__input--line"
                id="playerRole"
                maxLength={60}
                required
                {...field("playerRole")}
              />
            </div>

            <fieldset className="rt-field rt-brief__tone">
              <legend className="rt-field__label">Tone</legend>
              <div className="rt-tones">
                {TONES.map((tone) => (
                  <label key={tone} className="rt-tones__option">
                    <input
                      type="radio"
                      name="tone"
                      value={tone}
                      checked={form.tone === tone}
                      onChange={() => setForm((current) => ({ ...current, tone }))}
                    />
                    <span>{tone}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </fieldset>

          <fieldset className="rt-brief__set rt-brief__set--fixed" disabled={submitting}>
            <legend className="rt-label rt-brief__legend">Keep these fixed</legend>
            <p className="rt-studio__note">
              Every version of the scene keeps these exactly. An influence changes what you can
              do, never who is in the room.
            </p>

            <div className="rt-field">
              <label className="rt-field__label" htmlFor="roomName">
                Room
              </label>
              <input
                className="rt-field__input rt-field__input--line"
                id="roomName"
                maxLength={120}
                required
                {...field("roomName")}
              />
              <input
                className="rt-field__input rt-field__input--plain"
                id="roomDescription"
                aria-label="Room description"
                maxLength={120}
                required
                {...field("roomDescription")}
              />
            </div>

            <div className="rt-field">
              <label className="rt-field__label" htmlFor="characterName">
                The other character
              </label>
              <input
                className="rt-field__input rt-field__input--line"
                id="characterName"
                maxLength={40}
                required
                {...field("characterName")}
              />
              <input
                className="rt-field__input rt-field__input--plain"
                id="characterRole"
                aria-label="Character role"
                maxLength={100}
                required
                {...field("characterRole")}
              />
            </div>

            <div className="rt-field">
              <label className="rt-field__label" htmlFor="objectName">
                The important object
              </label>
              <input
                className="rt-field__input rt-field__input--line"
                id="objectName"
                maxLength={60}
                required
                {...field("objectName")}
              />
              <input
                className="rt-field__input rt-field__input--plain"
                id="objectDescription"
                aria-label="Object description"
                maxLength={180}
                required
                {...field("objectDescription")}
              />
            </div>
          </fieldset>

          {failure !== null && (
            <div className="rt-brief__failure">
              <ErrorPanel heading="This brief was not saved" failure={failure} />
            </div>
          )}

          <div className="rt-studio__actions rt-brief__actions">
            <button className="rt-button rt-button--primary" type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save this brief"}
            </button>
            <Link className="rt-button" href="/difference">
              Play saved example
            </Link>
            <p className="rt-studio__note">Next, you choose an artist you love.</p>
          </div>
        </form>
      )}
    </StudioDesk>
  );
}
