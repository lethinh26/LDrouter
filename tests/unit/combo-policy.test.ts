import { describe,expect,it } from 'vitest';
import type { CanonicalRequest } from '../../src/server/routing/capabilities';
import type { CandidateModel,ComboPlan } from '../../src/server/routing/combo';
import {
  classifyWorkload,median,freshSamples,reliableMedian,similarityMargin,demotionMargin,
  pickAdaptiveCandidate,probeDelayMs,SAMPLE_TTL_MS,WORKLOADS,type AdaptiveState,type AdaptivePickInput,
} from '../../src/server/routing/combo-policy';

const now = 1_000_000;
const workload = 'stream:plain:short';
const candidates: CandidateModel[] = ['a','b','c','d'].map(modelId => ({
  modelId,comboMemberId:'member-'+modelId,publicModelId:modelId,upstreamModelId:modelId,providerId:'p-'+modelId,
  enabled:true,upstreamAvailable:true,circuitOpen:false,providerEnabled:true,capabilities:{streaming:true},
}));
const plan: ComboPlan = {
  comboId:'combo',mode:'fallback',enabled:true,maxTotalAttempts:3,slowResponseFallbackEnabled:true,
  slowResponseThresholdMs:60_000,slowResponseMaxCount:3,slowResponseGeneration:1,
  members:candidates.map((c,position) => ({id:c.comboMemberId!,modelId:c.modelId,position,enabled:true})),
  trigger:{connection:true,connectTimeout:true,firstTokenTimeout:true,totalTimeout:true,on408:true,on429:true,on5xx:true},
};
const state = (modelId:string,latencies:number[],extra:Partial<AdaptiveState>={}):AdaptiveState => ({
  comboId:'combo',memberId:'member-'+modelId,modelId,workload,generation:1,
  samples:latencies.map((latencyMs,i) => ({latencyMs,atMs:now-1000+i})),
  consecutiveSlowCount:0,relativeSlowCount:0,degraded:null,comparatorModelId:null,
  probeDueMs:null,probeLeaseUntilMs:null,probeToken:null,recoverySuccesses:0,probeFailures:0,
  lastLatencyMs:latencies.at(-1) ?? null,lastOutcome:'success',updatedAtMs:now,lastObservationMs:now,
  lastStartMs:now-1000,lastStartSequence:1,baselineLatencyMs:null,suspectCount:0,explorationDueMs:null,
  ...extra,
});
const samples = (ms:number) => [ms,ms,ms];
const pick = (states:AdaptiveState[]=[],extra:Partial<AdaptivePickInput>={}) => pickAdaptiveCandidate({
  candidates:candidates.slice(0,2),plan,states,attempted:new Set(),softTimedOut:new Set(),replayed:false,now,...extra,
});
const selected = (decision:ReturnType<typeof pick>) => decision && [decision.candidate.modelId,decision.role,decision.softTimeout];
const absolute = (modelId:string,ms=70_000,extra:Partial<AdaptiveState>={}) =>
  state(modelId,samples(ms),{degraded:'absolute',consecutiveSlowCount:3,probeDueMs:now+30_000,...extra});
const relative = (modelId:string,comparatorModelId:string,ms=30_000,extra:Partial<AdaptiveState>={}) =>
  state(modelId,samples(ms),{degraded:'relative',relativeSlowCount:3,comparatorModelId,probeDueMs:now+30_000,...extra});

describe('adaptive workload and latency evidence', () => {
  it('has exactly 12 bounded workload buckets and separates stream, reasoning and output budget', () => {
    const base:CanonicalRequest = {model:'a',messages:[{role:'user',content:[{type:'text',text:'hello'}]}],stream:true};
    expect(WORKLOADS.size).toBe(12);
    expect(classifyWorkload(base)).toBe('stream:plain:short');
    expect(classifyWorkload({...base,reasoning:{effort:'high'}})).toBe('stream:reasoning:short');
    expect(classifyWorkload({...base,stream:false,maxOutputTokens:1024})).toBe('complete:plain:short:short');
    expect(classifyWorkload({...base,stream:false,maxOutputTokens:1025})).toBe('complete:plain:short:long');
    expect(classifyWorkload({...base,stream:false})).toBe('complete:plain:short:long');
    expect(classifyWorkload({...base,messages:[{role:'user',content:[{type:'text',text:'a'.repeat(32768)}]}]})).toBe('stream:plain:short');
    expect(classifyWorkload({...base,messages:[{role:'user',content:[{type:'text',text:'a'.repeat(32769)}]}]})).toBe('stream:plain:long');
    expect(classifyWorkload({...base,messages:[{role:'user',content:[{type:'image',image:{url:'data:'}}]}]})).toBe('stream:plain:long');
  });
  it('uses a five-sample median, requires three fresh samples and does not let a spike pin a route', () => {
    expect(median([])).toBeNull();
    expect(median([10,9,1000,11,12])).toBe(11);
    expect(median([4,2])).toBe(3);
    const s = state('a',[8,9,10,11,12,13,1000]);
    expect(freshSamples(s.samples,now).map(v=>v.latencyMs)).toEqual([10,11,12,13,1000]);
    expect(reliableMedian(s,now)).toBe(12);
    expect(reliableMedian(state('a',[10,20]),now)).toBeNull();
    expect(reliableMedian(state('a',[10,20,30],{samples:[{latencyMs:10,atMs:now-SAMPLE_TTL_MS-1},{latencyMs:20,atMs:now},{latencyMs:30,atMs:now+1}]}),now)).toBeNull();
    expect(similarityMargin(8_000)).toBe(2_000);
    expect(similarityMargin(30_000)).toBe(6_000);
    expect(demotionMargin(8_000)).toBe(3_000);
    expect(demotionMargin(30_000)).toBe(9_000);
    expect(probeDelayMs(0,0)).toBe(30_000);
    expect(probeDelayMs(1,0)).toBe(60_000);
    expect(probeDelayMs(2,0)).toBe(120_000);
    expect(probeDelayMs(3,0)).toBe(240_000);
    expect(probeDelayMs(4,1)).toBe(300_000);
  });
});

describe('adaptive candidate policy', () => {
  it('keeps priority on cold start, equivalent speed, sparse data, and one spike', () => {
    expect(selected(pick())).toEqual(['a','normal',true]);
    expect(selected(pick([state('a',samples(10_000)),state('b',samples(9_000))]))).toEqual(['a','normal',false]);
    expect(selected(pick([state('a',[30_000]),state('b',samples(8_000))]))?.slice(0,2)).toEqual(['a','normal']);
    expect(selected(pick([state('a',[10_000,11_000,100_000]),state('b',samples(9_000))]))?.[0]).toBe('a');
  });
  it('uses the reliable faster candidate after demotion and probes only when due', () => {
    const a = relative('a','b'); const b = state('b',samples(8_000));
    expect(selected(pick([a,b]))).toEqual(['b','normal',false]);
    expect(selected(pick([{...a,probeDueMs:now},b]))).toEqual(['a','probe',true]);
    expect(selected(pick([{...a,probeDueMs:now,probeLeaseUntilMs:now+1000,probeToken:'owner'},b]))?.[0]).toBe('b');
    expect(selected(pick([{...a,probeDueMs:now},b],{blockedProbes:new Set(['a'])}))?.[0]).toBe('b');
  });
  it('uses a slow reserve after B fails or is hard-blocked, never bypassing hard eligibility', () => {
    const states = [absolute('a'),state('b',samples(10_000))];
    expect(selected(pick(states))).toEqual(['b','normal',false]);
    expect(selected(pick(states,{attempted:new Set(['b'])}))).toEqual(['a','reserve',false]);
    expect(selected(pick(states,{candidates:[candidates[0]!,{...candidates[1]!,circuitOpen:true}]}))).toEqual(['a','reserve',false]);
    expect(pick(states,{candidates:candidates.slice(0,2).map(c=>({...c,circuitOpen:true}))})).toBeNull();
    expect(selected(pick(states,{candidates:[candidates[0]!]}))).toEqual(['a','reserve',false]);
  });
  it('replays a soft-aborted model once only after all untried candidates are exhausted', () => {
    const a = absolute('a'); const b = state('b',samples(9_000));
    const exhausted = {attempted:new Set(['a','b']),softTimedOut:new Set(['a']),actualAttempts:2};
    expect(selected(pick([a,b],{...exhausted,candidates:candidates.slice(0,3)}))?.[0]).toBe('c');
    expect(selected(pick([a,b],exhausted))).toEqual(['a','replay',false]);
    expect(pick([a,b],{...exhausted,replayed:true})).toBeNull();
    expect(pick([a,b],{...exhausted,plan:{...plan,maxTotalAttempts:2}})).toBeNull();
    expect(pick([a,b],{...exhausted,actualAttempts:3})).toBeNull();
    expect(pick([a,b],{...exhausted,softTimedOut:new Set()})).toBeNull();
    expect(pick([a,b],{...exhausted,candidates:[{...candidates[0]!,enabled:false},candidates[1]!]})).toBeNull();
  });
  it('does not soft-abort every model in an all-slow pool or when a probe is busy', () => {
    const a = absolute('a',70_000); const b = absolute('b',72_000);
    expect(selected(pick([a,b]))).toEqual(['a','reserve',false]);
    expect(selected(pick([{...a,probeDueMs:now},b]))).toEqual(['a','probe',false]);
    expect(selected(pick([{...a,probeDueMs:now,probeLeaseUntilMs:now+5000,probeToken:'owner'},b]))).toEqual(['a','reserve',false]);
    expect(selected(pick([state('a',samples(70_000)),state('b',samples(72_000))]))).toEqual(['a','normal',false]);
    expect(selected(pick([state('a',samples(70_000))],{candidates:[candidates[0]!]}))).toEqual(['a','normal',false]);
    expect(selected(pick([],{plan:{...plan,maxTotalAttempts:1}}))).toEqual(['a','normal',false]);
    expect(selected(pick([absolute('a',70_000,{probeDueMs:now}),state('b',samples(55_000))]))).toEqual(['a','probe',false]);
  });
  it('does not pin relative demotion to a dead or stale comparator; handles arbitrary N', () => {
    const a = relative('a','b'), b = state('b',samples(8_000));
    expect(selected(pick([a,b],{attempted:new Set(['b'])}))).toEqual(['a','normal',false]);
    expect(selected(pick([a,{...b,samples:b.samples.map(s=>({...s,atMs:now-SAMPLE_TTL_MS-1}))}]))?.[0]).toBe('a');
    const c = state('c',samples(9_000));
    expect(selected(pick([a,b,c],{candidates:[candidates[0]!,{...candidates[1]!,circuitOpen:true},candidates[2]!,candidates[3]!]}))?.[0]).toBe('c');
    expect(selected(pick([absolute('a',90_000),absolute('b',72_000),absolute('c',70_000),absolute('d',69_000)],{candidates}))?.[0]).toBe('b');
    expect(selected(pick([{...a,generation:2},b]))?.[0]).toBe('a');
    expect(selected(pick([{...a,memberId:'old-member'},b]))?.[0]).toBe('a');
  });
  it('explores only a suspect primary with insufficient fresh comparator evidence and a due claim', () => {
    const a = state('a',samples(50_000),{suspectCount:3});
    expect(selected(pick([a]))?.slice(0,2)).toEqual(['b','explore']);
    expect(selected(pick([{...a,explorationDueMs:now+1}]))?.[0]).toBe('a');
    expect(selected(pick([a,state('b',samples(10_000))]))?.[0]).toBe('a');
    expect(selected(pick([a],{allowExploration:false}))?.[0]).toBe('a');
    expect(selected(pick([state('a',samples(10_000))]))?.[0]).toBe('a');
    expect(selected(pick([a],{attempted:new Set(['b'])}))?.[0]).toBe('a');
  });
  it('disables learning policy and replay when adaptive switch is off', () => {
    expect(selected(pick([absolute('a'),state('b',samples(5_000))],{plan:{...plan,slowResponseFallbackEnabled:false}}))).toEqual(['a','normal',false]);
    expect(pick([absolute('a')],{plan:{...plan,slowResponseFallbackEnabled:false},attempted:new Set(['a','b']),softTimedOut:new Set(['a'])})).toBeNull();
    expect(pick([],{plan:{...plan,enabled:false}})).toBeNull();
  });
});
