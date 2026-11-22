import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeOscillator {
  static throwOnConnect = false;
  type: OscillatorType = 'sine';
  frequency = {
    value: 0,
    setValueAtTime: vi.fn((value: number) => { this.frequency.value = value; }),
  };
  onended: (() => void) | null = null;
  connect = vi.fn(() => { if (FakeOscillator.throwOnConnect) throw new Error('simulated connection failure'); });
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static resumeHandlers: Array<() => Promise<void>> = [];
  static throwOnStartCall: number | null = null;
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];
  private resumeHandler: () => Promise<void>;
  resume = vi.fn(async () => {
    await this.resumeHandler();
    this.state = 'running';
  });
  close = vi.fn(async () => { this.state = 'closed'; });

  constructor() {
    this.resumeHandler = FakeAudioContext.resumeHandlers.shift() ?? (() => Promise.resolve());
    FakeAudioContext.instances.push(this);
  }

  createOscillator(): OscillatorNode {
    const oscillator = new FakeOscillator();
    const callNumber = this.oscillators.length + 1;
    if (FakeAudioContext.throwOnStartCall === callNumber) {
      oscillator.start.mockImplementation(() => { throw new Error('simulated oscillator start failure'); });
    }
    this.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
  }

  createGain(): GainNode {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }
}

describe('sound feedback resource lifecycle', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeAudioContext.resumeHandlers = [];
    FakeAudioContext.throwOnStartCall = null;
    FakeOscillator.throwOnConnect = false;
    vi.stubGlobal('window', { AudioContext: FakeAudioContext as unknown as typeof AudioContext });
  });

  afterEach(async () => {
    const sound = await import('@web/lib/sound-feedback');
    sound.disposeRequestAudio();
    await Promise.resolve();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('closes a preview-only AudioContext after the tone finishes', async () => {
    vi.useFakeTimers();
    const sound = await import('@web/lib/sound-feedback');

    await expect(sound.previewRequestSound('success', { disposeAfter: true })).resolves.toBe(true);
    const context = FakeAudioContext.instances[0]!;
    expect(context.state).toBe('running');
    expect(context.oscillators).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.state).toBe('closed');
    expect(context.oscillators.every((oscillator) => oscillator.disconnect.mock.calls.length > 0)).toBe(true);
  });

  it('does not let a preview consume the live notification sound throttle', async () => {
    const sound = await import('@web/lib/sound-feedback');
    await sound.previewRequestSound('success');
    sound.playRequestSound('http-error');

    expect(FakeAudioContext.instances[0]!.oscillators).toHaveLength(4);
  });

  it('plays a request completion that arrives while an explicit unlock is pending', async () => {
    let resolveResume!: () => void;
    FakeAudioContext.resumeHandlers.push(() => new Promise<void>((resolve) => { resolveResume = resolve; }));
    const sound = await import('@web/lib/sound-feedback');

    const unlock = sound.unlockRequestAudio();
    const context = FakeAudioContext.instances[0]!;
    sound.playRequestSound('success');
    expect(context.oscillators).toHaveLength(0);

    resolveResume();
    await expect(unlock).resolves.toBe(true);
    expect(context.oscillators).toHaveLength(2);
  });

  it('drops pending request sounds when an explicit unlock fails', async () => {
    FakeAudioContext.resumeHandlers.push(() => Promise.reject(new Error('autoplay blocked')));
    const sound = await import('@web/lib/sound-feedback');

    const unlock = sound.unlockRequestAudio();
    const context = FakeAudioContext.instances[0]!;
    sound.playRequestSound('http-error');
    await expect(unlock).resolves.toBe(false);
    expect(context.oscillators).toHaveLength(0);

    sound.disposeRequestAudio();
    await expect(sound.unlockRequestAudio()).resolves.toBe(true);
    const replacement = FakeAudioContext.instances[1]!;
    expect(replacement.oscillators).toHaveLength(0);
    sound.playRequestSound('success');
    expect(replacement.oscillators).toHaveLength(2);
  });

  it('bounds queued unlock sounds and drains them with the live throttle', async () => {
    vi.useFakeTimers();
    let resolveResume!: () => void;
    FakeAudioContext.resumeHandlers.push(() => new Promise<void>((resolve) => { resolveResume = resolve; }));
    const sound = await import('@web/lib/sound-feedback');

    const unlock = sound.unlockRequestAudio();
    const context = FakeAudioContext.instances[0]!;
    sound.playRequestSound('success');
    await vi.advanceTimersByTimeAsync(500);
    sound.playRequestSound('http-error');
    await vi.advanceTimersByTimeAsync(500);
    sound.playRequestSound('network-error');
    await vi.advanceTimersByTimeAsync(500);
    sound.playRequestSound('timeout');
    await vi.advanceTimersByTimeAsync(500);
    sound.playRequestSound('success');

    resolveResume();
    await expect(unlock).resolves.toBe(true);
    // The queue retains the newest four outcomes, dropping the oldest one.
    expect(context.oscillators).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3 * 450);
    expect(context.oscillators.map((oscillator) => oscillator.frequency.value)).toEqual([
      392, 294, // http-error (the first queued success was dropped)
      440, 330, 247, // network-error
      330, 220, // timeout
      660, 880, // newest success
    ]);
  });

  it('waits for pending live sounds before playing a manual preview', async () => {
    vi.useFakeTimers();
    let resolveResume!: () => void;
    FakeAudioContext.resumeHandlers.push(() => new Promise<void>((resolve) => { resolveResume = resolve; }));
    const sound = await import('@web/lib/sound-feedback');

    const unlock = sound.unlockRequestAudio();
    const context = FakeAudioContext.instances[0]!;
    sound.playRequestSound('http-error');
    const preview = sound.previewRequestSound('success');
    resolveResume();
    await expect(unlock).resolves.toBe(true);
    expect(context.oscillators).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(450);
    await expect(preview).resolves.toBe(true);
    expect(context.oscillators).toHaveLength(4);
  });

  it('does not let a stale resume promise overwrite a replacement context unlock', async () => {
    let resolveOld!: () => void;
    FakeAudioContext.resumeHandlers.push(() => new Promise<void>((resolve) => { resolveOld = resolve; }));
    const sound = await import('@web/lib/sound-feedback');

    const oldUnlock = sound.unlockRequestAudio();
    const oldContext = FakeAudioContext.instances[0]!;
    sound.playRequestSound('http-error');
    sound.disposeRequestAudio();

    await expect(sound.unlockRequestAudio()).resolves.toBe(true);
    const currentContext = FakeAudioContext.instances[1]!;
    resolveOld();
    await expect(oldUnlock).resolves.toBe(false);

    expect(currentContext.oscillators).toHaveLength(0);
    sound.playRequestSound('success');
    expect(currentContext.oscillators).toHaveLength(2);
    expect(currentContext.state).toBe('running');
    expect(oldContext.close).toHaveBeenCalledTimes(1);
  });

  it('does not dispose a preview context if live sound is enabled while resume is pending', async () => {
    vi.useFakeTimers();
    let resolveResume!: () => void;
    FakeAudioContext.resumeHandlers.push(() => new Promise<void>((resolve) => { resolveResume = resolve; }));
    const sound = await import('@web/lib/sound-feedback');

    const preview = sound.previewRequestSound('success', { disposeAfter: true });
    const context = FakeAudioContext.instances[0]!;
    sound.cancelPendingAudioDisposal(); // same signal used when live sound is enabled
    resolveResume();

    await expect(preview).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(context.close).not.toHaveBeenCalled();
    sound.playRequestSound('http-error');
    expect(context.oscillators).toHaveLength(4);
  });

  it('replaces an AudioContext that the browser has already closed', async () => {
    const sound = await import('@web/lib/sound-feedback');
    await expect(sound.unlockRequestAudio()).resolves.toBe(true);
    const closedContext = FakeAudioContext.instances[0]!;
    closedContext.state = 'closed';

    await expect(sound.unlockRequestAudio()).resolves.toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[1]!.state).toBe('running');
  });

  it('disconnects already-created nodes if a later oscillator fails to start', async () => {
    FakeAudioContext.throwOnStartCall = 2;
    const sound = await import('@web/lib/sound-feedback');
    await sound.unlockRequestAudio();
    sound.playRequestSound('success');

    const context = FakeAudioContext.instances[0]!;
    expect(context.oscillators).toHaveLength(2);
    expect(context.oscillators.every((oscillator) => oscillator.disconnect.mock.calls.length > 0)).toBe(true);
    expect(context.gains.every((gain) => gain.disconnect.mock.calls.length > 0)).toBe(true);
  });

  it('disconnects created nodes if AudioNode connection fails', async () => {
    const sound = await import('@web/lib/sound-feedback');
    await sound.unlockRequestAudio();
    FakeOscillator.throwOnConnect = true;

    sound.playRequestSound('success');

    const context = FakeAudioContext.instances[0]!;
    expect(context.oscillators[0]!.disconnect).toHaveBeenCalled();
    expect(context.gains[0]!.disconnect).toHaveBeenCalled();
  });
});
