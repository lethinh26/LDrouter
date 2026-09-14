// Unit tests: merging freshly discovered capabilities into a stored model.
//
// The rule that matters: an admin edit is a divergence from what discovery last
// wrote, so it must survive a re-import; every other key is refreshed so stale
// guesses (e.g. a wrong `image_input: false`) heal.
import { describe, expect, it } from 'vitest';
import { mergeDiscoveredCapabilities } from '../../src/server/providers/index';

describe('mergeDiscoveredCapabilities', () => {
  it('keeps an admin edit that diverges from the discovered baseline', () => {
    const { capabilities } = mergeDiscoveredCapabilities(
      { chat: true, streaming: true, tools: true, image_input: true },
      { chat: true, streaming: true, tools: true },
      { chat: true, streaming: true, tools: true }
    );
    expect(capabilities.image_input).toBe(true);
  });

  it('keeps an admin "no" too — an override is not always an upgrade', () => {
    const { capabilities } = mergeDiscoveredCapabilities(
      { chat: true, tools: false },
      { chat: true, tools: true },
      { chat: true, tools: true }
    );
    expect(capabilities.tools).toBe(false);
  });

  it('refreshes keys the admin never touched', () => {
    const { capabilities } = mergeDiscoveredCapabilities(
      { chat: true, tools: false, image_input: true },
      { chat: true, tools: false },
      { chat: true, tools: true }
    );
    expect(capabilities.tools).toBe(true);
    expect(capabilities.image_input).toBe(true);
  });

  it('produces the baseline it was given, so the next merge stays stable', () => {
    const first = mergeDiscoveredCapabilities({ image_input: true }, { chat: true }, { chat: true, tools: true });
    const second = mergeDiscoveredCapabilities(first.capabilities, first.baseline, { chat: true, tools: true });
    expect(second.capabilities).toEqual(first.capabilities);
  });

  it('refreshes wholesale when there is no baseline (pre-upgrade record)', () => {
    const { capabilities } = mergeDiscoveredCapabilities(
      { chat: true, image_input: false, reasoning: false },
      null,
      { chat: true, streaming: true, tools: true }
    );
    expect(capabilities).toEqual({ chat: true, streaming: true, tools: true });
  });

  it('drops keys discovery no longer reports, unless the admin pinned them', () => {
    const { capabilities } = mergeDiscoveredCapabilities(
      { chat: true, tools: true, audio_input: true },
      { chat: true, tools: true },
      { chat: true }
    );
    expect(capabilities).toEqual({ chat: true, audio_input: true });
  });
});
