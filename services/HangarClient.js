// services/HangarClient.js
// HTTP client for hangar-service (Cloud Run): members' Star Citizen ships.
//
// Cloud Run's invoker IAM check is OFF; the app's own authentication is the
// only gate. Every request carries a Google ID token (with the email claim)
// for the audience HANGAR_API_URL -- which must equal the service's
// HANGAR_AUDIENCE byte for byte (no trailing slash). The credential file
// (HANGAR_SA_KEY_PATH) is either a service-account key or a federated
// (`external_account`) credential file, chosen by its `type`; the latter
// impersonates the caller service account to mint the token. Either way the
// token is cached until shortly before it expires.
//
// Never throws to callers: every method resolves to
//   { ok: true, data }  or  { ok: false, error, message, candidates? }
// where `error` is the service's envelope code (unavailable, not_found,
// ambiguous, incompatible, forbidden, unauthenticated, invalid_request).
// Network failures, timeouts and token-mint failures are `unavailable`.
// Writes always send X-Acting-Member (the invoking Discord user); reads send
// it only when the caller passes {actingMember} (the invoker, never an option).
'use strict';

const logger = require('../logger');

const DEFAULT_TIMEOUT_MS = 5000;

const STATUS_CODES = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'ambiguous',
  422: 'incompatible',
};

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const IMPERSONATION_URL_RE = /\/serviceAccounts\/([^/:]+):generateAccessToken$/;
const TOKEN_REFRESH_MARGIN_S = 300;

// exp (seconds) from a JWT payload, unverified; null when unreadable.
function jwtExp(token) {
  try {
    const exp = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp : null;
  } catch (_) {
    return null;
  }
}

// getRequestHeaders() client over an Impersonated client: mints an ID token
// (email claim included -- the service rejects one without) and caches it
// until 5 minutes before its exp.
function impersonatedIdTokenClient(impersonated, audience) {
  let token = null;
  let expiresAtMs = 0;
  return {
    async getRequestHeaders() {
      if (!token || Date.now() >= expiresAtMs - TOKEN_REFRESH_MARGIN_S * 1000) {
        const fresh = await impersonated.fetchIdToken(audience, { includeEmail: true });
        const exp = jwtExp(fresh);
        token = fresh;
        // An unreadable exp is not cached past this call.
        expiresAtMs = exp ? exp * 1000 : 0;
      }
      return { Authorization: `Bearer ${token}` };
    },
  };
}

async function defaultAuthClientFactory(keyFile, audience) {
  let info = null;
  try {
    info = JSON.parse(require('fs').readFileSync(keyFile, 'utf8'));
  } catch (_) {
    // Unreadable/unparseable: GoogleAuth below reports it in its own words.
  }
  const lib = require('google-auth-library');
  if (info && info.type === 'external_account') {
    const match = IMPERSONATION_URL_RE.exec(String(info.service_account_impersonation_url || ''));
    if (!match) {
      throw new Error(`${keyFile}: external_account credential file has no usable service_account_impersonation_url `
        + '(expected .../serviceAccounts/<email>:generateAccessToken)');
    }
    // One impersonation hop: the source is the plain federated token (the
    // impersonation settings removed); the target SA is impersonated once.
    const plain = { ...info };
    delete plain.service_account_impersonation_url;
    delete plain.service_account_impersonation;
    const sourceClient = lib.ExternalAccountClient.fromJSON(plain);
    const impersonated = new lib.Impersonated({
      sourceClient,
      targetPrincipal: match[1],
      targetScopes: [CLOUD_PLATFORM_SCOPE],
    });
    return impersonatedIdTokenClient(impersonated, audience);
  }
  return new lib.GoogleAuth({ keyFile }).getIdTokenClient(audience);
}

function describe(err) {
  if (!err) return String(err);
  return err.stack || `${err.name || 'Error'}: ${err.message}`;
}

class HangarClient {
  /**
   * @param {Object} opts
   * @param {string} opts.apiUrl - service base URL, also the ID-token audience
   * @param {string} opts.saKeyPath - caller SA JSON key file
   * @param {number} [opts.timeoutMs=5000] - per-request bound (token + HTTP)
   * @param {Function} [opts.fetch] - fetch implementation (tests)
   * @param {Function} [opts.authClientFactory] - (keyFile, audience) => Promise<client with getRequestHeaders()>
   */
  constructor({ apiUrl, saKeyPath, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl, authClientFactory } = {}) {
    this.apiUrl = String(apiUrl || '').replace(/\/+$/, '');
    this.saKeyPath = saKeyPath;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this._authClientFactory = authClientFactory || defaultAuthClientFactory;
    this._authClientPromise = null;
  }

  isEnabled() {
    return Boolean(this.apiUrl);
  }

  getHangar(memberId, { timeoutMs, actingMember } = {}) {
    return this._request('GET', `/v1/members/${encodeURIComponent(memberId)}/hangar`, { timeoutMs, actingMember });
  }

  addShip(memberId, { vehicle, nickname } = {}, actingMember) {
    return this._request('POST', `/v1/members/${encodeURIComponent(memberId)}/ships`, {
      body: { vehicle, nickname: nickname || null },
      actingMember,
      write: true,
    });
  }

  renameShip(memberId, shipId, nickname, actingMember) {
    return this._request('PATCH', `/v1/members/${encodeURIComponent(memberId)}/ships/${encodeURIComponent(shipId)}`, {
      body: { nickname: nickname == null ? null : nickname },
      actingMember,
      write: true,
    });
  }

  removeShip(memberId, shipId, actingMember) {
    return this._request('DELETE', `/v1/members/${encodeURIComponent(memberId)}/ships/${encodeURIComponent(shipId)}`, {
      actingMember,
      write: true,
    });
  }

  getPledgeLeaderboard({ timeoutMs } = {}) {
    return this._request('GET', '/v1/pledges/leaderboard', { timeoutMs });
  }

  searchVehicles(q, { limit = 25, timeoutMs } = {}) {
    const params = new URLSearchParams({ q: q || '', limit: String(limit) });
    return this._request('GET', `/v1/catalog/vehicles?${params.toString()}`, { timeoutMs });
  }

  _authClient() {
    if (!this._authClientPromise) {
      this._authClientPromise = Promise.resolve()
        .then(() => this._authClientFactory(this.saKeyPath, this.apiUrl))
        .catch((err) => {
          // Don't cache a failure (key not mounted yet, transient error).
          this._authClientPromise = null;
          throw err;
        });
    }
    return this._authClientPromise;
  }

  async _authorization() {
    const client = await this._authClient();
    const headers = await client.getRequestHeaders();
    if (headers && typeof headers.get === 'function') {
      return headers.get('authorization');
    }
    return headers ? (headers.Authorization || headers.authorization) : null;
  }

  async _request(method, path, { body, actingMember, write = false, timeoutMs } = {}) {
    const label = `${method} ${path}`;
    if (!this.isEnabled()) {
      return { ok: false, error: 'unavailable', message: 'hangar service is not configured (HANGAR_API_URL unset)' };
    }
    if (write && !actingMember) {
      logger.warn(`hangar: refusing ${label}: no acting member for a write`);
      return { ok: false, error: 'forbidden', message: 'X-Acting-Member is required on writes' };
    }

    const bound = timeoutMs || this.timeoutMs;
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`hangar request timed out after ${bound}ms`);
        err.name = 'TimeoutError';
        controller.abort(err);
        reject(err);
      }, bound);
    });

    try {
      const authorization = await Promise.race([this._authorization(), deadline]);
      const headers = { Accept: 'application/json' };
      if (authorization) headers.Authorization = authorization;
      if (actingMember) headers['X-Acting-Member'] = String(actingMember);
      const init = { method, headers, signal: controller.signal };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      const res = await Promise.race([this._fetch(`${this.apiUrl}${path}`, init), deadline]);
      const text = await Promise.race([res.text(), deadline]);
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      }

      if (res.ok) {
        if (parsed === null && text) {
          logger.warn(`hangar: ${label} returned ${res.status} with a non-JSON body: ${text}`);
          return { ok: false, error: 'unavailable', message: 'hangar service returned an unreadable response' };
        }
        return { ok: true, data: parsed };
      }

      const error = (parsed && typeof parsed.error === 'string' && parsed.error)
        || STATUS_CODES[res.status] || 'unavailable';
      const message = (parsed && typeof parsed.message === 'string' && parsed.message)
        || `hangar service returned HTTP ${res.status}`;
      const out = { ok: false, error, message };
      if (parsed && Array.isArray(parsed.candidates)) out.candidates = parsed.candidates;
      const log = res.status >= 500 || res.status === 401 ? logger.warn : logger.info;
      log.call(logger, `hangar: ${label} -> ${res.status} ${error}: ${message}${parsed ? '' : ` (body: ${text})`}`);
      return out;
    } catch (err) {
      logger.warn(`hangar: ${label} failed (unavailable): ${describe(err)}`);
      return { ok: false, error: 'unavailable', message: err && err.message ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

HangarClient.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
HangarClient.defaultAuthClientFactory = defaultAuthClientFactory;
module.exports = HangarClient;
