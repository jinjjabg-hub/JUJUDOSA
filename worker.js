/* 주주도사 API Worker — 적자 방지 구조 (v2)
 *  1) 인증: Firebase ID 토큰(RS256) 검증 — 없으면 401
 *  2) 원가 상한: 모델·max_tokens·히스토리를 Worker가 정한다 (클라이언트 값은 무시/상한 적용)
 *  3) 한도 강제: 요금제는 Firestore users/{uid}.tier 에서 서버가 읽고, 사용량은 Durable Object로 원자적 차감
 *  4) 차단기: 일일 무료 예산 / 일일 전체 예산 초과 시 차단 + 알림
 *
 * 필요한 설정은 wrangler.toml 과 아래 secrets 참고:
 *   ANTHROPIC_API_KEY, FIREBASE_SA_JSON(서비스 계정 JSON 전체), ADMIN_TOKEN, ALERT_WEBHOOK_URL(선택)
 */
import plans from './plans.js';
const { PASS_DAYS, PLANS, PLAN_LEGACY, CONSULT_PACK, INTERNAL_DAILY } = plans;

/* ===================== config (숫자·매핑은 전부 여기) ===================== */
const CONFIG = {
  PROJECT_ID: 'jujudosa',
  ALLOWED_ORIGINS: ['https://jinjjabg-hub.github.io'], // env.EXTRA_ORIGINS(쉼표 구분)로 개발용 추가 가능
  ENABLE_CACHE: true,           // 실측 캐시 적중률이 낮으면(대략 40% 미만) false
  USD_KRW: 1400,                // 원가 추정용 환율

  // kind → 모델. A/B 검증 전에는 consult 를 Haiku로 바꾸지 말 것
  MODEL_BY_KIND: {
    reading: 'claude-sonnet-5-5',
    gunghap: 'claude-sonnet-5-5',
    consult: 'claude-sonnet-5-5',
    mbti: 'claude-sonnet-5-5',
    daily: 'claude-sonnet-5-5',
    summary: 'claude-haiku-4-5-20251001',
    digest: 'claude-haiku-4-5-20251001',
  },
  // kind → max_tokens 상한 (min 적용)
  MAX_TOKENS: { reading: 7600, gunghap: 7600, consult: 2000, mbti: 3000, summary: 800, digest: 800, daily: 800 },
  // kind → 통과시킬 messages 개수 (최근 N개)
  HISTORY_LIMIT: { consult: 6 },
  // 호출 1건 입력 길이 상한(글자) — 원가 상한용
  INPUT_CHARS: { system: 60000, messages: 60000, body: 300000 },

  // 단가 (USD / 100만 토큰)
  PRICE: {
    'claude-sonnet-5-5': { in: 2, out: 10 },
    'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  },
  CACHE_READ_MULT: 0.1,
  CACHE_WRITE_MULT: 1.25,

  // 일일 지출 차단기 (원)
  BUDGET: { dailyFreeKrw: 50000, dailyTotalKrw: 200000 },

  PENDING_TTL_MS: 5 * 60 * 1000, // 응답 중 예약 잔존 시간(비정상 종료 대비)
  TIER_CACHE_MS: 60 * 1000,
  SAMPLE_CAP: 500,               // kind별 원가 샘플 보관 수 (출시 게이트 p90 계산용)
};

const AI_KINDS = Object.keys(CONFIG.MODEL_BY_KIND);
const COUNTED_KINDS = ['consult', 'reading', 'gunghap', 'mbti', 'daily']; // 요금제 한도 대상
const INTERNAL_KINDS = ['summary', 'digest'];                             // 1인 1일 남용 방지 한도만

/* ===================== 유틸 ===================== */
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const monthKey = () => kstNow().toISOString().slice(0, 7);
const dayKey = () => kstNow().toISOString().slice(0, 10);

const enc = new TextEncoder();
const dec = new TextDecoder();
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(buf) {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const jsonPart = (s) => JSON.parse(dec.decode(b64uToBytes(s)));

function allowedOrigins(env) {
  const extra = (env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return CONFIG.ALLOWED_ORIGINS.concat(extra);
}
function corsFor(request, env) {
  const origin = request.headers.get('Origin');
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  if (origin && allowedOrigins(env).includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
}
function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ===================== Firebase ID 토큰 검증 (RS256, WebCrypto) ===================== */
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache = { keys: [], exp: 0 };
async function getJwks(force) {
  if (!force && jwksCache.keys.length && Date.now() < jwksCache.exp) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('jwks fetch failed');
  const data = await res.json();
  const m = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '');
  jwksCache = { keys: data.keys || [], exp: Date.now() + (m ? Math.min(+m[1], 3600) : 3600) * 1000 };
  return jwksCache.keys;
}
async function verifyIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = jsonPart(parts[0]); payload = jsonPart(parts[1]); } catch (e) { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;
  let keys = await getJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getJwks(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== CONFIG.PROJECT_ID) return null;
  if (payload.iss !== 'https://securetoken.google.com/' + CONFIG.PROJECT_ID) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) return null;
  return payload.sub; // uid
}

/* ===================== 서비스 계정 → Firestore REST 로 tier 읽기 ===================== */
let saToken = { token: null, exp: 0 };
async function getSaToken(env) {
  if (saToken.token && Date.now() < saToken.exp - 60000) return saToken.token;
  const sa = JSON.parse(env.FIREBASE_SA_JSON);
  const iat = Math.floor(Date.now() / 1000);
  const head = bytesToB64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  })));
  const der = b64uToBytes(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claims));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claims + '.' + bytesToB64u(sig),
  });
  if (!res.ok) throw new Error('sa token failed ' + res.status);
  const data = await res.json();
  saToken = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return saToken.token;
}
const tierCache = new Map(); // uid → {tier, exp}
async function getTier(env, uid) {
  const c = tierCache.get(uid);
  if (c && Date.now() < c.exp) return c.info;
  const token = await getSaToken(env);
  const res = await fetch('https://firestore.googleapis.com/v1/projects/' + CONFIG.PROJECT_ID + '/databases/(default)/documents/users/' + encodeURIComponent(uid), {
    headers: { Authorization: 'Bearer ' + token },
  });
  let tier = 'free', startedAt = null;
  if (res.status === 200) {
    const doc = await res.json();
    const f = doc.fields || {};
    tier = (f.tier && f.tier.stringValue) || 'free';
    if (f.tierStartedAt && f.tierStartedAt.timestampValue) startedAt = Date.parse(f.tierStartedAt.timestampValue);
  } else if (res.status !== 404) {
    throw new Error('firestore ' + res.status);
  }
  tier = PLAN_LEGACY[tier] || tier;
  if (tier !== 'admin' && !PLANS[tier]) tier = 'free';
  // 유료 등급인데 시작일이 없으면(콘솔에서 tier만 바꾼 경우) 지금을 시작일로 기록한다 → 그날부터 30일
  if (tier !== 'free' && tier !== 'admin' && !startedAt) {
    startedAt = Date.now();
    await patchUser(env, uid, { tierStartedAt: { timestampValue: new Date(startedAt).toISOString() } });
  }
  const info = { tier, startedAt };
  tierCache.set(uid, { info, exp: Date.now() + CONFIG.TIER_CACHE_MS });
  return info;
}
async function patchUser(env, uid, fields) { // users/{uid} 의 지정 필드만 갱신 (서비스 계정)
  const token = await getSaToken(env);
  const mask = Object.keys(fields).map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await fetch('https://firestore.googleapis.com/v1/projects/' + CONFIG.PROJECT_ID + '/databases/(default)/documents/users/' + encodeURIComponent(uid) + '?' + mask, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error('firestore patch ' + res.status);
  tierCache.delete(uid);
}

/* ===================== 요청 정리 (모델·토큰·히스토리·길이) ===================== */
function sanitize(body, kind) {
  const out = { model: CONFIG.MODEL_BY_KIND[kind] };
  const cap = CONFIG.MAX_TOKENS[kind];
  const asked = Number.isFinite(body.max_tokens) && body.max_tokens > 0 ? Math.floor(body.max_tokens) : cap;
  out.max_tokens = Math.min(asked, cap);
  if (body.stream === true) out.stream = true;

  // system: 문자열 또는 [{type:'text', text, cache_control?}]
  let sysChars = 0;
  if (typeof body.system === 'string') {
    sysChars = body.system.length;
    out.system = body.system;
  } else if (Array.isArray(body.system)) {
    out.system = body.system.map((b) => {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') throw new Error('bad system');
      sysChars += b.text.length;
      const blk = { type: 'text', text: b.text };
      if (CONFIG.ENABLE_CACHE && b.cache_control && b.cache_control.type === 'ephemeral') blk.cache_control = { type: 'ephemeral' };
      return blk;
    });
  } else if (body.system != null) {
    throw new Error('bad system');
  }
  if (sysChars > CONFIG.INPUT_CHARS.system) throw new Error('system too long');

  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('messages required');
  let msgs = body.messages.map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') throw new Error('bad message');
    return { role: m.role, content: m.content };
  });
  const lim = CONFIG.HISTORY_LIMIT[kind];
  if (lim && msgs.length > lim) {
    msgs = msgs.slice(-lim);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift(); // 첫 메시지는 user 여야 함
  }
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new Error('last message must be user');
  if (msgs.reduce((n, m) => n + m.content.length, 0) > CONFIG.INPUT_CHARS.messages) throw new Error('messages too long');
  out.messages = msgs;

  if (CONFIG.ENABLE_CACHE && body.cache_control && body.cache_control.type === 'ephemeral') out.cache_control = { type: 'ephemeral' };
  return out;
}

/* ===================== 원가 계산 ===================== */
function costKrw(model, u) {
  const p = CONFIG.PRICE[model];
  if (!p || !u) return 0;
  const inT = u.input_tokens || 0, out = u.output_tokens || 0;
  const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const usd = (inT * p.in + out * p.out + cr * p.in * CONFIG.CACHE_READ_MULT + cw * p.in * CONFIG.CACHE_WRITE_MULT) / 1e6;
  return usd * CONFIG.USD_KRW;
}

async function sendAlert(env, text) {
  console.warn('[ALERT]', text);
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  } catch (e) { console.error('alert failed', e.message); }
}

/* ===================== Durable Object: 사용자별 사용량 (원자적) ===================== */
export class UsageLedger {
  constructor(state) { this.state = state; }

  async load(windowKey) {
    const S = (await this.state.storage.get('S')) || { window: '', used: {}, packs: [], pending: {}, day: '', internal: {} };
    const d = dayKey(), now = Date.now();
    // 이용 기간이 바뀌면(새 이용권 시작·무료 월 초기화) 사용량을 0으로
    if (windowKey && S.window !== windowKey) { S.window = windowKey; S.used = {}; } // window 없는 호출(관리자 조회·팩 지급)은 사용량을 건드리지 않는다
    if (S.day !== d) { S.day = d; S.internal = {}; }
    for (const id of Object.keys(S.pending)) if (now - S.pending[id].ts > CONFIG.PENDING_TTL_MS) delete S.pending[id];
    const validMs = CONSULT_PACK.validDays * 86400000;
    S.packs = S.packs.filter((p) => p.remaining > 0 && now - p.at < validMs);
    return S;
  }
  pendingCount(S, pred) { return Object.values(S.pending).filter(pred).length; }

  async fetch(request) {
    const req = await request.json();
    const S = await this.load(req.window || '');
    let result;

    if (req.op === 'reserve') {
      const kind = req.kind;
      const pend = (k) => this.pendingCount(S, (p) => p.kind === k && p.source !== 'pack');
      if (INTERNAL_KINDS.includes(kind)) {
        const cap = INTERNAL_DAILY[kind];
        const used = (S.internal[kind] || 0) + this.pendingCount(S, (p) => p.kind === kind);
        result = used >= cap ? { ok: false, limit: cap } : this.addPending(S, kind, 'internal');
      } else if (req.unlimited) {
        result = this.addPending(S, kind, 'sub');
      } else {
        const limit = (req.limits && req.limits[kind]) || 0;
        let blocked = null;
        if (req.combined && req.combined.keys.includes(kind)) {
          const total = req.combined.keys.reduce((n, k) => n + (S.used[k] || 0) + pend(k), 0);
          if (total >= req.combined.max) blocked = req.combined.max;
        }
        if (blocked == null && (S.used[kind] || 0) + pend(kind) < limit) {
          result = this.addPending(S, kind, 'sub');
        } else if (blocked == null && kind === 'consult') {
          // 구독 월 한도 소진 → 상담팩 잔액(가장 오래된 것부터)
          const pack = S.packs.slice().sort((a, b) => a.at - b.at)
            .find((p) => p.remaining - this.pendingCount(S, (q) => q.source === 'pack' && q.packAt === p.at) > 0);
          result = pack ? this.addPending(S, kind, 'pack', pack.at) : { ok: false, limit };
        } else {
          result = { ok: false, limit: blocked != null ? blocked : limit };
        }
      }
      await this.state.storage.put('S', S);
    } else if (req.op === 'commit') {
      const p = S.pending[req.resId];
      if (p) {
        delete S.pending[req.resId];
        if (p.source === 'sub') S.used[p.kind] = (S.used[p.kind] || 0) + 1;
        else if (p.source === 'internal') S.internal[p.kind] = (S.internal[p.kind] || 0) + 1;
        else if (p.source === 'pack') { const pk = S.packs.find((x) => x.at === p.packAt); if (pk) pk.remaining -= 1; }
      }
      await this.state.storage.put('S', S);
      result = { ok: true };
    } else if (req.op === 'release') {
      delete S.pending[req.resId];
      await this.state.storage.put('S', S);
      result = { ok: true };
    } else if (req.op === 'grantPack') {
      S.packs.push({ at: Date.now(), remaining: req.count || CONSULT_PACK.consult });
      await this.state.storage.put('S', S);
      result = { ok: true, packs: S.packs };
    } else if (req.op === 'status') {
      result = { window: S.window, used: S.used, packs: S.packs, internal: S.internal };
    } else {
      result = { ok: false, error: 'bad op' };
    }
    return json(result, 200);
  }
  addPending(S, kind, source, packAt) {
    const resId = crypto.randomUUID();
    S.pending[resId] = { kind, source, packAt: packAt || null, ts: Date.now() };
    return { ok: true, resId, source };
  }
}

/* ===================== Durable Object: 전체 지출 차단기·통계 ===================== */
export class BudgetLedger {
  constructor(state) { this.state = state; }
  async load() {
    const S = (await this.state.storage.get('B')) || { day: '', costFree: 0, costPaid: 0, alertTotal: false, alertFree: false, stats: {}, samples: {} };
    const d = dayKey();
    if (S.day !== d) { S.day = d; S.costFree = 0; S.costPaid = 0; S.alertTotal = false; S.alertFree = false; }
    return S;
  }
  async fetch(request) {
    const req = await request.json();
    const S = await this.load();
    let result;
    if (req.op === 'check') {
      if (S.costFree + S.costPaid >= req.dailyTotalKrw) result = { blocked: 'total' };
      else if (req.free && S.costFree >= req.dailyFreeKrw) result = { blocked: 'free' };
      else result = { blocked: null };
    } else if (req.op === 'record') {
      const free = req.tier === 'free';
      if (free) S.costFree += req.costKrw; else S.costPaid += req.costKrw;
      const st = S.stats[req.kind] || (S.stats[req.kind] = { calls: 0, costKrw: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, cacheHitCalls: 0, maxTokStops: 0 });
      const u = req.usage || {};
      st.calls++; st.costKrw += req.costKrw;
      st.inTok += u.input_tokens || 0; st.outTok += u.output_tokens || 0;
      st.cacheRead += u.cache_read_input_tokens || 0; st.cacheWrite += u.cache_creation_input_tokens || 0;
      if ((u.cache_read_input_tokens || 0) > 0) st.cacheHitCalls++;
      if (req.stopReason === 'max_tokens') st.maxTokStops++;
      const arr = S.samples[req.kind] || (S.samples[req.kind] = []);
      arr.push(Math.round(req.costKrw * 100) / 100);
      if (arr.length > req.sampleCap) arr.shift();
      result = { alertTotal: false, alertFree: false };
      if (!S.alertTotal && S.costFree + S.costPaid >= req.dailyTotalKrw) { S.alertTotal = true; result.alertTotal = true; }
      if (!S.alertFree && S.costFree >= req.dailyFreeKrw) { S.alertFree = true; result.alertFree = true; }
      result.costFree = S.costFree; result.costPaid = S.costPaid;
    } else if (req.op === 'stats') {
      const pct = (arr, q) => { if (!arr || !arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
      const kinds = {};
      for (const k of Object.keys(S.stats)) {
        const st = S.stats[k], total = st.inTok + st.cacheRead + st.cacheWrite;
        kinds[k] = Object.assign({}, st, {
          avgCostKrw: st.calls ? +(st.costKrw / st.calls).toFixed(2) : 0,
          p50CostKrw: pct(S.samples[k], 0.5), p90CostKrw: pct(S.samples[k], 0.9),
          cacheHitRate: total ? +(st.cacheRead / total).toFixed(3) : 0,          // 입력 토큰 중 캐시에서 읽은 비율
          cacheHitCallRate: st.calls ? +(st.cacheHitCalls / st.calls).toFixed(3) : 0, // 캐시를 한 번이라도 읽은 호출 비율
          maxTokensStopRate: st.calls ? +(st.maxTokStops / st.calls).toFixed(3) : 0,
        });
      }
      result = { day: S.day, costFree: Math.round(S.costFree), costPaid: Math.round(S.costPaid), kinds };
    } else {
      result = { error: 'bad op' };
    }
    await this.state.storage.put('B', S);
    return json(result, 200);
  }
}

/* ===================== 요청 처리 ===================== */
const ledgerOf = (env, uid) => env.LEDGER.get(env.LEDGER.idFromName(uid));
const budgetOf = (env) => env.BUDGET.get(env.BUDGET.idFromName('global'));
const call = async (stub, body) => (await stub.fetch('https://do/', { method: 'POST', body: JSON.stringify(body) })).json();

async function handleAdmin(request, env, url) {
  if (!timingSafeEqual(request.headers.get('X-Admin-Token') || '', env.ADMIN_TOKEN || '')) return json({ error: 'unauthorized' }, 401);
  if (url.pathname === '/admin/stats' && request.method === 'GET') return json(await call(budgetOf(env), { op: 'stats' }), 200);
  if (url.pathname === '/admin/grant-pack' && request.method === 'POST') {
    const b = await request.json();
    if (!b.uid || typeof b.uid !== 'string') return json({ error: 'uid required' }, 400);
    return json(await call(ledgerOf(env, b.uid), { op: 'grantPack', count: b.count }), 200);
  }
  // 이용권 시작: 결제 확인 후 호출 → tier 와 시작일(지금)을 기록. 시작일부터 30일간 유효
  if (url.pathname === '/admin/set-pass' && request.method === 'POST') {
    const b = await request.json();
    if (!b.uid || typeof b.uid !== 'string' || !(b.tier === 'free' || PLANS[b.tier])) return json({ error: 'uid and valid tier required' }, 400);
    await patchUser(env, b.uid, { tier: { stringValue: b.tier }, tierStartedAt: { timestampValue: new Date(b.startedAt || Date.now()).toISOString() } });
    return json({ ok: true, tier: b.tier, validDays: PASS_DAYS }, 200);
  }
  if (url.pathname === '/admin/usage' && request.method === 'GET') {
    const uid = url.searchParams.get('uid');
    if (!uid) return json({ error: 'uid required' }, 400);
    return json(await call(ledgerOf(env, uid), { op: 'status' }), 200);
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/admin/')) return handleAdmin(request, env, url);

    const cors = corsFor(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    const origin = request.headers.get('Origin');
    if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: 'forbidden origin' }, 403, cors);

    // 1) 인증
    const auth = request.headers.get('Authorization') || '';
    const uid = auth.startsWith('Bearer ') ? await verifyIdToken(auth.slice(7)).catch(() => null) : null;
    if (!uid) return json({ error: 'unauthorized' }, 401, cors);

    // 2) 요청 정리
    let raw, body;
    try {
      raw = await request.text();
      if (raw.length > CONFIG.INPUT_CHARS.body) return json({ error: 'too_large' }, 413, cors);
      body = JSON.parse(raw);
    } catch (e) { return json({ error: 'bad_request' }, 400, cors); }
    const kind = body && body.kind;
    if (!AI_KINDS.includes(kind)) return json({ error: 'bad_kind' }, 400, cors);
    let upstream;
    try { upstream = sanitize(body, kind); } catch (e) { return json({ error: 'bad_request', detail: e.message }, 400, cors); }

    // 3) 요금제(서버에서 읽음)
    let info;
    try { info = await getTier(env, uid); } catch (e) {
      console.error('tier lookup failed', e.message);
      return json({ error: 'tier_unavailable' }, 503, cors);
    }
    // 유료 이용권은 시작일부터 30일까지만 유효 — 지나면 무료 등급으로 취급한다
    let tier = info.tier, expired = false;
    if (tier !== 'free' && tier !== 'admin' && Date.now() >= info.startedAt + PASS_DAYS * 86400000) { tier = 'free'; expired = true; }
    const plan = tier === 'admin' ? null : PLANS[tier];
    const windowKey = tier === 'free' ? 'm:' + monthKey() : tier === 'admin' ? 'admin' : 'p:' + tier + ':' + info.startedAt;

    // 4) 전체 지출 차단기
    const gate = await call(budgetOf(env), {
      op: 'check', free: tier === 'free', dailyFreeKrw: CONFIG.BUDGET.dailyFreeKrw, dailyTotalKrw: CONFIG.BUDGET.dailyTotalKrw,
    });
    if (gate.blocked === 'total') return json({ error: 'budget' }, 503, cors);
    if (gate.blocked === 'free') return json({ error: 'free_budget' }, 429, cors);

    // 5) 한도 예약 (성공 후에 확정 차감 — 동시 요청도 원자적으로 막는다)
    const ledger = ledgerOf(env, uid);
    const rsv = await call(ledger, {
      op: 'reserve', kind, window: windowKey, unlimited: tier === 'admin',
      limits: plan && plan.limits, combined: plan && plan.combined,
    });
    if (!rsv.ok) return json(Object.assign({ error: 'quota', kind, limit: rsv.limit }, expired ? { expired: true } : {}), 429, cors);

    const release = () => call(ledger, { op: 'release', resId: rsv.resId, window: windowKey }).catch(() => {});
    const finish = async (usage, stopReason, success) => {
      const cost = costKrw(upstream.model, usage);
      if (success) await call(ledger, { op: 'commit', resId: rsv.resId, window: windowKey }); else await release();
      if (usage) {
        const rec = await call(budgetOf(env), {
          op: 'record', kind, tier, costKrw: cost, usage, stopReason,
          dailyFreeKrw: CONFIG.BUDGET.dailyFreeKrw, dailyTotalKrw: CONFIG.BUDGET.dailyTotalKrw, sampleCap: CONFIG.SAMPLE_CAP,
        });
        if (rec.alertTotal) await sendAlert(env, '[주주도사] 일일 전체 예산 ' + CONFIG.BUDGET.dailyTotalKrw.toLocaleString() + '원 초과 — 모든 AI 호출을 차단했습니다.');
        if (rec.alertFree) await sendAlert(env, '[주주도사] 일일 무료 예산 ' + CONFIG.BUDGET.dailyFreeKrw.toLocaleString() + '원 초과 — 무료 사용자 호출을 차단했습니다.');
      }
    };

    // 6) Anthropic 호출
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(upstream),
      });
    } catch (e) {
      await release();
      return json({ error: 'upstream_unreachable' }, 502, cors);
    }

    if (!res.ok) { // 실패한 호출은 한도를 깎지 않는다
      await release();
      return new Response(res.body, { status: res.status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
    }

    if (upstream.stream) {
      const [toClient, toMeter] = res.body.tee();
      ctx.waitUntil((async () => {
        const reader = toMeter.getReader();
        const td = new TextDecoder();
        let buf = '', usage = null, stopReason = null, done = false, failed = false;
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            buf += td.decode(r.value, { stream: true });
            const evs = buf.split('\n\n');
            buf = evs.pop();
            for (const ev of evs) {
              let data = '';
              for (const line of ev.split('\n')) if (line.startsWith('data: ')) data += line.slice(6);
              if (!data) continue;
              let j; try { j = JSON.parse(data); } catch (e) { continue; }
              if (j.type === 'message_start' && j.message && j.message.usage) usage = Object.assign({}, j.message.usage);
              else if (j.type === 'message_delta') {
                if (j.usage) { usage = usage || {}; for (const k of Object.keys(j.usage)) if (typeof j.usage[k] === 'number') usage[k] = j.usage[k]; }
                if (j.delta && j.delta.stop_reason) stopReason = j.delta.stop_reason;
              } else if (j.type === 'message_stop') done = true;
              else if (j.type === 'error') failed = true;
            }
          }
        } catch (e) { failed = true; }
        await finish(usage, stopReason, done && !failed);
      })());
      return new Response(toClient, {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, cors),
      });
    }

    const data = await res.json();
    ctx.waitUntil(finish(data.usage || null, data.stop_reason || null, true));
    return json(data, 200, cors);
  },
};
