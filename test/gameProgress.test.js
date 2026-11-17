const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeProgress, mergeSave, progressScore, validateProgress } = require("../services/gameProgressMerge");

// In-memory stand-in for the Mongoose model: no database needed.
const store = new Map();
const modelPath = require.resolve("../models/gameProgressModel");
function doc(d) {
  return { ...d, toObject: () => ({ ...d }) };
}
require.cache[modelPath] = {
  id: modelPath,
  filename: modelPath,
  loaded: true,
  exports: {
    findOne: (q) => ({ lean: async () => (store.get(String(q.userId)) ? { ...store.get(String(q.userId)) } : null) }),
    create: async (d) => {
      if (store.has(String(d.userId))) throw Object.assign(new Error("dup"), { code: 11000 });
      store.set(String(d.userId), { ...d, updatedAt: new Date() });
      return doc(store.get(String(d.userId)));
    },
    findOneAndUpdate: (q, update) => ({
      lean: async () => {
        const cur = store.get(String(q.userId));
        if (!cur || cur.revision !== q.revision) return null;
        const next = { ...cur, ...update.$set, revision: cur.revision + (update.$inc?.revision || 0), updatedAt: new Date() };
        store.set(String(q.userId), next);
        return { ...next };
      },
    }),
    deleteOne: async (q) => store.delete(String(q.userId)),
  },
};
// Verified purchases decide removeAds / starter (stubbed: no database).
const owned = { removeAds: false, starter: false };
const entPath = require.resolve("../services/entitlementService");
require.cache[entPath] = { id: entPath, filename: entPath, loaded: true, exports: { entitlementsFor: async () => ({ ...owned }) } };
const { getGameProgress, saveGameProgress, deleteGameProgress } = require("../controllers/gameProgressController");

function call(handler, userId, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ authUser: { _id: userId }, body }, res);
  });
}

const lvl = (best, stars, medal) => ({ best, stars, medal });
const base = () => ({
  v: 1,
  done: {},
  ach: {},
  daily: [],
  dailyCount: 0,
  plays: 0,
  stats: { deaths: 0, jumps: 0, completions: 0 },
  cos: { color: "mint", face: "smile", hat: "none", adUnlocked: [] },
  set: { sfx: true },
  m: { sparks: 100, spent: 0, adsWatched: 0, removeAds: false, starter: false, owned: [], cosOwned: [], solutions: [], tx: [] },
});
const withM = (over) => ({ ...base(), m: { ...base().m, ...over } });

test("first save creates revision 1 and get returns it", async () => {
  store.clear();
  const p = { ...base(), plays: 7 };
  const saved = await call(saveGameProgress, "u1", { progress: p, save: { x: 1 }, baseRevision: 0 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.equal(saved.body.merged, false);
  const got = await call(getGameProgress, "u1");
  assert.equal(got.body.progress.plays, 7);
  assert.equal(got.body.save.x, 1);
});

test("a fresh user has no data yet", async () => {
  store.clear();
  const got = await call(getGameProgress, "nobody");
  assert.equal(got.body.progress, null);
  assert.equal(got.body.revision, 0);
});

test("in-sync save overwrites, so spending sparks is kept", async () => {
  store.clear();
  await call(saveGameProgress, "u1", { progress: withM({ sparks: 900 }), baseRevision: 0 });
  const r = await call(saveGameProgress, "u1", { progress: withM({ sparks: 400, spent: 500 }), baseRevision: 1 });
  assert.equal(r.body.revision, 2);
  assert.equal(r.body.merged, false);
  assert.equal(r.body.progress.m.sparks, 400);
});

test("a stale device is merged, never overwriting progress from another", async () => {
  store.clear();
  const a = {
    ...base(),
    done: { l1: lvl(30, [true, true, false], "silver"), l2: lvl(50, [true, false, false], "bronze") },
    ach: { first: 1000, jump: 5000 },
    daily: ["2026-10-28"], plays: 10, dailyCount: 1,
    stats: { deaths: 5, jumps: 100, completions: 4 },
    cos: { color: "mint", face: "smile", hat: "cap", adUnlocked: ["hat1"] },
  };
  await call(saveGameProgress, "u1", { progress: a, baseRevision: 0, clientUpdatedAt: "2026-10-28T10:00:00Z" });
  const b = {
    ...base(),
    done: { l1: lvl(25, [true, false, true], "gold"), l3: lvl(70, [true, true, true], "gold") },
    ach: { first: 800, extra: 9000 },
    daily: ["2026-10-29"], plays: 3, dailyCount: 2,
    stats: { deaths: 9, jumps: 20, completions: 1 },
    cos: { color: "pink", face: "smile", hat: "none", adUnlocked: ["face2"] },
    set: { sfx: false },
  };
  const r = await call(saveGameProgress, "u1", { progress: b, baseRevision: 0, clientUpdatedAt: "2026-10-29T10:00:00Z" });
  assert.equal(r.body.merged, true);
  const m = r.body.progress;
  assert.deepEqual(m.done.l1, { best: 25, stars: [true, true, true], medal: "gold" });
  assert.deepEqual(Object.keys(m.done).sort(), ["l1", "l2", "l3"]);
  assert.deepEqual(m.ach, { first: 800, jump: 5000, extra: 9000 });
  assert.deepEqual(m.daily.sort(), ["2026-10-28", "2026-10-29"]);
  assert.equal(m.plays, 10);
  assert.equal(m.dailyCount, 2);
  assert.deepEqual(m.stats, { deaths: 9, jumps: 100, completions: 4 });
  assert.deepEqual(m.cos.adUnlocked.sort(), ["face2", "hat1"]);
  assert.equal(m.cos.color, "pink"); // selection from the newer copy
  assert.equal(m.set.sfx, false); // settings from the newer copy
});

test("invalid bodies are rejected", async () => {
  store.clear();
  assert.equal((await call(saveGameProgress, "u1", {})).status, 400);
  assert.equal((await call(saveGameProgress, "u1", { progress: [] })).status, 400);
  assert.equal((await call(saveGameProgress, "u1", { progress: { v: 2 } })).status, 400);
  assert.equal((await call(saveGameProgress, "u1", { progress: { v: 1, done: [] } })).status, 400);
  assert.equal((await call(saveGameProgress, "u1", { progress: { v: 1, m: { tx: "x" } } })).status, 400);
  assert.equal((await call(saveGameProgress, "u1", { progress: base(), save: 5 })).status, 400);
  const huge = { ...base(), set: { blob: "x".repeat(600 * 1024) } };
  assert.equal((await call(saveGameProgress, "u1", { progress: huge })).status, 413);
});

test("delete removes the data", async () => {
  store.clear();
  await call(saveGameProgress, "u1", { progress: base(), baseRevision: 0 });
  await call(deleteGameProgress, "u1");
  assert.equal((await call(getGameProgress, "u1")).body.progress, null);
});

test("progressScore weights stars, levels, completions, achievements and dailies", () => {
  const p = { v: 1, done: { a: lvl(10, [true, true], "gold") }, stats: { completions: 2 }, ach: { x: 1 }, daily: ["d"] };
  assert.equal(progressScore(p), 2 * 1000 + 50 + 2 * 5 + 20 + 50);
  assert.equal(progressScore(null), 0);
  assert.ok(progressScore({ done: { a: lvl(1, [true]) } }) > progressScore({ done: { a: lvl(1, []), b: lvl(1, []) } }));
});

test("merge: sparks come from the base copy, never max'd; flags OR; lists union", () => {
  const ahead = { ...base(), done: { l1: lvl(10, [true, true, true], "gold") }, m: { ...base().m, sparks: 20, spent: 300, owned: ["o1"], tx: ["t1"], removeAds: true } };
  const behind = { ...base(), m: { ...base().m, sparks: 900, spent: 0, owned: ["o2"], cosOwned: ["c1"], solutions: ["l1"], tx: ["t2"], starter: true, adsWatched: 4 } };
  const m = mergeProgress(behind, ahead).m;
  assert.equal(m.sparks, 20);
  assert.equal(m.spent, 300);
  assert.equal(m.removeAds, true);
  assert.equal(m.starter, true);
  assert.equal(m.adsWatched, 4);
  assert.deepEqual(m.owned.sort(), ["o1", "o2"]);
  assert.deepEqual(m.tx.sort(), ["t1", "t2"]);
  assert.deepEqual(m.cosOwned, ["c1"]);
  assert.deepEqual(m.solutions, ["l1"]);
  // Order of arguments does not change who the base is.
  assert.equal(mergeProgress(ahead, behind).m.sparks, 20);
});

test("merge: best time ignores empty values, medals rank, missing sides tolerated", () => {
  const a = { ...base(), done: { l1: { stars: [true], medal: "silver" } } };
  const b = { ...base(), done: { l1: lvl(44, [false, true], "bronze") } };
  const l = mergeProgress(a, b).done.l1;
  assert.equal(l.best, 44);
  assert.equal(l.medal, "silver");
  assert.deepEqual(l.stars, [true, true]);
  assert.equal(mergeProgress(null, base()).v, 1);
  assert.equal(mergeProgress(base(), undefined).v, 1);
});

test("merge: same-day allowance counters keep the higher count, later day wins", () => {
  const a = withM({ free: { day: "2026-10-29", n: 1 }, instant: { day: "2026-10-28", n: 5 } });
  const b = withM({ free: { day: "2026-10-29", n: 3 }, instant: { day: "2026-10-29", n: 1 } });
  const m = mergeProgress(a, b).m;
  assert.deepEqual(m.free, { day: "2026-10-29", n: 3 });
  assert.deepEqual(m.instant, { day: "2026-10-29", n: 1 });
});

test("validateProgress and mergeSave", () => {
  assert.equal(validateProgress(base()), null);
  assert.ok(validateProgress({ v: 1, daily: {} }));
  assert.equal(mergeSave({ a: 1 }, { b: 2 }, true).a, 1);
});

test("removeAds / starter come from verified purchases, never from the app", async () => {
  store.clear();
  Object.assign(owned, { removeAds: false, starter: false });
  const cheat = withM({ removeAds: true, starter: true });
  const r = await call(saveGameProgress, "u1", { progress: cheat, baseRevision: 0 });
  assert.equal(r.body.progress.m.removeAds, false);
  assert.equal(r.body.progress.m.starter, false);
  Object.assign(owned, { removeAds: true });
  const got = (await call(getGameProgress, "u1")).body.progress.m;
  assert.equal(got.removeAds, true);
  assert.equal(got.starter, false);
  Object.assign(owned, { removeAds: false });
});
