/**
 * This module adds Taboola’s User ID submodule to the Prebid User ID module.
 * It reuses userData logic from the Taboola bid adapter to consistently retrieve IDs,
 * then calls a Taboola sync URL to optionally refresh or update that ID.
 *
 * @module modules/taboolaIdSystem
 * @requires module:modules/userId
 */

import { submodule } from '../src/hook.js';
import { ajax } from '../src/ajax.js';
import { getStorageManager } from '../src/storageManager.js';
import { timestamp, logError } from '../src/utils.js';
import { gdprDataHandler, uspDataHandler, gppDataHandler } from '../src/adapterManager.js';
import { MODULE_TYPE_UID } from '../src/activities/modules.js';

/**
 * Constants & placeholders for Taboola IDs, endpoints, etc.
 */
const BIDDER_CODE = 'taboola';
const GVLID = 42;
const USER_SYNC_ENDPOINT = 'https://trc.taboola.com/sg/prebidJS/1/cm';

// A typical max age for cookies (~13 months).
const COOKIE_MAX_AGE_MS = 13 * 30 * 24 * 60 * 60 * 1000;

/**
 * The userData object replicates the logic in the Taboola bid adapter for IDs.
 * We place it here so this user ID submodule and the adapter use the same approach.
 */
const userData = {
  storageManager: getStorageManager({ bidderCode: BIDDER_CODE, moduleType: MODULE_TYPE_UID }),

  getUserId() {
    try {
      return this.getFromLocalStorage() || this.getFromCookie() || this.getFromTRC();
    } catch (ex) {
// If something went wrong with reading ID, return 0 as fallback
      return 0;
    }
  },

  getFromLocalStorage() {
    const {
      hasLocalStorage,
      localStorageIsEnabled,
      getDataFromLocalStorage
    } = this.storageManager;
    const STORAGE_KEY = 'taboola global:user-id';
    if (hasLocalStorage() && localStorageIsEnabled()) {
      return getDataFromLocalStorage(STORAGE_KEY);
    }
    return undefined;
  },

  getFromCookie() {
    const { cookiesAreEnabled, getCookie } = this.storageManager;
    const COOKIE_KEY = 'trc_cookie_storage';
    const TGID_COOKIE_KEY = 't_gid';
    const TGID_PT_COOKIE_KEY = 't_pt_gid';
    const TBLA_ID_COOKIE_KEY = 'tbla_id';

    if (cookiesAreEnabled()) {
// Attempt to read from the main cookie "trc_cookie_storage"
      const cookieData = getCookie(COOKIE_KEY);
      if (cookieData) {
        const userId = this.getCookieDataByKey(cookieData, 'user-id');
        if (userId) {
          return userId;
        }
      }

// Otherwise try the known Taboola cookies
      const tid = getCookie(TGID_COOKIE_KEY);
      if (tid) return tid;

      const tptid = getCookie(TGID_PT_COOKIE_KEY);
      if (tptid) return tptid;

      const tblaid = getCookie(TBLA_ID_COOKIE_KEY);
      if (tblaid) return tblaid;
    }
    return undefined;
  },

  /**
   * If the trc_cookie_storage has multiple name-value pairs, e.g. "user-id=123&foo=bar",
   * this helper returns the value for a specific key, e.g. "123" for 'user-id'.
   */
  getCookieDataByKey(cookieData, key) {
    if (!cookieData) {
      return undefined;
    }
    const [match] = cookieData.split('&').filter(item => item.startsWith(`${key}=`));
    if (match) {
      const [_, value] = match.split('=');
      return value;
    }
    return undefined;
  },

  getFromTRC() {
    if (window.TRC) {
      return window.TRC.user_id; // can be 0 if unknown
    }
    return undefined;
  }
};

/**
 * Builds the user sync URL for Taboola, attaching any necessary privacy parameters.
 */
function buildTaboolaSyncUrl() {
  let syncUrl = USER_SYNC_ENDPOINT;
  const params = [];

  const gdprConsent = gdprDataHandler.getConsentData();
  if (gdprConsent) {
// Add GDPR applies (1 or 0) and consent string if present.
    params.push(`gdpr=${Number(gdprConsent.gdprApplies === true)}`);
    if (gdprConsent.consentString) {
      params.push(`gdpr_consent=${encodeURIComponent(gdprConsent.consentString)}`);
    }
  }

  const uspConsent = uspDataHandler.getConsentData();
  if (uspConsent) {
    params.push(`us_privacy=${encodeURIComponent(uspConsent)}`);
  }

  const gppConsent = gppDataHandler.getConsentData();
  if (gppConsent) {
    if (gppConsent.gppString) {
      params.push(`gpp=${encodeURIComponent(gppConsent.gppString)}`);
    }
    if (gppConsent.applicableSections) {
      params.push(`gpp_sid=${encodeURIComponent(gppConsent.applicableSections)}`);
    }
  }

  if (params.length > 0) {
    syncUrl += `?${params.join('&')}`;
  }
  return syncUrl;
}

/**
 * Calls Taboola’s user sync endpoint (or pixel) to refresh the user’s ID.
 * If it returns a new ID in JSON, we store it in localStorage and cookie.
 */
function callTaboolaUserSync(submoduleConfig, currentId, callback) {
  const url = buildTaboolaSyncUrl();

// Example: you might get JSON back with a new userId.
// If your endpoint is strictly a pixel (no JSON), remove the ajax logic and just do triggerPixel.
  ajax(
    url,
    {
      success: (response) => {
        try {
          const data = JSON.parse(response);
// Suppose the response has { "taboolaId": "abcdef12345" }
          if (data && data.taboolaId) {
            saveUserId(data.taboolaId);
            callback({ taboolaId: data.taboolaId });
            return;
          }
        } catch (err) {
          logError('Taboola user-sync: error parsing response', err);
        }
// If we get here, no new ID was found
        callback(currentId ? { taboolaId: currentId } : undefined);
      },
      error: (err) => {
        logError('Taboola user-sync: error calling endpoint', err);
        callback(currentId ? { taboolaId: currentId } : undefined);
      }
    },
    undefined,
    { method: 'GET', withCredentials: true }
  );
}

/**
 * Save the user ID in local storage and optionally in a cookie, for consistency.
 */
function saveUserId(id) {
  if (!id) return;
  try {
    const sm = userData.storageManager;
    const STORAGE_KEY = 'taboola global:user-id';
    sm.setDataInLocalStorage(STORAGE_KEY, id);

// Save cookie as well
    if (sm.cookiesAreEnabled()) {
      const expires = new Date(timestamp() + COOKIE_MAX_AGE_MS).toUTCString();
// Cookie name can be up to you—some choose the same or "tbla_id".
      sm.setCookie(STORAGE_KEY, id, expires);
    }
  } catch (ex) {
    logError('Taboola user-sync: error saving user ID', ex);
  }
}

/**
 * The actual Taboola ID Submodule object that Prebid uses.
 */
export const taboolaIdSubmodule = {
  /**
   * Identity name used in userIds config.
   */
  name: 'taboolaId',

  /**
   * Global Vendor List ID if needed for TCF.
   */
  gvlid: GVLID,

  /**
   * decode transforms whatever is stored into the final object
   * that Prebid adds to the request’s userId.
   */
  decode(value) {
    if (typeof value === 'string' && value !== '0') {
      return { taboolaId: value };
    }
    return undefined;
  },

  /**
   * getId runs on page load (or refresh) to retrieve the existing ID and then optionally
   * run an asynchronous user-sync to update it.
   */
  getId(submoduleConfig) {
// 1) Use userData’s getUserId() logic for extraction.
    const foundId = userData.getUserId();

// 2) The callback handles the async user sync call.
    const callbackFn = (cb) => {
// If needed, call Taboola’s sync endpoint to check for updated ID
      callTaboolaUserSync(submoduleConfig, foundId, cb);
    };

    return {
      id: (foundId && foundId !== 0) ? foundId : undefined,
      callback: callbackFn
    };
  },

  /**
   * eids config ensures this ID is included in the OpenRTB eids array
   * for downstream bidders. 'taboola.com' is an example format.
   */
  eids: {
    taboolaId: {
      source: 'taboola.com',
      atype: 1
    }
  }
};

/**
 * Finally, register this submodule so Prebid knows it exists.
 */
submodule('userId', taboolaIdSubmodule);
//
// ────────────────────────────────────────────────────────
// How to Use It
// ────────────────────────────────────────────────────────
// 1. Place this file (taboolaIdSystem.js) in your “modules/” folder in Prebid.
// 2. Make sure it’s included when you build Prebid:
//   gulp build --modules=userId,taboolaIdSystem,[otherModules]
// 3. In your Prebid config, enable the Taboola ID submodule:
//
//   pbjs.setConfig({
//                    userSync: {
//                      userIds: [
//                        {
//                          name: 'taboolaId',
// // Optionally specify where to store the ID, e.g. cookies or localStorage
//                          storage: {
//                            name: 'tbla_id',
//                            type: 'cookie', // or 'html5'
//                            expires: 30 // days
//                          }
//                        }
//                      ],
// // Additional userId submodules or userSync settings if needed
//                    }
//                  });
//
// 4. On page load, this submodule will:
//   a) Look for the user ID in local storage, cookies, or TRC as the Taboola adapter does.
//   b) If found, decode it. If not found, or if it’s 0, it returns undefined.
//   c) Optionally call the Taboola user-sync endpoint (e.g., your custom “cm” link) to get a refreshed ID.
//   d) Store the new ID in local storage/cookies.
//
// 5. Adjust the user sync endpoint logic (callTaboolaUserSync) as needed. For instance, if your user-sync is purely pixel-based (no JSON to parse), remove the ajax logic and just call triggerPixel(url). If you need different parameters in the request, build them in buildTaboolaSyncUrl().
//
//   This setup unifies the ID extraction logic from Taboola’s bid adapter with a Prebid user ID submodule, providing a single place to manage the Taboola user ID across your ad stack.
