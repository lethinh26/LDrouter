import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getRawDb, openDb } from '../../src/server/db';
import {
  COMBO_SLOW_FALLBACK_COOLDOWN_MS,
  claimComboSlowProbe,
  getComboSlowState,
  listComboSlowStates,
  recordComboSlowOutcome,
  releaseComboSlowProbe,
} from '../../src/server/routing/combo-slow-fallback';

let dataDir: string | null = null;

function openFixture(): void {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-combo-slow-'));
  openDb(path.join(dataDir, 'data.sqlite'));
  const raw = getRawDb();
  raw.prepare("INSERT INTO providers (id,name,slug,type,base_url) VALUES ('p1','P1','p1','openai','https://example.test')").run();
  raw.prepare("INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name) VALUES ('m1','p1','model-1','p1/model-1','Model 1')").run();
  raw.prepare("INSERT INTO combos (id,name,slug,public_model_id,mode) VALUES ('c1','Combo 1','combo-1','combo/combo-1','fallback')").run();
  raw.prepare("INSERT INTO combo_members (id,combo_id,model_id,position) VALUES ('cm1','c1','m1',0)").run();
}

afterEach(() => {
  closeDb();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

describe('combo slow-response state', () => {
  it('starts cooldown after the configured number of consecutive slow outcomes', () => {
    openFixture();
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 61_000, 1_000);
    expect(getComboSlowState('c1', 'm1')).toMatchObject({ consecutiveSlowCount: 1, cooldownUntilMs: null });
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 62_000, 2_000);
    expect(getComboSlowState('c1', 'm1')).toMatchObject({ consecutiveSlowCount: 2, cooldownUntilMs: null });

    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 63_000, 3_000);
    expect(getComboSlowState('c1', 'm1')).toMatchObject({
      consecutiveSlowCount: 3,
      cooldownUntilMs: 3_000 + COMBO_SLOW_FALLBACK_COOLDOWN_MS,
      lastOutcome: 'slow',
    });
    expect(claimComboSlowProbe('c1', 'm1', 'cm1', 4_000)).toBe(false);
  });

  it('grants only one recovery probe after cooldown and rearms cooldown on probe failure', () => {
    openFixture();
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 1, 70_000, 1_000);
    const cooldownUntil = 1_000 + COMBO_SLOW_FALLBACK_COOLDOWN_MS;

    expect(claimComboSlowProbe('c1', 'm1', 'cm1', cooldownUntil - 1)).toBe(false);
    const probeStartedAt = cooldownUntil + 1;
    const longThresholdLease = 630_000;
    expect(claimComboSlowProbe('c1', 'm1', 'cm1', probeStartedAt, longThresholdLease)).toBe(true);
    expect(claimComboSlowProbe('c1', 'm1', 'cm1', probeStartedAt + 1, longThresholdLease)).toBe(false);
    expect(getComboSlowState('c1', 'm1')?.probeLeaseUntilMs).toBe(probeStartedAt + longThresholdLease);

    releaseComboSlowProbe('c1', 'm1', 'cm1', true, probeStartedAt + 2);
    expect(getComboSlowState('c1', 'm1')).toMatchObject({
      consecutiveSlowCount: 1,
      cooldownUntilMs: probeStartedAt + 2 + COMBO_SLOW_FALLBACK_COOLDOWN_MS,
      probeLeaseUntilMs: null,
      lastOutcome: 'error',
    });
  });

  it('resets the consecutive count and cooldown after a fast response', () => {
    openFixture();
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 61_000, 1_000);
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 62_000, 2_000);
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'fast', 3, 12_000, 3_000);

    expect(getComboSlowState('c1', 'm1')).toMatchObject({
      consecutiveSlowCount: 0,
      cooldownUntilMs: null,
      probeLeaseUntilMs: null,
      lastLatencyMs: 12_000,
      lastOutcome: 'fast',
    });
    expect(listComboSlowStates('c1')).toHaveLength(1);
  });

  it('does not recreate state for a member removed while its request is still in flight', () => {
    openFixture();
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 70_000, 1_000, 1);
    const raw = getRawDb();
    raw.prepare("DELETE FROM combo_members WHERE combo_id='c1' AND model_id='m1'").run();

    expect(() => recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 80_000, 2_000, 1)).not.toThrow();
    expect(getComboSlowState('c1', 'm1')).toBeNull();
  });

  it('ignores late outcomes from an older slow-response configuration generation', () => {
    openFixture();
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 70_000, 1_000, 1);
    getRawDb().prepare("UPDATE combos SET slow_response_generation=2 WHERE id='c1'").run();
    getRawDb().prepare("DELETE FROM combo_member_slow_states WHERE combo_id='c1'").run();

    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 3, 80_000, 2_000, 1);
    expect(getComboSlowState('c1', 'm1')).toBeNull();
  });

  it('does not let a stale combo plan claim a recovery probe after settings change', () => {
    openFixture();
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 1, 70_000, 1_000, 1);
    const cooldownUntil = 1_000 + COMBO_SLOW_FALLBACK_COOLDOWN_MS;
    getRawDb().prepare("UPDATE combos SET slow_response_generation=2 WHERE id='c1'").run();

    expect(claimComboSlowProbe('c1', 'm1', 'cm1', cooldownUntil + 1, 120_000, 1)).toBe(false);
  });

  it('ignores stale slow, fast, probe-claim and probe-release operations after a member is re-added', () => {
    openFixture();
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 1, 70_000, 1_000);
    getRawDb().prepare("DELETE FROM combo_members WHERE id='cm1'").run();
    getRawDb().prepare("INSERT INTO combo_members (id,combo_id,model_id,position) VALUES ('cm2','c1','m1',0)").run();

    recordComboSlowOutcome('c1', 'm1', 'cm1', 'slow', 1, 80_000, 2_000);
    expect(getComboSlowState('c1', 'm1')).toBeNull();

    recordComboSlowOutcome('c1', 'm1', 'cm2', 'slow', 1, 70_000, 3_000);
    const cooldownUntil = 3_000 + COMBO_SLOW_FALLBACK_COOLDOWN_MS;
    expect(claimComboSlowProbe('c1', 'm1', 'cm2', cooldownUntil + 1, 120_000)).toBe(true);
    const claimed = getComboSlowState('c1', 'm1');
    expect(claimComboSlowProbe('c1', 'm1', 'cm1', cooldownUntil + 2, 120_000)).toBe(false);
    releaseComboSlowProbe('c1', 'm1', 'cm1', true, cooldownUntil + 3);
    recordComboSlowOutcome('c1', 'm1', 'cm1', 'fast', 1, 10_000, cooldownUntil + 4);
    expect(getComboSlowState('c1', 'm1')).toEqual(claimed);
  });
});
