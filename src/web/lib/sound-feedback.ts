export type RequestSoundKind = 'success' | 'http-error' | 'network-error' | 'timeout';

export interface RequestSoundEvent {
  success: boolean;
  errorType: string | null;
  httpStatus: number;
}

interface Tone {
  frequency: number;
  duration: number;
}

const patterns: Record<RequestSoundKind, Tone[]> = {
  success: [
    { frequency: 660, duration: 0.075 },
    { frequency: 880, duration: 0.105 },
  ],
  'http-error': [
    { frequency: 392, duration: 0.105 },
    { frequency: 294, duration: 0.135 },
  ],
  'network-error': [
    { frequency: 440, duration: 0.075 },
    { frequency: 330, duration: 0.075 },
    { frequency: 247, duration: 0.12 },
  ],
  timeout: [
    { frequency: 330, duration: 0.14 },
    { frequency: 220, duration: 0.18 },
  ],
};

const MIN_SOUND_INTERVAL_MS = 450;
const MAX_PENDING_UNLOCK_SOUNDS = 4;
let audioContext: AudioContext | null = null;
let audioUnlocked = false;
let audioUnlockContext: AudioContext | null = null;
let audioUnlockPromise: Promise<boolean> | null = null;
let lastPlayedAt = 0;
let previewDisposeTimer: ReturnType<typeof setTimeout> | null = null;
let previewGeneration = 0;
let pendingUnlockContext: AudioContext | null = null;
let pendingUnlockSounds: RequestSoundKind[] = [];
let pendingUnlockSoundTimer: ReturnType<typeof setTimeout> | null = null;
let pendingUnlockFlushPromise: Promise<void> | null = null;
let resolvePendingUnlockFlush: (() => void) | null = null;
let lastQueuedSoundAt: number | null = null;
const activeNodes = new Set<{ oscillator: OscillatorNode; gain: GainNode }>();

function clearPendingUnlockSounds(context?: AudioContext): void {
  if (context && pendingUnlockContext !== context) return;
  pendingUnlockSounds = [];
  pendingUnlockContext = null;
  lastQueuedSoundAt = null;
  if (pendingUnlockSoundTimer !== null) clearTimeout(pendingUnlockSoundTimer);
  pendingUnlockSoundTimer = null;
  const resolve = resolvePendingUnlockFlush;
  resolvePendingUnlockFlush = null;
  pendingUnlockFlushPromise = null;
  resolve?.();
}

function queuePendingUnlockSound(context: AudioContext, kind: RequestSoundKind): void {
  if (!audioUnlockPromise || audioUnlockContext !== context) return;
  if (pendingUnlockContext !== context) {
    clearPendingUnlockSounds();
    pendingUnlockContext = context;
  }

  const now = Date.now();
  const lastAcceptedAt = pendingUnlockSounds.length > 0 ? lastQueuedSoundAt : (lastPlayedAt > 0 ? lastPlayedAt : null);
  if (lastAcceptedAt !== null && now - lastAcceptedAt < MIN_SOUND_INTERVAL_MS) return;

  // Prefer the newest outcomes when the small pending buffer is full.
  if (pendingUnlockSounds.length >= MAX_PENDING_UNLOCK_SOUNDS) pendingUnlockSounds.shift();
  pendingUnlockSounds.push(kind);
  lastQueuedSoundAt = now;
}

function flushPendingUnlockSounds(context: AudioContext): void {
  if (audioContext !== context || pendingUnlockContext !== context || pendingUnlockSoundTimer !== null) return;
  if (pendingUnlockSounds.length === 0) {
    pendingUnlockContext = null;
    lastQueuedSoundAt = null;
    return;
  }

  pendingUnlockFlushPromise ??= new Promise<void>((resolve) => { resolvePendingUnlockFlush = resolve; });
  const finish = (): void => {
    pendingUnlockContext = null;
    lastQueuedSoundAt = null;
    const resolve = resolvePendingUnlockFlush;
    resolvePendingUnlockFlush = null;
    pendingUnlockFlushPromise = null;
    resolve?.();
  };
  const drain = (): void => {
    pendingUnlockSoundTimer = null;
    if (audioContext !== context || pendingUnlockContext !== context || !audioUnlocked || context.state !== 'running') {
      clearPendingUnlockSounds(context);
      return;
    }

    const next = pendingUnlockSounds.shift();
    if (next) playPattern(next, false);
    if (pendingUnlockSounds.length > 0) {
      const delay = Math.max(0, MIN_SOUND_INTERVAL_MS - (Date.now() - lastPlayedAt));
      pendingUnlockSoundTimer = setTimeout(drain, delay);
      return;
    }

    // Keep previews behind the final queued live tone instead of overlapping
    // it, while leaving preview playback outside the live throttle itself.
    const delay = Math.max(0, MIN_SOUND_INTERVAL_MS - (Date.now() - lastPlayedAt));
    if (delay > 0) {
      pendingUnlockSoundTimer = setTimeout(() => {
        pendingUnlockSoundTimer = null;
        finish();
      }, delay);
      return;
    }
    finish();
  };
  drain();
}

async function waitForPendingUnlockSoundFlush(): Promise<void> {
  const pending = pendingUnlockFlushPromise;
  if (pending) await pending;
}

export function classifyRequestSound(event: RequestSoundEvent): RequestSoundKind | null {
  const errorType = event.errorType?.toLowerCase() ?? '';

  if (event.httpStatus === 499 || /client[_-]?disconnected|cancel(?:led|ed)?|abort|disconnect/.test(errorType)) {
    return null;
  }
  if (event.success) return 'success';
  // RequestLogSummary.errorType stores the canonical GatewayError type, not
  // the lower-level attempt failure code (`first_token_timeout`, etc.).
  if (errorType === 'timeout_error' || errorType.includes('timeout')) return 'timeout';
  if (errorType === 'upstream_unavailable' || /network|connection|socket/.test(errorType)) return 'network-error';
  return 'http-error';
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null;
  try {
    if (audioContext?.state === 'closed') {
      clearPendingUnlockSounds(audioContext);
      audioContext = null;
      audioUnlocked = false;
      audioUnlockContext = null;
      audioUnlockPromise = null;
    }
    audioContext ??= new window.AudioContext();
    return audioContext;
  } catch {
    return null;
  }
}

export async function unlockRequestAudio(): Promise<boolean> {
  const context = getAudioContext();
  if (!context) return false;
  if (context.state === 'running') {
    audioUnlocked = audioContext === context;
    if (audioUnlocked) flushPendingUnlockSounds(context);
    return audioUnlocked;
  }
  if (audioUnlockPromise && audioUnlockContext === context) return audioUnlockPromise;

  const pendingUnlock = (async (): Promise<boolean> => {
    try {
      await context.resume();
      // A preference toggle may have disposed this context while resume() was
      // pending. Never let an old promise mutate the replacement context state.
      if (audioContext !== context) return false;
      audioUnlocked = context.state === 'running';
      if (audioUnlocked) flushPendingUnlockSounds(context);
      else clearPendingUnlockSounds(context);
      return audioUnlocked;
    } catch {
      if (audioContext === context) {
        audioUnlocked = false;
        clearPendingUnlockSounds(context);
      }
      return false;
    }
  })();
  audioUnlockContext = context;
  audioUnlockPromise = pendingUnlock;
  try {
    return await pendingUnlock;
  } finally {
    if (audioUnlockPromise === pendingUnlock) {
      audioUnlockPromise = null;
      audioUnlockContext = null;
    }
  }
}

export function installAudioUnlockListeners(): () => void {
  if (typeof document === 'undefined') return () => undefined;

  const cleanup = () => {
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('touchstart', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  const unlock = () => {
    if (!audioContext || audioContext.state !== 'running') void unlockRequestAudio();
  };

  document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  document.addEventListener('touchstart', unlock, { capture: true, passive: true });
  document.addEventListener('keydown', unlock, true);
  return cleanup;
}

function playPattern(kind: RequestSoundKind, force: boolean): boolean {
  const context = audioContext;
  if (!audioUnlocked || !context || context.state !== 'running') return false;

  const now = Date.now();
  if (!force && now - lastPlayedAt < MIN_SOUND_INTERVAL_MS) return false;
  // Manual previews must not suppress a real request completion immediately
  // afterwards; the throttle applies only to live notification sounds.
  if (!force) lastPlayedAt = now;

  const scheduledNodes: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];
  try {
    let startsAt = context.currentTime + 0.015;
    for (const tone of patterns[kind]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const nodes = { oscillator, gain };
      // Track nodes before connecting them: a connect() failure must still be
      // able to disconnect every node created for this pattern.
      activeNodes.add(nodes);
      scheduledNodes.push(nodes);
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(tone.frequency, startsAt);
      gain.gain.setValueAtTime(0.0001, startsAt);
      gain.gain.exponentialRampToValueAtTime(0.055, startsAt + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + tone.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        activeNodes.delete(nodes);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(startsAt);
      oscillator.stop(startsAt + tone.duration + 0.01);
      startsAt += tone.duration + 0.025;
    }
    return true;
  } catch {
    for (const nodes of scheduledNodes) {
      activeNodes.delete(nodes);
      nodes.oscillator.onended = null;
      try { nodes.oscillator.stop(); } catch { /* oscillator may not have started */ }
      try { nodes.oscillator.disconnect(); } catch { /* already disconnected */ }
      try { nodes.gain.disconnect(); } catch { /* already disconnected */ }
    }
    return false;
  }
}

export function playRequestSound(kind: RequestSoundKind): void {
  const context = audioContext;
  if (!audioUnlocked || !context || context.state !== 'running') {
    if (context) queuePendingUnlockSound(context, kind);
    return;
  }
  playPattern(kind, false);
}

export async function previewRequestSound(kind: RequestSoundKind, options: { disposeAfter?: boolean } = {}): Promise<boolean> {
  const generation = ++previewGeneration;
  if (previewDisposeTimer !== null) clearTimeout(previewDisposeTimer);
  previewDisposeTimer = null;

  const context = getAudioContext();
  if (!context) return false;
  if (!await unlockRequestAudio()) {
    if (options.disposeAfter && generation === previewGeneration && audioContext === context) disposeRequestAudio();
    return false;
  }
  // A live completion queued during this same unlock must finish first; a
  // manual preview remains independent of the live 450 ms throttle.
  await waitForPendingUnlockSoundFlush();
  if (audioContext !== context || !audioUnlocked) return false;

  const played = playPattern(kind, true);
  if (options.disposeAfter && generation === previewGeneration && audioContext === context) {
    if (!played) {
      disposeRequestAudio();
    } else {
      const durationMs = patterns[kind].reduce((total, tone) => total + tone.duration + 0.025, 0) * 1000 + 100;
      previewDisposeTimer = setTimeout(() => {
        previewDisposeTimer = null;
        if (generation === previewGeneration && audioContext === context) disposeRequestAudio();
      }, durationMs);
    }
  }
  return played;
}

export function cancelPendingAudioDisposal(): void {
  // Invalidate previews still awaiting AudioContext.resume(), not just timers
  // that have already been scheduled.
  previewGeneration += 1;
  if (previewDisposeTimer !== null) clearTimeout(previewDisposeTimer);
  previewDisposeTimer = null;
}

export function disposeRequestAudio(): void {
  cancelPendingAudioDisposal();
  clearPendingUnlockSounds();
  for (const nodes of activeNodes) {
    nodes.oscillator.onended = null;
    try { nodes.oscillator.stop(); } catch { /* oscillator may already have ended */ }
    try { nodes.oscillator.disconnect(); } catch { /* already disconnected */ }
    try { nodes.gain.disconnect(); } catch { /* already disconnected */ }
  }
  activeNodes.clear();
  const context = audioContext;
  audioContext = null;
  audioUnlocked = false;
  audioUnlockContext = null;
  audioUnlockPromise = null;
  lastPlayedAt = 0;
  if (context && context.state !== 'closed') void context.close().catch(() => undefined);
}
