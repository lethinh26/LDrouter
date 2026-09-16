import { describe, expect, it } from 'vitest';
import {
  applyQoderContextTier, estimateQoderPromptTokens, getQoderContextTiers, parseTierTokenCount, resolveQoderContextTier,
} from '../../src/server/providers/qoder/tier';

const modelConfig = {
  key: 'qmodel_38max',
  max_input_tokens: 200_000,
  context_config: [
    { name: '200K', tokenCount: 200_000, isDefault: true },
    { name: '400K', tokenCount: 400_000 },
    { name: '1M', tokenCount: 1_000_000 },
  ],
};

describe('Qoder context tier', () => {
  it('parses suffixed and numeric limits', () => {
    expect(parseTierTokenCount('200K')).toBe(200_000);
    expect(parseTierTokenCount('1M')).toBe(1_000_000);
    expect(parseTierTokenCount(204_800)).toBe(204_800);
    expect(parseTierTokenCount('garbage')).toBe(0);
  });

  it('sorts tiers ascending and keeps the default flag', () => {
    const tiers = getQoderContextTiers(modelConfig);
    expect(tiers.map((t) => t.name)).toEqual(['200K', '400K', '1M']);
    expect(tiers[0]!.isDefault).toBe(true);
  });

  it('returns no tiers for a model without context_config', () => {
    expect(getQoderContextTiers({ key: 'auto' })).toEqual([]);
  });

  it('counts CJK characters as roughly one token each', () => {
    const cjk = estimateQoderPromptTokens({ messages: [{ role: 'user', content: '你好世界' }] });
    expect(cjk).toBeGreaterThanOrEqual(4);
  });

  it('leaves the payload alone while the prompt fits the current limit', () => {
    expect(resolveQoderContextTier(modelConfig, { messages: [{ role: 'user', content: 'hi' }] })).toBeNull();
  });

  it('escalates to the smallest tier that fits once the prompt outgrows the default', () => {
    const long = 'x'.repeat(900_000);
    const choice = resolveQoderContextTier(modelConfig, { messages: [{ role: 'user', content: long }] });
    expect(choice?.tier.name).toBe('400K');
    expect(choice?.reason).toBe('auto:fits');
  });

  it('falls back to the largest tier when nothing fits', () => {
    const choice = resolveQoderContextTier(modelConfig, { messages: [{ role: 'user', content: 'x'.repeat(5_000_000) }] });
    expect(choice?.tier.name).toBe('1M');
    expect(choice?.reason).toBe('auto:largest');
  });

  it('honours a forced tier and ignores an unknown one', () => {
    expect(resolveQoderContextTier(modelConfig, {}, { preference: 'max' })?.tier.name).toBe('1M');
    expect(resolveQoderContextTier(modelConfig, {}, { preference: 'default' })?.tier.name).toBe('200K');
    expect(resolveQoderContextTier(modelConfig, {}, { preference: '400K' })?.tier.name).toBe('400K');
    expect(resolveQoderContextTier(modelConfig, {}, { preference: 'nope' })).toBeNull();
  });

  it('mirrors the chosen tier into the three fields the IDE writes', () => {
    const payload: Record<string, unknown> = { parameters: { max_tokens: 4096 }, chat_context: { extra: {} }, model_config: { max_input_tokens: 200_000 } };
    applyQoderContextTier(payload, { name: '400K', tokenCount: 400_000, isDefault: false });
    expect(payload.parameters).toEqual({ max_tokens: 4096, context_length: 400_000 });
    expect(payload.chat_context).toEqual({ extra: { ideModelConfigOverride: { max_input_tokens: 400_000 } } });
    expect(payload.model_config).toEqual({ max_input_tokens: 400_000 });
  });
});
