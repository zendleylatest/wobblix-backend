"use strict";
const Purchase = require("../models/purchaseModel");
const { IMPLIED } = require("./storeCatalog");
const { verifyOneTimePurchase } = require("./storePurchaseVerification");

const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the player owns, derived only from verified purchases. */
async function entitlementsFor(userId) {
  const rows = await Purchase.find({ userId, kind: "entitlement", status: "active" }).lean();
  const owned = new Set();
  for (const r of rows) {
    owned.add(r.entitlement);
    for (const extra of IMPLIED[r.entitlement] || []) owned.add(extra);
  }
  return { removeAds: owned.has("removeAds"), starter: owned.has("starter") };
}

/** Sparks packs bought and verified but not yet credited by the app. */
async function pendingGrants(userId) {
  const rows = await Purchase.find({
    userId,
    kind: "consumable",
    status: "active",
    claimedAt: null,
    sparks: { $gt: 0 }, // legacy gem packs from the old game are never converted
  }).lean();
  return rows.map((r) => ({ id: String(r._id), productId: r.productId, sparks: r.sparks }));
}

/**
 * Re-checks entitlement purchases with the store about once a day, so a
 * refund takes the unlock away again. A store that is unreachable never
 * revokes anything.
 */
async function refreshStaleEntitlements(userId, { now = Date.now(), deps } = {}) {
  const stale = await Purchase.find({
    userId,
    kind: "entitlement",
    status: "active",
    verifiedAt: { $lt: new Date(now - RECHECK_AFTER_MS) },
  });
  for (const p of stale) {
    const res = await verifyOneTimePurchase(
      { platform: p.platform, productId: p.productId, token: p.token, storeUserId: p.storeUserId },
      deps
    );
    if (res.ok) {
      p.verifiedAt = new Date(now);
    } else if (!res.retryable) {
      p.status = "revoked";
    } else {
      continue;
    }
    await p.save();
  }
}

module.exports = { entitlementsFor, pendingGrants, refreshStaleEntitlements, RECHECK_AFTER_MS };
