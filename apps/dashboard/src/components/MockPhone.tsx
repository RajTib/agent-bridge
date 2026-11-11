import { useEffect, useRef, useState } from 'react';
import type { Decision, MockCallView } from '@agentbridge/shared';
import { api, errorMessage } from '../api';
import { Empty, Section } from './common';

interface MockPhoneProps {
  calls: MockCallView[];
  decisions: Map<string, Decision>;
  onUpdate: (m: MockCallView) => void;
}

export function MockPhone({ calls, decisions, onUpdate }: MockPhoneProps) {
  return (
    <Section title="Mock phone" id="mock-phone" count={calls.filter((c) => c.state !== 'ended').length}>
      <p className="mock-banner">
        The mock provider is active. No real phone calls are placed; use this simulator to answer and press keys.
      </p>
      {calls.length === 0 ? (
        <Empty>No simulated calls yet.</Empty>
      ) : (
        <div className="phones">
          {calls.map((c) => (
            <PhoneCard key={c.callId} call={c} decision={decisions.get(c.decisionId)} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </Section>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

const STATE_LABEL: Record<MockCallView['state'], string> = {
  ringing: 'Ringing',
  in_progress: 'In call',
  ended: 'Call ended',
};

function PhoneCard({
  call,
  decision,
  onUpdate,
}: {
  call: MockCallView;
  decision: Decision | undefined;
  onUpdate: (m: MockCallView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [call.transcript.length]);

  const act = async (fn: () => Promise<{ mock: MockCallView }>) => {
    setBusy(true);
    setError(null);
    try {
      onUpdate((await fn()).mock);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const ended = call.state === 'ended';

  return (
    <article className={`phone phone-${call.state}`} aria-label="Simulated phone call">
      <p className="sim-label">SIMULATED CALL — no real phone call was placed</p>

      <div className="phone-head">
        <span className={`phone-state state-${call.state}`}>
          <span className="dot" aria-hidden="true" />
          {STATE_LABEL[call.state]}
          {call.awaitingDigits ? ' · waiting for keypress' : ''}
        </span>
        {decision ? (
          <span className="phone-about" title={decision.summary}>
            {decision.projectName} · <span className="mono">{decision.toolName}</span>
          </span>
        ) : null}
      </div>

      <ol className="transcript" ref={transcriptRef} aria-label="What the voice said" tabIndex={0}>
        {call.transcript.length === 0 ? (
          <li className="muted">…</li>
        ) : (
          call.transcript.map((line, i) => <li key={i}>{line}</li>)
        )}
      </ol>

      {call.state === 'ringing' ? (
        <div className="phone-actions">
          <button type="button" className="btn btn-approve" disabled={busy} onClick={() => void act(() => api.mockAnswer(call.callId))}>
            Answer
          </button>
          <button type="button" className="btn btn-reject" disabled={busy} onClick={() => void act(() => api.mockHangup(call.callId))}>
            Decline
          </button>
        </div>
      ) : null}

      {call.state === 'in_progress' ? (
        <>
          <div className="keypad" role="group" aria-label="Keypad">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className="key"
                disabled={busy || !call.awaitingDigits}
                onClick={() => void act(() => api.mockPress(call.callId, k))}
                aria-label={`Press ${k}`}
              >
                {k}
              </button>
            ))}
          </div>
          <div className="phone-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !call.awaitingDigits}
              onClick={() => void act(() => api.mockSilence(call.callId))}
            >
              Stay silent
            </button>
            <button type="button" className="btn btn-reject" disabled={busy} onClick={() => void act(() => api.mockHangup(call.callId))}>
              Hang up
            </button>
          </div>
        </>
      ) : null}

      {ended ? <p className="muted phone-ended-note">This simulated call has ended.</p> : null}

      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
