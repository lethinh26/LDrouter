// Canonical gateway error categories. Maps to OpenAI / Anthropic error envelopes.

export type GatewayErrorType =
  | 'authentication_error'
  | 'permission_error'
  | 'invalid_request_error'
  | 'model_not_found'
  | 'capability_not_supported'
  | 'rate_limit_error'
  | 'timeout_error'
  | 'upstream_auth_error'
  | 'upstream_rate_limit'
  | 'upstream_unavailable'
  | 'upstream_error'
  | 'gateway_error';

export class GatewayError extends Error {
  readonly type: GatewayErrorType;
  readonly status: number;
  readonly code: string;
  readonly safe: boolean;
  override readonly cause?: unknown;

  constructor(type: GatewayErrorType, message: string, opts: { status?: number; code?: string; safe?: boolean; cause?: unknown } = {}) {
    super(message);
    this.type = type;
    this.status = opts.status ?? defaultStatusFor(type);
    this.code = opts.code ?? type;
    this.safe = opts.safe ?? true;
    this.cause = opts.cause;
    this.name = 'GatewayError';
  }
}

export function defaultStatusFor(t: GatewayErrorType): number {
  switch (t) {
    case 'authentication_error':
      return 401;
    case 'permission_error':
      return 403;
    case 'model_not_found':
      return 404;
    case 'invalid_request_error':
      return 400;
    case 'capability_not_supported':
      return 400;
    case 'rate_limit_error':
      return 429;
    case 'timeout_error':
      return 504;
    case 'upstream_auth_error':
      return 502;
    case 'upstream_rate_limit':
      return 529;
    case 'upstream_unavailable':
      return 502;
    case 'upstream_error':
      return 502;
    case 'gateway_error':
    default:
      return 500;
  }
}

/** OpenAI-compatible error envelope. */
export function toOpenAIError(g: GatewayError, requestId?: string): { error: { message: string; type: string; code?: string; request_id?: string } } {
  return {
    error: {
      message: g.safe ? g.message : 'Gateway error',
      type: g.type,
      ...(g.code ? { code: g.code } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

/** Anthropic-compatible error envelope. */
export function toAnthropicError(g: GatewayError, requestId?: string): { type: 'error'; error: { type: string; message: string }; request_id?: string } {
  return {
    type: 'error',
    error: { type: g.type, message: g.safe ? g.message : 'Gateway error' },
    ...(requestId ? { request_id: requestId } : {}),
  };
}
