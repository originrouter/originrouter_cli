// Device-local schedules. Times are UTC instants; weekly schedules retain
// their IANA timezone and wall time, so they survive daylight-saving changes.
import { normalizeAiReviewPolicySnapshot } from './aiReviewPolicy.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const formatters = new Map();

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_SCHEDULED_TASK' });
}
function text(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid(`${field} is required (max ${max})`);
  return value.trim();
}
function formatter(zone) {
  let result = formatters.get(zone);
  if (!result) {
    try {
      result = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
      result.format(0);
    } catch { throw invalid('invalid IANA timezone'); }
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value);
    formatters.set(zone, result);
  }
  return result;
}
function fields(ms, zone) {
  const result = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) {
    if (['year', 'month', 'day', 'hour', 'minute'].includes(part.type)) result[part.type] = Number(part.value);
  }
  return result;
}
function wallEpoch(part) {
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute);
}
function localFromEpoch(ms) {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}
function same(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

// Resolve repeated wall times to the first occurrence. If the wall clock
// jumps over a time, advance to the first existing local minute.
export function resolveScheduledWallTime(part, zone) {
  const wanted = wallEpoch(part);
  const offsets = new Set([-DAY, 0, DAY].map((delta) => {
    const anchor = wanted + delta;
    return wallEpoch(fields(anchor, zone)) - anchor;
  }));
  for (let minutes = 0; minutes <= 26 * 60; minutes += 1) {
    const local = localFromEpoch(wanted + minutes * MINUTE);
    const candidates = [];
    for (const offset of offsets) {
      const instant = wallEpoch(local) - offset;
      if (same(fields(instant, zone), local)) candidates.push(instant);
    }
    if (candidates.length) return Math.min(...candidates);
  }
  throw invalid('local time cannot be resolved');
}

export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('schedule is required');
  if (raw.kind === 'once') {
    const at = typeof raw.at === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw.at) ? Date.parse(raw.at) : NaN;
    if (!Number.isFinite(at)) throw invalid('once schedule requires an ISO time');
    return { kind: 'once', at: new Date(at).toISOString() };
  }
  if (raw.kind === 'interval') {
    const seconds = Number(raw.seconds);
    const anchor = typeof raw.anchor === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw.anchor) ? Date.parse(raw.anchor) : NaN;
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 366 * 24 * 3600 || !Number.isFinite(anchor)) {
      throw invalid('interval needs an anchor and an interval between 60 seconds and 366 days');
    }
    return { kind: 'interval', seconds, anchor: new Date(anchor).toISOString() };
  }
  if (raw.kind === 'weekly') {
    const timezone = text(raw.timezone, 100, 'timezone');
    formatter(timezone);
    const hour = Number(raw.hour), minute = Number(raw.minute);
    const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(Number))].sort((a,b) => a-b) : [];
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59
      || !days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw invalid('weekly time or weekdays are invalid');
    return { kind: 'weekly', timezone, hour, minute, days };
  }
  throw invalid('unsupported schedule kind');
}

export function nextScheduledTime(schedule, afterMs) {
  if (!Number.isFinite(afterMs)) throw invalid('invalid comparison time');
  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at);
    return at > afterMs ? at : null;
  }
  if (schedule.kind === 'interval') {
    const anchor = Date.parse(schedule.anchor), step = schedule.seconds * 1000;
    return afterMs < anchor ? anchor : anchor + (Math.floor((afterMs - anchor) / step) + 1) * step;
  }
  if (schedule.kind === 'weekly') {
    const now = fields(afterMs, schedule.timezone);
    const localMidnight = Date.UTC(now.year, now.month - 1, now.day);
    for (let offset = 0; offset <= 14; offset += 1) {
      const day = new Date(localMidnight + offset * DAY);
      const weekday = day.getUTCDay() || 7;
      if (!schedule.days.includes(weekday)) continue;
      const instant = resolveScheduledWallTime({year: day.getUTCFullYear(), month: day.getUTCMonth() + 1,
        day: day.getUTCDate(), hour: schedule.hour, minute: schedule.minute}, schedule.timezone);
      if (instant > afterMs) return instant;
    }
  }
  throw invalid('could not calculate next execution time');
}

export function normalizeScheduledTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('task must be an object');
  const id = text(raw.id, 64, 'id');
  if (!/^st_[A-Za-z0-9_-]{1,61}$/.test(id)) throw invalid('invalid task id');
  const name = text(raw.name, 120, 'name');
  if (raw.enabled != null && typeof raw.enabled !== 'boolean') throw invalid('enabled must be a boolean');
  const schedule = normalizeSchedule(raw.schedule);
  const source = raw.launch;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalid('launch is required');
  const agentType = text(source.agentType, 16, 'agentType');
  if (!['claude', 'codex'].includes(agentType)) throw invalid('unsupported agent');
  const workspaceId = text(source.workspaceId, 191, 'workspaceId');
  const initialMessage = text(source.initialMessage, 8192, 'initialMessage');
  const permissionProfile = source.permissionProfile || 'manual';
  if (!['manual', 'guarded', 'ai_review', 'custom', 'unrestricted'].includes(permissionProfile)) throw invalid('invalid permission profile');
  const launch = { agentType, workspaceId, initialMessage, permissionProfile };
  for (const key of ['provider', 'model', 'policyId', 'policyRevision']) {
    if (source[key] != null && source[key] !== '') launch[key] = text(source[key], 191, key);
  }
  for (const key of ['policyBundle', 'aiReviewPolicy', 'allowedScopes']) {
    if (source[key] != null) launch[key] = structuredClone(source[key]);
  }
  if (permissionProfile === 'ai_review') {
    launch.aiReviewPolicy = normalizeAiReviewPolicySnapshot(source.aiReviewPolicy, { required: true });
  }
  if (JSON.stringify(launch).length > 128_000) throw invalid('launch configuration is too large');
  return { id, name, enabled: raw.enabled !== false, schedule, launch };
}
