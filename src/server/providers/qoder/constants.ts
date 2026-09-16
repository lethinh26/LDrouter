// Qoder endpoint map. PAT-only: every credential is a personal access token (pt-...)
// that is exchanged for a short-lived job token (jt-...), and job tokens are served
// by api2 (api3 answers 403 "Login expired" for jt-).
// ponytail: single inference host because there is exactly one credential kind.
// If device tokens (dt-, api3) are ever supported, restore a token-prefix branch here.
import { QODER_RSA_PUBLIC_KEY as RSA_KEY } from './rsa';

export const QODER_OPENAPI_BASE = 'https://openapi.qoder.sh';
export const QODER_INFERENCE_BASE = 'https://api2.qoder.sh';
export const QODER_LOGIN_URL = 'https://qoder.com/account/integrations';

export const QODER_JOB_TOKEN_EXCHANGE_URL = `${QODER_OPENAPI_BASE}/api/v1/jobToken/exchange`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_BASE}/api/v1/userinfo`;

export const QODER_CHAT_SIG_PATH = '/api/v2/service/pro/sse/agent_chat_generation';
export const QODER_CHAT_URL = `${QODER_INFERENCE_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const QODER_MODEL_LIST_URL = `${QODER_INFERENCE_BASE}/algo/api/v2/model/list`;

// COSY client fingerprint. The upstream validates the signature against the values
// used at signing time, so these are not free-form.
export const QODER_IDE_VERSION = '1.0.0';
export const QODER_CLIENT_TYPE = '5';
export const QODER_DATA_POLICY = 'disagree';
export const QODER_LOGIN_VERSION = 'v2';
export const QODER_MACHINE_OS = 'x86_64_windows';
export const QODER_MACHINE_TYPE = '5';

// Static fallback catalog used only when the live model list cannot be fetched at
// add time, so the admin sees something to select. Chat never trusts this list —
// it always sends the live model_config.
export const QODER_MODEL_KEYS = [
  'auto', 'ultimate', 'performance', 'efficient', 'lite',
  'qmodel_38max', 'qmodel_latest', 'qmodel', 'qfmodel',
  'kmodel_latest', 'kmodel', 'gmodel', 'gfmodel',
  'dmodel', 'dfmodel', 'mmodel',
] as const;

export const QODER_RSA_PUBLIC_KEY = RSA_KEY;

export const QODER_CONTEXT_TIER_ENV = 'QODER_CONTEXT_TIER';
export const QODER_CONTEXT_TIER_HEADROOM = 0.15;
