import type {
  AgentSession,
  AuditEvent,
  Decision,
  DecisionStatus,
  MockCallView,
  Overview,
  PhoneCall,
} from '@agentbridge/shared';

/** Must match CSRF_HEADER in @agentbridge/shared (kept as a literal so we import types only). */
const CSRF_HEADER = 'x-agentbridge-csrf';

export class ApiError extends Error {
  readonly status: number;
  readonly reason: string | null;

  constructor(status: number, message: string, reason: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** Registered by the app shell; called whenever a data call returns 401. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** When false, a 401 does not trigger the global logout handler (used by auth calls). */
  handle401?: boolean;
}

async function readError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  let reason: string | null = null;
  try {
    const data: unknown = await res.json();
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (typeof obj.error === 'string' && obj.error) message = obj.error;
      else if (typeof obj.message === 'string' && obj.message) message = obj.message;
      if (typeof obj.reason === 'string') reason = obj.reason;
    }
  } catch {
    if (res.status === 429) message = 'Too many attempts. Please wait and try again.';
  }
  return new ApiError(res.status, message, reason);
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    headers[CSRF_HEADER] = '1';
    body = JSON.stringify(opts.body ?? {});
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Cannot reach the AgentBridge server.');
  }

  if (!res.ok) {
    const err = await readError(res);
    if (res.status === 401 && opts.handle401 !== false) onUnauthorized?.();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export type DecisionFilter = DecisionStatus | 'all';

export interface DecisionDetail {
  decision: Decision;
  calls: PhoneCall[];
  events: AuditEvent[];
}

export const api = {
  login: (password: string) =>
    request<{ ok: true }>('/api/auth/login', {
      method: 'POST',
      body: { password },
      handle401: false,
    }),
  me: () => request<{ authenticated: boolean }>('/api/auth/me', { handle401: false }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST', handle401: false }),

  overview: () => request<Overview>('/api/overview'),

  decisions: (status: DecisionFilter, limit = 100) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status !== 'all') params.set('status', status);
    return request<{ decisions: Decision[] }>(`/api/decisions?${params.toString()}`);
  },
  decision: (id: string) => request<DecisionDetail>(`/api/decisions/${encodeURIComponent(id)}`),
  approve: (id: string, note?: string) =>
    request<{ decision: Decision }>(`/api/decisions/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: note ? { note } : {},
    }),
  reject: (id: string, note?: string) =>
    request<{ decision: Decision }>(`/api/decisions/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: note ? { note } : {},
    }),
  callMe: (id: string) =>
    request<{ ok: true }>(`/api/decisions/${encodeURIComponent(id)}/call`, { method: 'POST' }),

  sessions: () => request<{ sessions: AgentSession[] }>('/api/sessions'),
  calls: (limit = 50) => request<{ calls: PhoneCall[] }>(`/api/calls?limit=${limit}`),
  events: (limit = 200) => request<{ events: AuditEvent[] }>(`/api/events?limit=${limit}`),

  mockCalls: () => request<{ calls: MockCallView[] }>('/api/mock-phone'),
  mockAnswer: (callId: string) =>
    request<{ mock: MockCallView }>(`/api/mock-phone/${encodeURIComponent(callId)}/answer`, {
      method: 'POST',
    }),
  mockPress: (callId: string, digit: string) =>
    request<{ mock: MockCallView }>(`/api/mock-phone/${encodeURIComponent(callId)}/press`, {
      method: 'POST',
      body: { digit },
    }),
  mockSilence: (callId: string) =>
    request<{ mock: MockCallView }>(`/api/mock-phone/${encodeURIComponent(callId)}/silence`, {
      method: 'POST',
    }),
  mockHangup: (callId: string) =>
    request<{ mock: MockCallView }>(`/api/mock-phone/${encodeURIComponent(callId)}/hangup`, {
      method: 'POST',
    }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
