const GameProgress = require("../models/gameProgressModel");
const { mergeGameData, validateProgress } = require("../services/gameProgressMerge");
const { entitlementsFor } = require("../services/entitlementService");

const MAX_ATTEMPTS = 4;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function view(record) {
  return {
    progress: record?.progress ?? null,
    save: record?.save ?? null,
    revision: record?.revision ?? 0,
    schemaVersion: record?.schemaVersion ?? 1,
    updatedAt: record?.updatedAt ?? null,
  };
}

/**
 * Paid unlocks come from verified purchases only: whatever the app sends for
 * m.plus / m.removeAds / m.starter is replaced by what the player really owns
 * (plus implies removeAds).
 */
async function withRealEntitlements(userId, progress) {
  if (!isObj(progress)) return progress;
  const owned = await entitlementsFor(userId);
  if (progress.v !== 1) return progress;
  const m = isObj(progress.m) ? progress.m : {};
  return { ...progress, m: { ...m, plus: owned.plus, removeAds: owned.removeAds, starter: owned.starter } };
}

async function getGameProgress(req, res) {
  try {
    const record = await GameProgress.findOne({ userId: req.authUser._id }).lean();
    if (record) record.progress = await withRealEntitlements(req.authUser._id, record.progress);
    return res.json(view(record));
  } catch (error) {
    console.error("[game-progress:get]", error);
    return res.status(500).json({ error: "Could not load game data" });
  }
}

/**
 * Saves the player's game data. The client sends the revision it last saw;
 * if the server has moved on (another device saved), the two copies are
 * merged instead of one silently overwriting the other, and the merged copy
 * is returned for the client to adopt.
 */
async function saveGameProgress(req, res) {
  try {
    const { progress, save, baseRevision, clientUpdatedAt } = req.body || {};
    const invalid = validateProgress(progress);
    if (invalid) {
      return res.status(invalid === "progress too large" ? 413 : 400).json({ error: invalid });
    }
    if (save !== undefined && !isObj(save)) {
      return res.status(400).json({ error: "save must be an object" });
    }
    const incoming = {
      progress: await withRealEntitlements(req.authUser._id, progress),
      save: save || {},
      clientUpdatedAt: clientUpdatedAt ? new Date(clientUpdatedAt) : new Date(),
    };
    const userId = req.authUser._id;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = await GameProgress.findOne({ userId }).lean();
      if (!existing) {
        try {
          const created = await GameProgress.create({ userId, ...incoming, revision: 1 });
          return res.json({ ...view(created.toObject()), merged: false });
        } catch (err) {
          if (err?.code === 11000) continue; // another request created it first
          throw err;
        }
      }

      const inSync = Number(baseRevision) === existing.revision;
      const next = inSync ? incoming : { ...mergeGameData(existing, incoming), clientUpdatedAt: incoming.clientUpdatedAt };
      const updated = await GameProgress.findOneAndUpdate(
        { userId, revision: existing.revision },
        { $set: { ...next }, $inc: { revision: 1 } },
        { new: true }
      ).lean();
      if (updated) {
        updated.progress = await withRealEntitlements(userId, updated.progress);
        return res.json({ ...view(updated), merged: !inSync });
      }
    }
    return res.status(409).json({ error: "Game data changed while saving. Try again." });
  } catch (error) {
    console.error("[game-progress:save]", error);
    return res.status(500).json({ error: "Could not save game data" });
  }
}

async function deleteGameProgress(req, res) {
  try {
    await GameProgress.deleteOne({ userId: req.authUser._id });
    return res.json({ ok: true });
  } catch (error) {
    console.error("[game-progress:delete]", error);
    return res.status(500).json({ error: "Could not delete game data" });
  }
}

module.exports = { getGameProgress, saveGameProgress, deleteGameProgress };
