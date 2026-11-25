import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { closeDb,getRawDb,openDb } from '../../src/server/db';
import { loadCombo,type CandidateModel,type ComboPlan } from '../../src/server/routing/combo';
import {
  beginAdaptiveAttempt,claimAdaptiveExploration,claimAdaptiveProbe,listAdaptiveStates,recordAdaptiveOutcome,releaseAdaptiveProbe,
  type RecordAdaptiveOutcomeInput,
} from '../../src/server/routing/combo-adaptive-state';
import { INITIAL_PROBE_DELAY_MS,CONFIRM_PROBE_DELAY_MS,EXPLORATION_INTERVAL_MS,SAMPLE_TTL_MS,pickAdaptiveCandidate } from '../../src/server/routing/combo-policy';

const workload = 'stream:plain:short';
const alternateWorkload = 'complete:plain:short:short';
const A:CandidateModel = {modelId:'a',comboMemberId:'member-a',publicModelId:'p-a/a',upstreamModelId:'a',providerId:'p-a',enabled:true,upstreamAvailable:true,circuitOpen:false,providerEnabled:true,capabilities:{streaming:true}};
const B:CandidateModel = {...A,modelId:'b',comboMemberId:'member-b',publicModelId:'p-b/b',upstreamModelId:'b',providerId:'p-b'};
let dir:string | null = null;
let dbFile = '';
let plan:ComboPlan;
const candidates = [A,B];
const state = (candidate:CandidateModel = A,bucket = workload) => listAdaptiveStates('combo',bucket).find(s => s.memberId === candidate.comboMemberId);

function openFixture():void {
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'latedev-adaptive-state-'));
  dbFile=path.join(dir,'data.sqlite');
  openDb(dbFile);
  getRawDb().exec(`
    INSERT INTO providers(id,name,slug,type,base_url)
    VALUES ('p-a','A','p-a','openai','https://example.test'),('p-b','B','p-b','anthropic','https://example.test');
    INSERT INTO models(id,provider_id,upstream_model_id,public_model_id,display_name)
    VALUES ('a','p-a','a','p-a/a','A'),('b','p-b','b','p-b/b','B');
    INSERT INTO combos(id,name,slug,public_model_id,mode) VALUES ('combo','Combo','combo','combo','fallback');
    INSERT INTO combo_members(id,combo_id,model_id,position)
    VALUES ('member-a','combo','a',0),('member-b','combo','b',1);
  `);
  plan=loadCombo('combo')!;
}
afterEach(() => {
  closeDb();
  if(dir) fs.rmSync(dir,{recursive:true,force:true});
  dir=null;
});

function observe(candidate:CandidateModel,now:number,latencyMs:number|null,extra:Partial<RecordAdaptiveOutcomeInput>={}):void {
  recordAdaptiveOutcome({
    plan,candidate,workload,startedAtMs:now-1,now,kind:'success',latencyMs,role:'normal',
    comparableCandidates:candidates,learn:true,attemptFence:beginAdaptiveAttempt(),jitter:0,...extra,
  });
}
function slow(candidate:CandidateModel,start:number):number {
  for(let i=0;i<3;i++) observe(candidate,start+i,60_000,{kind:'soft_timeout'});
  return start+2;
}
function probe(candidate:CandidateModel,now:number,latencyMs:number|null,kind:RecordAdaptiveOutcomeInput['kind']='success'):void {
  const token = claimAdaptiveProbe(plan,candidate,workload,now,120_000);
  expect(token).toBeTruthy();
  observe(candidate,now+1,latencyMs,{kind,role:'probe',probeToken:token,startedAtMs:now});
}

describe('adaptive state repository', () => {
  it('records successful samples from unknown models and treats soft timeout as a censored observation', () => {
    openFixture();
    observe(A,1000,10_000);
    expect(state()).toMatchObject({samples:[{latencyMs:10_000,atMs:1000}],degraded:null});
    observe(A,1001,60_000,{kind:'soft_timeout'});
    observe(A,1002,65_000,{kind:'soft_timeout'});
    expect(state()).toMatchObject({consecutiveSlowCount:2,samples:[{latencyMs:10_000,atMs:1000}],degraded:null});
    observe(A,1003,12_000);
    expect(state()?.consecutiveSlowCount).toBe(0);
    const at=slow(A,1010);
    expect(state()).toMatchObject({consecutiveSlowCount:3,degraded:'absolute',probeDueMs:at+INITIAL_PROBE_DELAY_MS});
    expect(state()?.samples.map(s=>s.latencyMs)).toEqual([10_000,12_000]);
    for(let i=0;i<7;i++) observe(B,1020+i,10_000+i);
    expect(state(B)?.samples.map(s=>s.latencyMs)).toEqual([10002,10003,10004,10005,10006]);
    observe(A,1030,9000,{workload:alternateWorkload});
    expect(state(A,alternateWorkload)?.degraded).toBeNull();
    expect(state()?.degraded).toBe('absolute');
    expect(listAdaptiveStates('combo','unbounded')).toEqual([]);
  });

  it('demotes against a reliable comparator after three observations and requires two confirmed recoveries', () => {
    openFixture();
    for(let i=0;i<3;i++) observe(B,1000+i,8000);
    for(let i=0;i<3;i++) observe(A,1010+i,30_000);
    expect(state()).toMatchObject({degraded:'relative',relativeSlowCount:3,comparatorModelId:'b'});
    const due=state()!.probeDueMs!;
    expect(claimAdaptiveProbe(plan,A,workload,due-1,120_000)).toBeNull();
    probe(A,due,9000);
    expect(state()).toMatchObject({degraded:'relative',recoverySuccesses:1,probeDueMs:due+1+CONFIRM_PROBE_DELAY_MS,probeToken:null});
    probe(A,state()!.probeDueMs!,9000);
    expect(state()).toMatchObject({degraded:null,recoverySuccesses:0,relativeSlowCount:0,probeDueMs:null,probeToken:null});
    expect(pickAdaptiveCandidate({plan,candidates,states:listAdaptiveStates('combo',workload),attempted:new Set(),softTimedOut:new Set(),replayed:false,now:state()!.updatedAtMs})?.candidate.modelId).toBe('a');
  });

  it('rearms failed recovery probes with backoff, without promoting a single success', () => {
    openFixture();
    const at=slow(A,1000);
    for(let i=0;i<3;i++) observe(B,1010+i,9000);
    probe(A,at+INITIAL_PROBE_DELAY_MS,9000);
    expect(state()?.recoverySuccesses).toBe(1);
    const failedAt=state()!.probeDueMs!;
    probe(A,failedAt,null,'error');
    expect(state()).toMatchObject({degraded:'absolute',recoverySuccesses:0,probeFailures:1,probeDueMs:failedAt+1+30_000});
    const failedAgain=state()!.probeDueMs!;
    probe(A,failedAgain,null,'error');
    expect(state()).toMatchObject({probeFailures:2,probeDueMs:failedAgain+1+60_000});
  });

  it('permits all-slow equivalent primary failback and does not immediately demote it again', () => {
    openFixture();
    for(let i=0;i<3;i++) observe(A,1000+i,70_000);
    expect(state()?.degraded).toBe('absolute');
    for(let i=0;i<3;i++) observe(B,1010+i,72_000);
    expect(state(B)?.degraded).toBeNull();
    probe(A,state()!.probeDueMs!,70_000);
    expect(state()?.recoverySuccesses).toBe(1);
    probe(A,state()!.probeDueMs!,70_000);
    expect(state()?.degraded).toBeNull();
    const after=state()!.updatedAtMs;
    for(let i=1;i<=5;i++) observe(A,after+i,70_000);
    expect(state()?.degraded).toBeNull();
    expect(pickAdaptiveCandidate({plan,candidates,states:listAdaptiveStates('combo',workload),attempted:new Set(),softTimedOut:new Set(),replayed:false,now:after+5})).toMatchObject({candidate:{modelId:'a'},softTimeout:false});
  });

  it('claims a probe atomically; expired owner cannot overwrite or release its successor', () => {
    openFixture();
    slow(A,1000);
    const due=state()!.probeDueMs!;
    const first=claimAdaptiveProbe(plan,A,workload,due,1000)!;
    expect(first).toBeTruthy();
    const firstFence=beginAdaptiveAttempt();
    for(let i=0;i<100;i++) expect(claimAdaptiveProbe(plan,A,workload,due,1000)).toBeNull();
    const second=claimAdaptiveProbe(plan,A,workload,due+1001,120_000)!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    const secondFence=beginAdaptiveAttempt();
    releaseAdaptiveProbe(plan,A,workload,first);
    observe(A,due+1002,9000,{role:'probe',probeToken:first,startedAtMs:due,attemptFence:firstFence});
    expect(state()?.probeToken).toBe(second);
    observe(A,due+1003,9000,{role:'reserve',startedAtMs:due+1001});
    expect(state()?.recoverySuccesses).toBe(0);
    expect(state()?.probeToken).toBe(second);
    observe(A,due+1004,9000,{role:'probe',probeToken:second,startedAtMs:due+1001,attemptFence:secondFence});
    expect(state()).toMatchObject({probeToken:null,recoverySuccesses:1});
  });

  it('uses dispatch order to fence late outcomes even when start timestamps are equal', () => {
    openFixture();
    const older=beginAdaptiveAttempt();
    const newer=beginAdaptiveAttempt();
    observe(A,2000,60_000,{kind:'soft_timeout',startedAtMs:1000,attemptFence:newer});
    observe(A,2001,8000,{startedAtMs:1000,attemptFence:older});
    expect(state()).toMatchObject({consecutiveSlowCount:1,samples:[],lastStartSequence:newer.sequence,lastOutcome:'soft_timeout'});
    const olderSlow=beginAdaptiveAttempt();
    const newerFast=beginAdaptiveAttempt();
    observe(A,3000,9000,{startedAtMs:2500,attemptFence:newerFast});
    observe(A,3001,60_000,{kind:'soft_timeout',startedAtMs:2500,attemptFence:olderSlow});
    expect(state()).toMatchObject({consecutiveSlowCount:0,lastOutcome:'success',lastStartSequence:newerFast.sequence});
  });

  it('fences member deletion/re-add and provider configuration changes', () => {
    openFixture();
    slow(A,1000);
    const stalePlan=plan;
    const staleFence=beginAdaptiveAttempt();
    const due=state()!.probeDueMs!;
    const staleToken=claimAdaptiveProbe(plan,A,workload,due,120_000)!;
    expect(staleToken).toBeTruthy();
    getRawDb().exec("DELETE FROM combo_members WHERE id='member-a'; INSERT INTO combo_members(id,combo_id,model_id,position) VALUES ('member-a-new','combo','a',0)");
    observe(A,due+1,9000,{role:'probe',probeToken:staleToken,attemptFence:staleFence,plan:stalePlan});
    expect(state()).toBeUndefined();
    const newA={...A,comboMemberId:'member-a-new'};
    plan=loadCombo('combo')!;
    observe(newA,due+2,9000);
    expect(state(newA)).toBeTruthy();
    const staleGeneration=plan;
    getRawDb().exec("UPDATE providers SET base_url='https://changed.example.test' WHERE id='p-a'");
    plan=loadCombo('combo')!;
    expect(plan.slowResponseGeneration).toBe(staleGeneration.slowResponseGeneration!+1);
    expect(state(newA)).toBeUndefined();
    observe(newA,due+3,60_000,{kind:'soft_timeout',plan:staleGeneration});
    expect(state(newA)).toBeUndefined();
  });

  it('claims exploration once per combo/workload interval and never learns synthetic traffic or cancel', () => {
    openFixture();
    expect(claimAdaptiveExploration(plan,workload,1000)).toBe(true);
    expect(claimAdaptiveExploration(plan,workload,1001)).toBe(false);
    expect(claimAdaptiveExploration(plan,alternateWorkload,1001)).toBe(true);
    expect(claimAdaptiveExploration(plan,workload,1000+EXPLORATION_INTERVAL_MS)).toBe(true);
    observe(A,1001,10000,{learn:false});
    observe(A,1002,10000,{kind:'cancel'});
    expect(state()).toBeUndefined();
    observe(A,1003,10000);
    expect(state()?.explorationDueMs).toBe(1000+2*EXPLORATION_INTERVAL_MS);
    getRawDb().exec("UPDATE models SET enabled=0 WHERE id='a'");
    expect(claimAdaptiveExploration(plan,workload,1000+2*EXPLORATION_INTERVAL_MS)).toBe(false);
  });

  it('expires stale evidence without losing a current active probe or reviving stale state on reopen', () => {
    openFixture();
    observe(A,1000,70_000,{kind:'soft_timeout'});
    observe(A,1000+SAMPLE_TTL_MS+1,8000);
    expect(state()).toMatchObject({consecutiveSlowCount:0,degraded:null,samples:[{latencyMs:8000,atMs:1000+SAMPLE_TTL_MS+1}]});
    const start=Date.now()-60_000;
    // A real fresh state and an old workload survive only according to TTL.
    observe(B,start,70_000,{kind:'soft_timeout'});
    observe(B,start+1,70_000,{kind:'soft_timeout'});
    observe(B,start+2,70_000,{kind:'soft_timeout'});
    const due=state(B)!.probeDueMs!;
    const token=claimAdaptiveProbe(plan,B,workload,due,120_000)!;
    expect(token).toBeTruthy();
    const oldFence=beginAdaptiveAttempt();
    const oldGeneration=plan.slowResponseGeneration!;
    closeDb();
    openDb(dbFile);
    plan=loadCombo('combo')!;
    expect(plan.slowResponseGeneration).toBe(oldGeneration+1);
    expect(state()).toBeUndefined();
    expect(state(B)).toMatchObject({degraded:'absolute',probeLeaseUntilMs:null,probeToken:null,lastStartSequence:0});
    observe(B,Date.now(),9000,{attemptFence:oldFence,plan});
    expect(state(B)?.samples).toEqual([]);
  });
});
