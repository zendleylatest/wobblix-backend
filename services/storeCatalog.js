"use strict";
/**
 * The products Wobblix sells. All are one-time purchases (there are no
 * subscriptions). The same ids are used on Google Play, the App Store and the
 * Amazon Appstore, and in the app (lib/iap/store_products.dart).
 *
 *  - entitlements stay active until the store refunds them;
 *  - consumables (sparks packs) are granted once and claimed by the app.
 */
const CATALOG = Object.freeze({
  remove_ads: { kind: "entitlement", entitlement: "removeAds" },
  starter_pack: { kind: "entitlement", entitlement: "starter" },
  sparks_300: { kind: "consumable", sparks: 300 },
  sparks_1800: { kind: "consumable", sparks: 1800 },
  sparks_4000: { kind: "consumable", sparks: 4000 },
});

const PLATFORMS = Object.freeze(["android", "ios", "amazon"]);

/** Owning the key also grants every entitlement listed for it. */
const IMPLIED = Object.freeze({});

const productFor = (id) => (Object.prototype.hasOwnProperty.call(CATALOG, id) ? CATALOG[id] : null);

module.exports = { CATALOG, PLATFORMS, IMPLIED, productFor };
