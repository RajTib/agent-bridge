import type { RoutingRule } from './config';

/**
 * Finds which channel should handle a given agent+eventType, per the
 * routing rules in config/agentbridge.yml. First matching rule wins; "*"
 * matches anything. Returns undefined if nothing matches -- callers should
 * treat that as "don't send this anywhere" (fail safe to the agent's
 * normal prompt), not as an error.
 */
export function resolveChannel(rules: RoutingRule[], agent: string, eventType: string): string | undefined {
  const rule = rules.find(
    (r) => (r.agent === '*' || r.agent === agent) && (r.event_type === '*' || r.event_type === eventType),
  );
  return rule?.channel;
}
