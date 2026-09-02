import { useEffect, useRef } from "react";
import { burstConfetti } from "./live-confetti.js";

/**
 * Full-screen celebration for a completed assignment on the LIVE board.
 * assignment: { playerName, ruolo, club, teamName, price }
 */
export function LiveCelebration({ assignment, onDone }) {
  const hostRef = useRef(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!assignment) return undefined;
    const stopConfetti = burstConfetti(document.body, {
      durationMs: 3600,
      count: 160,
    });
    const timer = window.setTimeout(() => {
      doneRef.current?.();
    }, 4800);
    return () => {
      stopConfetti();
      window.clearTimeout(timer);
    };
  }, [assignment?.id]);

  if (!assignment) return null;

  return (
    <div
      className="live-celebration"
      role="status"
      aria-live="assertive"
      ref={hostRef}
    >
      <div className="live-celebration__scrim" />
      <article className="live-celebration__card">
        <span className="live-celebration__eyebrow">Assegnato</span>
        <div className="live-celebration__player">
          {assignment.ruolo ? (
            <span className={`role ${assignment.ruolo}`}>{assignment.ruolo}</span>
          ) : null}
          <h2>{assignment.playerName}</h2>
        </div>
        <dl className="live-celebration__facts">
          <div>
            <dt>Club</dt>
            <dd>{assignment.club || "—"}</dd>
          </div>
          <div>
            <dt>Preso da</dt>
            <dd className="is-team">{assignment.teamName || "—"}</dd>
          </div>
          <div>
            <dt>Quotazione</dt>
            <dd className="is-price">
              {assignment.price}
              <small> cr</small>
            </dd>
          </div>
        </dl>
      </article>
    </div>
  );
}
