// Qoder context-window tiers. A model_config advertises context_config tiers
// (200K/400K/1M) while max_input_tokens carries only the IDE-selected one. The IDE
// lets the user switch; a CLI-style client has no picker, so a long session is
// rejected upstream even though the model supports more. Emulate the picker:
// estimate the prompt, choose the smallest tier that fits, mirror it into the same
// three fields the IDE writes. Pure — no I/O.
import { QODER_CONTEXT_TIER_ENV, QODER_CONTEXT_TIER_HEADROOM } from './constants';

export interface QoderTier { name: string; tokenCount: number; isDefault: boolean }
export interface QoderTierChoice { tier: QoderTier; estimatedTokens: number; reason: string }

const UNIT: Record<string, number> = { K: 1_000, M: 1_000_000 };

export function parseTierTokenCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (typeof value !== 'string') return 0;
  const match = value.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
  if (!match) return 0;
  const count = Number(match[1]) * (UNIT[match[2] ?? ''] ?? 1);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function tierName(entry: Record<string, unknown>, tokenCount: number): string {
  const raw = entry.name ?? entry.label ?? entry.display_name ?? entry.displayName;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return String(tokenCount);
}

export function getQoderContextTiers(modelConfig: Record<string, unknown> | null | undefined): QoderTier[] {
  const list = modelConfig?.context_config ?? modelConfig?.contextConfig;
  if (!Array.isArray(list)) return [];
  const byCount = new Map<number, QoderTier>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const tokenCount = parseTierTokenCount(entry.tokenCount ?? entry.token_count ?? entry.max_input_tokens ?? entry.maxInputTokens);
    if (!tokenCount) continue;
    const isDefault = entry.isDefault === true || entry.is_default === true || entry.default === true;
    const previous = byCount.get(tokenCount);
    byCount.set(tokenCount, { name: tierName(entry, tokenCount), tokenCount, isDefault: (previous?.isDefault ?? false) || isDefault });
  }
  return [...byCount.values()].sort((a, b) => a.tokenCount - b.tokenCount);
}

const CJK_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/** CJK counts ~1 token per char; everything else ~4 chars per token. */
export function estimateQoderPromptTokens(prompt: { system?: string; messages?: unknown[]; tools?: unknown[] } = {}): number {
  let text: string;
  try {
    text = JSON.stringify({ system: prompt.system ?? '', messages: prompt.messages ?? [], tools: prompt.tools ?? [] }) ?? '';
  } catch { return 0; }
  const cjk = (text.match(CJK_RE) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/**
 * null means "send the payload as-is": the model has no tiers, or the default already fits.
 * Pure function of its inputs plus the QODER_CONTEXT_TIER env var.
 */
export function resolveQoderContextTier(
  modelConfig: Record<string, unknown> | null | undefined,
  prompt: { system?: string; messages?: unknown[]; tools?: unknown[] },
  options: { preference?: string; headroom?: number } = {},
): QoderTierChoice | null {
  const tiers = getQoderContextTiers(modelConfig);
  if (tiers.length === 0) return null;

  const preference = String(options.preference ?? process.env[QODER_CONTEXT_TIER_ENV] ?? '').trim().toLowerCase() || 'auto';
  const largest = tiers[tiers.length - 1]!;
  const defaultTier = tiers.find((tier) => tier.isDefault) ?? tiers[0]!;
  const estimatedTokens = estimateQoderPromptTokens(prompt);
  const headroom = typeof options.headroom === 'number' ? options.headroom : QODER_CONTEXT_TIER_HEADROOM;
  const needed = Math.ceil(estimatedTokens * (1 + headroom));

  if (preference === 'max') return { tier: largest, estimatedTokens, reason: 'forced:max' };
  if (preference === 'default') return { tier: defaultTier, estimatedTokens, reason: 'forced:default' };
  if (preference !== 'auto') {
    const wanted = preference.replace(/\s+/g, '');
    const asCount = parseTierTokenCount(wanted);
    const named = tiers.find((tier) => tier.name.replace(/\s+/g, '').toLowerCase() === wanted || (asCount > 0 && tier.tokenCount === asCount));
    if (named) return { tier: named, estimatedTokens, reason: `forced:${named.name}` };
  }

  const currentLimit = parseTierTokenCount(modelConfig?.max_input_tokens ?? modelConfig?.maxInputTokens) || defaultTier.tokenCount;
  if (needed <= currentLimit) return null;
  const fits = tiers.find((tier) => tier.tokenCount >= needed && tier.tokenCount > currentLimit);
  const tier = fits ?? largest;
  if (tier.tokenCount <= currentLimit) return null;
  return { tier, estimatedTokens, reason: fits ? 'auto:fits' : 'auto:largest' };
}

/** Mutates and returns the payload, mirroring the IDE's three writes. */
export function applyQoderContextTier<T extends Record<string, unknown>>(payload: T, tier: QoderTier | null): T {
  if (!payload || !tier?.tokenCount) return payload;
  const target = payload as Record<string, unknown>;
  target.parameters = { ...(target.parameters as Record<string, unknown> ?? {}), context_length: tier.tokenCount };
  const chatContext = (target.chat_context as Record<string, unknown>) ?? {};
  const extra = (chatContext.extra as Record<string, unknown>) ?? {};
  chatContext.extra = { ...extra, ideModelConfigOverride: { max_input_tokens: tier.tokenCount } };
  target.chat_context = chatContext;
  if (target.model_config && typeof target.model_config === 'object') {
    target.model_config = { ...(target.model_config as Record<string, unknown>), max_input_tokens: tier.tokenCount };
  }
  return payload;
}
