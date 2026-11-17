/**
 * Merging two copies of a player's Wobblix save (two devices, or a device that
 * was offline). "Further along wins": the copy with the higher progress score
 * is the base, and the parts that only ever grow are combined from both so
 * nothing earned on either side is lost.
 *
 * Save shape (SaveGame.toJson in the app):
 *  { v:1, done:{levelId:{best,stars:[bool],medal}}, ach:{id:unlockMs},
 *    daily:[dateKeys], dailyCount, plays, stats:{deaths,jumps,completions},
 *    cos:{color,face,hat,adUnlocked:[ids]}, set:{...},
 *    m:{sparks,spent,adsWatched,removeAds,starter,owned:[],cosOwned:[],
 *       solutions:[],tx:[],firstLaunch,sessions,consent,interLast,sinceInter,
 *       instant:{day,n},free:{day,n}} }
 */

const SAVE_VERSION = 1;
const MAX_PROGRESS_BYTES = 512 * 1024;
const MAX_ENTRIES = 5000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (isObj(v) ? v : {});
const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };

/** Returns an error string when [p] is not an acceptable Wobblix save, else null. */
function validateProgress(p) {
  if (!isObj(p)) return "progress must be an object";
  if (p.v !== SAVE_VERSION) return "unsupported progress version";
  for (const k of ["done", "ach", "stats", "cos", "set", "m"]) {
    if (p[k] !== undefined && !isObj(p[k])) return `progress.${k} must be an object`;
  }
  if (p.daily !== undefined && !Array.isArray(p.daily)) return "progress.daily must be an array";
  if (isObj(p.m)) {
    for (const k of ["owned", "cosOwned", "solutions", "tx"]) {
      if (p.m[k] !== undefined && !Array.isArray(p.m[k])) return `progress.m.${k} must be an array`;
    }
  }
  if (isObj(p.cos) && p.cos.adUnlocked !== undefined && !Array.isArray(p.cos.adUnlocked)) {
    return "progress.cos.adUnlocked must be an array";
  }
  if (Object.keys(obj(p.done)).length > MAX_ENTRIES || arr(p.daily).length > MAX_ENTRIES) return "progress too large";
  if (Buffer.byteLength(JSON.stringify(p)) > MAX_PROGRESS_BYTES) return "progress too large";
  return null;
}

function starCount(done) {
  let n = 0;
  for (const lvl of Object.values(done)) for (const s of arr(isObj(lvl) ? lvl.stars : null)) if (s === true) n++;
  return n;
}

/** How far along a save is; used to pick the base copy. */
function progressScore(p) {
  if (!isObj(p)) return 0;
  const done = obj(p.done);
  return (
    starCount(done) * 1000 +
    Object.keys(done).length * 50 +
    num(obj(p.stats).completions) * 5 +
    Object.keys(obj(p.ach)).length * 20 +
    arr(p.daily).length * 50
  );
}

function union(a, b) {
  return [...new Set([...arr(a), ...arr(b)])];
}

function maxMap(a, b) {
  const out = { ...obj(a) };
  for (const [k, v] of Object.entries(obj(b))) {
    if (typeof v === "number" || typeof out[k] === "number") out[k] = Math.max(num(out[k]), num(v));
    else if (!(k in out)) out[k] = v;
  }
  return out;
}

const positive = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

function minBest(a, b) {
  const x = positive(a);
  const y = positive(b);
  if (x === null) return y;
  if (y === null) return x;
  return Math.min(x, y);
}

function bestMedal(a, b) {
  const ra = MEDAL_RANK[a] || 0;
  const rb = MEDAL_RANK[b] || 0;
  if (!ra && !rb) return undefined;
  return ra >= rb ? a : b;
}

function mergeLevel(a, b) {
  if (!isObj(a)) return isObj(b) ? b : undefined;
  if (!isObj(b)) return a;
  const sa = arr(a.stars);
  const sb = arr(b.stars);
  const stars = Array.from({ length: Math.max(sa.length, sb.length) }, (_, i) => sa[i] === true || sb[i] === true);
  const out = { ...a, ...b, stars };
  const best = minBest(a.best, b.best);
  if (best !== null) out.best = best;
  else delete out.best;
  const medal = bestMedal(a.medal, b.medal);
  if (medal) out.medal = medal;
  else delete out.medal;
  return out;
}

function mergeDone(a, b) {
  const out = {};
  for (const id of new Set([...Object.keys(obj(a)), ...Object.keys(obj(b))])) {
    const lvl = mergeLevel(obj(a)[id], obj(b)[id]);
    if (lvl) out[id] = lvl;
  }
  return out;
}

function mergeAch(a, b) {
  const out = { ...obj(a) };
  for (const [id, ts] of Object.entries(obj(b))) {
    if (!(id in out)) out[id] = ts;
    else out[id] = minBest(out[id], ts) ?? out[id];
  }
  return out;
}

/** {day, n} daily-allowance counters: the later day wins, the same day keeps the higher count. */
function mergeDayCounter(a, b) {
  if (!isObj(a)) return isObj(b) ? b : a;
  if (!isObj(b)) return a;
  const da = String(a.day ?? "");
  const db = String(b.day ?? "");
  if (da === db) return { ...a, n: Math.max(num(a.n), num(b.n)) };
  return da > db ? a : b;
}

/** [base] is the copy that is further along, [other] the one merged into it, [newer] the later-saved. */
function mergeMeta(base, other, newer) {
  const b = obj(base);
  const o = obj(other);
  const n = obj(newer);
  const out = { ...o, ...b }; // unknown keys: base wins
  out.sparks = num(b.sparks); // never max: spending must stay spent
  out.spent = num(b.spent);
  out.adsWatched = Math.max(num(b.adsWatched), num(o.adsWatched));
  out.sessions = Math.max(num(b.sessions), num(o.sessions));
  delete out.plus; // Plus no longer exists
  out.removeAds = Boolean(b.removeAds || o.removeAds);
  out.starter = Boolean(b.starter || o.starter);
  for (const k of ["owned", "cosOwned", "solutions", "tx"]) out[k] = union(b[k], o[k]);
  const first = minBest(b.firstLaunch, o.firstLaunch);
  if (first !== null) out.firstLaunch = first;
  for (const k of ["consent", "interLast", "sinceInter"]) if (k in n) out[k] = n[k];
  for (const k of ["instant", "free"]) {
    const merged = mergeDayCounter(b[k], o[k]);
    if (merged !== undefined) out[k] = merged;
  }
  return out;
}

/** [a]/[b] are Wobblix saves; [bIsNewer] says which one was saved last. */
function mergeProgress(a, b, bIsNewer = true) {
  if (!isObj(a)) return isObj(b) ? b : {};
  if (!isObj(b)) return a;
  const sa = progressScore(a);
  const sb = progressScore(b);
  const bBase = sb > sa || (sb === sa && bIsNewer);
  const [base, other] = bBase ? [b, a] : [a, b];
  const newer = bIsNewer ? b : a;
  const out = {
    ...other,
    ...base,
    v: SAVE_VERSION,
    done: mergeDone(base.done, other.done),
    ach: mergeAch(base.ach, other.ach),
    daily: union(base.daily, other.daily),
    dailyCount: Math.max(num(base.dailyCount), num(other.dailyCount)),
    plays: Math.max(num(base.plays), num(other.plays)),
    stats: maxMap(base.stats, other.stats),
    cos: { ...obj(other.cos), ...obj(base.cos), ...obj(newer.cos), adUnlocked: union(base.cos?.adUnlocked, other.cos?.adUnlocked) },
    set: { ...obj(other.set), ...obj(base.set), ...obj(newer.set) },
    m: mergeMeta(base.m, other.m, newer.m),
  };
  return out;
}

function mergeSave(a, b, newerIsB) {
  if (!isObj(a)) return isObj(b) ? b : {};
  if (!isObj(b)) return a;
  const [newer, older] = newerIsB ? [b, a] : [a, b];
  return { ...older, ...newer };
}

/** [existing]/[incoming] are { progress, save, clientUpdatedAt } documents. */
function mergeGameData(existing, incoming) {
  const incomingNewer =
    new Date(incoming.clientUpdatedAt || 0).getTime() >=
    new Date(existing.clientUpdatedAt || 0).getTime();
  return {
    progress: mergeProgress(existing.progress, incoming.progress, incomingNewer),
    save: mergeSave(existing.save, incoming.save, incomingNewer),
  };
}

module.exports = { SAVE_VERSION, validateProgress, progressScore, mergeProgress, mergeSave, mergeGameData };
