"use client";

/**
 * The phase 2 studio shell: establish an owner session, submit one frozen
 * brief, and hand off to the project page.
 *
 * This is deliberately not the phase 6 creative tool. It exists to prove four
 * things end to end on a real deployment: an anonymous owner session is
 * established, a valid brief persists, the project can be revisited by id, and
 * a database failure produces an honest finished state with the saved example
 * still reachable.
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
    <main className="studio">
      <header className="studio__header">
        <p className="cover__eyebrow">FirstPlayable · Phase 2 persistent shell</p>
        <h1 className="cover__title">Create your scene</h1>
        <p className="cover__lede">
          This saves one frozen brief against an anonymous owner session. Nothing
          is generated yet: no references are retrieved and no model is called.
        </p>
      </header>

      <section className="studio__status" aria-live="polite">
        {session.status === "starting" && <p className="studio__note">Starting a session…</p>}
        {session.status === "ready" && (
          <p className="studio__note" data-testid="session-ready">
            Owner session active. Editing access lives in this browser only —
            there is no account and no recovery. Clearing cookies loses it.
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
        <form className="studio__form" onSubmit={submit}>
          <fieldset className="studio__fieldset" disabled={submitting}>
            <legend className="panel__heading">The encounter</legend>

            <label className="studio__label" htmlFor="title">
              Title <span className="studio__hint">optional</span>
            </label>
            <input className="studio__input" id="title" maxLength={60} {...field("title")} />

            <label className="studio__label" htmlFor="premise">
              Premise <span className="studio__hint">40–600 characters</span>
            </label>
            <textarea
              className="studio__input studio__input--area"
              id="premise"
              rows={4}
              required
              {...field("premise")}
            />

            <label className="studio__label" htmlFor="playerRole">
              Your role
            </label>
            <input
              className="studio__input"
              id="playerRole"
              maxLength={60}
              required
              {...field("playerRole")}
            />

            <label className="studio__label" htmlFor="tone">
              Tone
            </label>
            <select className="studio__input" id="tone" {...field("tone")}>
              {TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {tone}
                </option>
              ))}
            </select>
          </fieldset>

          <fieldset className="studio__fieldset" disabled={submitting}>
            <legend className="panel__heading">Keep these fixed</legend>

            <label className="studio__label" htmlFor="roomName">
              Room
            </label>
            <input
              className="studio__input"
              id="roomName"
              maxLength={120}
              required
              {...field("roomName")}
            />
            <input
              className="studio__input"
              id="roomDescription"
              aria-label="Room description"
              maxLength={120}
              required
              {...field("roomDescription")}
            />

            <label className="studio__label" htmlFor="characterName">
              The other character
            </label>
            <input
              className="studio__input"
              id="characterName"
              maxLength={40}
              required
              {...field("characterName")}
            />
            <input
              className="studio__input"
              id="characterRole"
              aria-label="Character role"
              maxLength={100}
              required
              {...field("characterRole")}
            />

            <label className="studio__label" htmlFor="objectName">
              The important object
            </label>
            <input
              className="studio__input"
              id="objectName"
              maxLength={60}
              required
              {...field("objectName")}
            />
            <input
              className="studio__input"
              id="objectDescription"
              aria-label="Object description"
              maxLength={180}
              required
              {...field("objectDescription")}
            />
          </fieldset>

          {failure !== null && (
            <ErrorPanel heading="This brief was not saved" failure={failure} />
          )}

          <div className="studio__actions">
            <button className="button button--primary" type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save this brief"}
            </button>
            <Link className="button" href="/example">
              Play saved example
            </Link>
          </div>
        </form>
      )}
    </main>
  );
}
