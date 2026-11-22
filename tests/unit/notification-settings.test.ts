import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), disposeAudio: vi.fn() }));
vi.mock('@web/lib/api', () => ({ api: { get: mocks.get, patch: mocks.patch } }));
vi.mock('@web/lib/sound-feedback', () => ({ disposeRequestAudio: mocks.disposeAudio }));

describe('notification preference store', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.get.mockReset();
    mocks.patch.mockReset();
    mocks.disposeAudio.mockReset();
  });

  it('does not mark preferences ready after a failed fetch and retries successfully', async () => {
    mocks.get
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ settings: { notificationsEnabled: false, notificationSoundEnabled: false } });
    const store = await import('@web/lib/notification-settings');

    expect(await store.loadNotificationPrefs()).toBe(false);
    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: true, sound: true });
    expect(await store.loadNotificationPrefs()).toBe(true);
    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: false, sound: false });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight non-forced load', async () => {
    let resolve!: (value: { settings: { notificationsEnabled: boolean; notificationSoundEnabled: boolean } }) => void;
    mocks.get.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const store = await import('@web/lib/notification-settings');

    const first = store.loadNotificationPrefs();
    const second = store.loadNotificationPrefs();
    expect(first).toBe(second);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    resolve({ settings: { notificationsEnabled: true, notificationSoundEnabled: false } });
    await expect(first).resolves.toBe(true);
    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: true, sound: false });
  });

  it('prevents an older forced-load response from overwriting a newer one', async () => {
    let resolveOld!: (value: { settings: { notificationsEnabled: boolean; notificationSoundEnabled: boolean } }) => void;
    mocks.get
      .mockReturnValueOnce(new Promise((done) => { resolveOld = done; }))
      .mockResolvedValueOnce({ settings: { notificationsEnabled: false, notificationSoundEnabled: false } });
    const store = await import('@web/lib/notification-settings');

    const oldLoad = store.loadNotificationPrefs();
    const newLoad = store.loadNotificationPrefs(true);
    await expect(newLoad).resolves.toBe(true);
    resolveOld({ settings: { notificationsEnabled: true, notificationSoundEnabled: true } });
    await oldLoad;

    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: false, sound: false });
  });

  it('invalidates an in-flight read after a successful preference save', async () => {
    let resolveOld!: (value: { settings: { notificationsEnabled: boolean; notificationSoundEnabled: boolean } }) => void;
    mocks.get.mockReturnValueOnce(new Promise((done) => { resolveOld = done; }));
    mocks.patch.mockResolvedValueOnce({ ok: true });
    const store = await import('@web/lib/notification-settings');

    const oldLoad = store.loadNotificationPrefs();
    const save = store.saveNotificationPrefs({ enabled: false });
    resolveOld({ settings: { notificationsEnabled: true, notificationSoundEnabled: true } });
    await Promise.all([oldLoad, save]);

    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: false, sound: true });
  });

  it('loads the untouched persisted preference before applying an early partial save', async () => {
    mocks.get.mockResolvedValueOnce({ settings: { notificationsEnabled: false, notificationSoundEnabled: true } });
    mocks.patch.mockResolvedValueOnce({ ok: true });
    const store = await import('@web/lib/notification-settings');

    await store.saveNotificationPrefs({ sound: false });

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith('/api/admin/settings', { notificationSoundEnabled: false });
    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: false, sound: false });
  });

  it('fails closed instead of saving a partial preference when the initial load fails', async () => {
    mocks.get.mockRejectedValueOnce(new Error('offline'));
    const store = await import('@web/lib/notification-settings');

    await expect(store.saveNotificationPrefs({ sound: false })).rejects.toThrow('Could not load saved notification preferences');
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: true, sound: true });
  });

  it('publishes a sound opt-in while PATCH is pending and rolls it back on failure', async () => {
    let rejectPatch!: (error: Error) => void;
    mocks.get.mockResolvedValueOnce({ settings: { notificationsEnabled: false, notificationSoundEnabled: false } });
    mocks.patch.mockReturnValueOnce(new Promise((_, reject) => { rejectPatch = reject; }));
    const store = await import('@web/lib/notification-settings');
    await store.loadNotificationPrefs();

    const save = store.saveNotificationPrefs({ sound: true });
    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: false, sound: true });
    rejectPatch(new Error('permission denied'));
    await expect(save).rejects.toThrow('permission denied');
    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: false, sound: false });
  });

  it('disposes the audio context only after a sound-disable PATCH succeeds', async () => {
    let resolvePatch!: (value: { ok: true }) => void;
    mocks.get.mockResolvedValueOnce({ settings: { notificationsEnabled: true, notificationSoundEnabled: true } });
    mocks.patch.mockReturnValueOnce(new Promise((resolve) => { resolvePatch = resolve; }));
    const store = await import('@web/lib/notification-settings');
    await store.loadNotificationPrefs();

    const save = store.saveNotificationPrefs({ sound: false });
    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: true, sound: false });
    expect(mocks.disposeAudio).not.toHaveBeenCalled();

    resolvePatch({ ok: true });
    await save;
    expect(mocks.disposeAudio).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing audio context when a sound-disable PATCH fails and rolls back', async () => {
    let rejectPatch!: (error: Error) => void;
    mocks.get.mockResolvedValueOnce({ settings: { notificationsEnabled: true, notificationSoundEnabled: true } });
    mocks.patch.mockReturnValueOnce(new Promise((_, reject) => { rejectPatch = reject; }));
    const store = await import('@web/lib/notification-settings');
    await store.loadNotificationPrefs();

    const save = store.saveNotificationPrefs({ sound: false });
    expect(store.getNotificationPrefsSnapshot().sound).toBe(false);
    rejectPatch(new Error('offline'));
    await expect(save).rejects.toThrow('offline');

    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: true, sound: true });
    expect(mocks.disposeAudio).not.toHaveBeenCalled();
  });

  it('disposes a newly created audio context when a sound-enable PATCH fails and rolls back', async () => {
    mocks.get.mockResolvedValueOnce({ settings: { notificationsEnabled: true, notificationSoundEnabled: false } });
    mocks.patch.mockRejectedValueOnce(new Error('offline'));
    const store = await import('@web/lib/notification-settings');
    await store.loadNotificationPrefs();

    const save = store.saveNotificationPrefs({ sound: true });
    expect(store.getNotificationPrefsSnapshot().sound).toBe(true);
    await expect(save).rejects.toThrow('offline');

    expect(store.getNotificationPrefsSnapshot()).toEqual({ enabled: true, sound: false });
    expect(mocks.disposeAudio).toHaveBeenCalledTimes(1);
  });
});
