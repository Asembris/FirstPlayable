/**
 * The Rehearsal Table's studio desk: the paper page every creator surface
 * sits on.
 *
 * The same top bar as the scene page (wordmark, crumb, one quiet note), then
 * one centred column of sheets. It holds no state and makes no request; the
 * brief form and the project view render inside it exactly as before.
 */

import Link from "next/link";
import type { ReactNode } from "react";

export function StudioDesk({
  crumb,
  note = "Editing lives in this browser",
  testId,
  children,
}: {
  crumb: string;
  note?: string;
  testId?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="rt rt-desk" data-testid={testId}>
      <header className="rt-topbar rt-topbar--desk">
        <div className="rt-topbar__left">
          <Link href="/" className="rt-wordmark">
            FirstPlayable
          </Link>
          <span className="rt-topbar__crumb">{crumb}</span>
        </div>
        <div className="rt-topbar__centre" />
        <div className="rt-topbar__right rt-topbar__note">{note}</div>
      </header>
      <main className="rt-desk__stage">{children}</main>
    </div>
  );
}

/** A finished, one-sheet page: a heading, a sentence, and where to go next. */
export function DeskMessage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="rt-desk__message">
      <h1 className="rt-desk__title rt-desk__title--message">{title}</h1>
      {children}
    </section>
  );
}
