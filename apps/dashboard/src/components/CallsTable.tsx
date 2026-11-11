import type { Decision, PhoneCall } from '@agentbridge/shared';
import { formatFull, formatTime } from '../time';
import { Empty, Section } from './common';

interface CallsTableProps {
  calls: PhoneCall[];
  decisions: Map<string, Decision>;
  onOpenDecision: (id: string) => void;
}

export function CallsTable({ calls, decisions, onOpenDecision }: CallsTableProps) {
  return (
    <Section title="Recent phone calls" id="calls" count={calls.length}>
      {calls.length === 0 ? (
        <Empty>No calls placed yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table rtable">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">About</th>
                <th scope="col">To</th>
                <th scope="col">Provider</th>
                <th scope="col">Attempt</th>
                <th scope="col">Status</th>
                <th scope="col">Result</th>
                <th scope="col">Prompts</th>
                <th scope="col">Invalid</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const d = decisions.get(c.decisionId);
                return (
                  <tr key={c.id}>
                    <td data-label="Time" title={formatFull(c.createdAt)}>
                      {formatTime(c.createdAt)}
                    </td>
                    <td data-label="About">
                      <button type="button" className="link-btn" onClick={() => onOpenDecision(c.decisionId)}>
                        {d ? `${d.projectName}: ${d.summary}` : 'View decision'}
                      </button>
                    </td>
                    <td data-label="To" className="mono">
                      {c.toMasked}
                    </td>
                    <td data-label="Provider">
                      {c.provider}
                      {!c.isRealCall ? <span className="tag tag-sim">simulated</span> : null}
                    </td>
                    <td data-label="Attempt">{c.attempt}</td>
                    <td data-label="Status">
                      <span className={`chip call-${c.status}`}>{c.status.replace('_', ' ')}</span>
                    </td>
                    <td data-label="Result">
                      {c.result ? (
                        <span className={`chip result-${c.result}`}>{c.result.replace('_', ' ')}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="Prompts">{c.promptsPlayed}</td>
                    <td data-label="Invalid">{c.invalidInputs}</td>
                    <td data-label="Error" className={c.error ? 't-red wrap' : 'muted'}>
                      {c.error ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
