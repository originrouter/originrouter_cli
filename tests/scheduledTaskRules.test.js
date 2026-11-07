import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSchedule, normalizeScheduledTask, nextScheduledTime, resolveScheduledWallTime } from '../src/runtime/scheduledTaskRules.js';

const ms = Date.parse;
test('one-off and intervals compute the next instant without drift', () => {
  const once = normalizeSchedule({kind:'once', at:'2026-11-03T01:30:00Z'});
  assert.equal(nextScheduledTime(once, ms('2026-11-03T01:00Z')), ms(once.at));
  assert.equal(nextScheduledTime(once, ms(once.at)), null);
  const interval = normalizeSchedule({kind:'interval', seconds:3600, anchor:'2026-11-03T00:00Z'});
  assert.equal(nextScheduledTime(interval, ms('2026-11-03T05:12Z')), ms('2026-11-03T06:00Z'));
});
test('weekly calendar uses the specified time zone', () => {
  const schedule = normalizeSchedule({kind:'weekly', timezone:'Asia/Shanghai', days:[1,3,5], hour:9, minute:30});
  assert.equal(nextScheduledTime(schedule, ms('2026-11-02T02:00Z')), ms('2026-11-04T01:30Z'));
});
test('DST gaps advance to the first valid local minute, folds choose the first occurrence', () => {
  assert.equal(resolveScheduledWallTime({year:2026,month:3,day:8,hour:2,minute:30}, 'America/New_York'), ms('2026-03-08T07:00Z'));
  assert.equal(resolveScheduledWallTime({year:2026,month:11,day:1,hour:1,minute:30}, 'America/New_York'), ms('2026-11-01T05:30Z'));
});
test('invalid timezones, high-frequency schedules and unsupported agents are rejected', () => {
  assert.throws(() => normalizeSchedule({kind:'weekly', timezone:'Fake/Nowhere', days:[1],hour:0,minute:0}), /timezone/);
  assert.throws(() => normalizeSchedule({kind:'interval', seconds:1, anchor:'2026-01-01T00:00Z'}), /interval/);
  assert.throws(() => normalizeScheduledTask({id:'st_a',name:'A',schedule:{kind:'once',at:'2026-01-01T00:00Z'},launch:{agentType:'other',workspaceId:'w',initialMessage:'hi'}}), /unsupported agent/);
});
test('AI review schedules require a valid saved template before they can be created', () => {
  const task={id:'st_a',name:'A',schedule:{kind:'once',at:'2026-01-01T00:00Z'},launch:{agentType:'claude',workspaceId:'w',initialMessage:'hi',permissionProfile:'ai_review'}};
  assert.throws(() => normalizeScheduledTask(task), {code:'AI_REVIEW_POLICY_INVALID'});
  assert.throws(() => normalizeScheduledTask({...task,launch:{...task.launch,aiReviewPolicy:{}}}), {code:'AI_REVIEW_POLICY_INVALID'});
});
