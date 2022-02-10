'use strict';

import {registerBidder} from '../src/adapters/bidderFactory.js';
import {BANNER} from '../src/mediaTypes.js';
import {config} from '../src/config.js';
import {getWindowSelf, getWindowTop} from '../src/utils.js'
import {getStorageManager} from '../src/storageManager.js';

const BIDDER_CODE = 'taboola';
const GVLID = 42;
const CURRENCY = 'USD';
export const END_POINT_URL = 'https://taboolahb.bidder.taboolasyndication.com';
const USER_ID = 'user-id';
const STORAGE_KEY = `taboola global:${USER_ID}`;
const COOKIE_KEY = 'trc_cookie_storage';

/**
 * try to extract User Id by that order:
 *  local storage
 *  first party cookie
 *  rendered trc
 *  new user set it to 0
 */
export const userData = {
  storageManager: getStorageManager(GVLID, BIDDER_CODE),
  getUserId: () => {
    const {getFromLocalStorage, getFromCookie, getFromTRC} = userData;

    try {
      return getFromLocalStorage() || getFromCookie() || getFromTRC();
    } catch (ex) {
      return 0;
    }
  },
  getFromCookie() {
    const {cookiesAreEnabled, getCookie} = userData.storageManager;
    if (cookiesAreEnabled()) {
      const cookieData = getCookie(COOKIE_KEY);
      const userId = userData.getCookieDataByKey(cookieData, USER_ID);
      if (userId) {
        return userId;
      }
    }
  },
  getCookieDataByKey(cookieData, key) {
    const [, value = ''] = cookieData.split(`${key}=`)
    return value;
  },
  getFromLocalStorage() {
    const {hasLocalStorage, localStorageIsEnabled, getDataFromLocalStorage} = userData.storageManager;

    if (hasLocalStorage() && localStorageIsEnabled()) {
      return getDataFromLocalStorage(STORAGE_KEY);
    }
  },
  getFromTRC() {
    return window.TRC ? window.TRC.user_id : 0;
  }
}

export const internal = {
  getPageUrl: (refererInfo = {}) => {
    if (refererInfo.canonicalUrl) {
      return refererInfo.canonicalUrl;
    }

    if (config.getConfig('pageUrl')) {
      return config.getConfig('pageUrl');
    }

    try {
      return getWindowTop().location.href;
    } catch (e) {
      return getWindowSelf().location.href;
    }
  },
  getReferrer: (refererInfo = {}) => {
    if (refererInfo.referer) {
      return refererInfo.referer;
    }

    try {
      return getWindowTop().document.referrer;
    } catch (e) {
      return getWindowSelf().document.referrer;
    }
  }
}

export const spec = {
  supportedMediaTypes: [BANNER],
  gvlid: GVLID,
  code: BIDDER_CODE,
  isBidRequestValid: (bidRequest) => {
    return !!(bidRequest.sizes &&
           bidRequest.params &&
           bidRequest.params.publisherId &&
           bidRequest.params.tagId);
  },
  buildRequests: (validBidRequests, bidderRequest) => {
    const [bidRequest] = validBidRequests;
    const {refererInfo, gdprConsent = {}, uspConsent} = bidderRequest;
    const {bcat = [], badv = [], publisherId} = bidRequest.params;
    const site = getSiteProperties(bidRequest.params, refererInfo);
    const device = {ua: navigator.userAgent};
    const imps = getImps(validBidRequests);
    const user = {
      buyeruid: userData.getUserId(gdprConsent, uspConsent),
      ext: {}
    };
    const regs = {
      coppa: 0,
      ext: {}
    };

    if (gdprConsent.gdprApplies) {
      user.ext.consent = bidderRequest.gdprConsent.consentString;
      regs.ext.gdpr = 1;
    }

    if (uspConsent) {
      regs.ext.us_privacy = uspConsent;
    }

    if (config.getConfig('coppa')) {
      regs.coppa = 1
    }

    const request = {
      id: bidderRequest.auctionId,
      imp: imps,
      site,
      device,
      source: {fd: 1},
      tmax: bidderRequest.timeout,
      bcat,
      badv,
      user,
      regs
    };

    const url = [END_POINT_URL, publisherId].join('?pid=');

    return {
      url,
      method: 'POST',
      data: JSON.stringify(request),
      bids: validBidRequests
    };
  },
  interpretResponse: (serverResponse, {bids}) => {
    if (!bids) {
      return [];
    }

    const {bidResponses, cur: currency} = getBidResponses(serverResponse);

    if (!bidResponses) {
      return [];
    }

    return bids.map((bid, id) => getBid(bid.bidId, currency, bidResponses[id])).filter(Boolean);
  },
};

function getSiteProperties({publisherId, bcat = []}, refererInfo) {
  const {getPageUrl, getReferrer} = internal;
  return {
    id: publisherId,
    name: publisherId,
    domain: window.location.host,
    page: getPageUrl(refererInfo),
    ref: getReferrer(refererInfo),
    publisher: {
      id: publisherId
    },
    content: {
      language: navigator.language
    }
  }
}

function getImps(validBidRequests) {
  return validBidRequests.map((bid, id) => {
    const {tagId, bidfloor = null, bidfloorcur = CURRENCY} = bid.params;

    return {
      id: id + 1,
      banner: getBanners(bid),
      tagid: tagId,
      bidfloor,
      bidfloorcur,
    };
  });
}

function getBanners(bid) {
  return getSizes(bid.sizes);
}

function getSizes(sizes) {
  return sizes.map(size => {
    return {
      h: size[0],
      w: size[1]
    }
  })
}

function getBidResponses({body}) {
  if (!body || (body && !body.bidResponse)) {
    return [];
  }

  const {seatbid, cur} = body.bidResponse;

  if (!seatbid.length || !seatbid[0].bid) {
    return [];
  }

  return {
    bidResponses: seatbid[0].bid,
    cur
  };
}

function getBid(requestId, currency, bidResponse) {
  if (!bidResponse) {
    return;
  }

  const {
    price: cpm, crid: creativeId, adm: ad, w: width, h: height, adomain: advertiserDomains, meta = {}
  } = bidResponse;

  if (advertiserDomains && advertiserDomains.length > 0) {
    meta.advertiserDomains = advertiserDomains
  }

  return {
    requestId,
    ttl: 360,
    mediaType: BANNER,
    cpm,
    creativeId,
    currency,
    ad,
    width,
    height,
    meta,
    netRevenue: false
  };
}

registerBidder(spec);
