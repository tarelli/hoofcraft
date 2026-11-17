const GITHUB_OWNER = 'tarelli';
const GITHUB_REPO = 'hoofcraft';
const SCORES_BRANCH = 'scores';
const SCORES_PATH = 'scores.json';
const MAX_SCORES = 20;
const ALLOWED_ORIGINS = new Set([
  'https://tarelli.github.io',
  'https://hoofcraft-pixel-game.metacell-1772.chatgpt.site',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://tarelli.github.io';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  };
}

function json(request, value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: corsHeaders(request) });
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'hoofcraft-leaderboard-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function decodeBase64(value) {
  const binary = atob(value.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function normalizeScores(value) {
  if (!Array.isArray(value)) return [];
  return trimScores(sortScores(value));
}

function sortScores(value) {
  return value
    .filter(entry => entry && typeof entry.name === 'string' && Number.isFinite(Number(entry.money)))
    .map(entry => ({
      id: String(entry.id || crypto.randomUUID()).slice(0, 80),
      name: entry.name.trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 10) || 'RIDER',
      money: Math.round(Number(entry.money) * 100) / 100,
      createdAt: String(entry.createdAt || new Date().toISOString()),
      ...(entry.bad ? { bad: true } : {}),
    }))
    .sort((a, b) => b.money - a.money || a.name.localeCompare(b.name));
}

// Keep three tables: the richest farriers, the richest family men, and the deepest debts.
function trimScores(scores) {
  const keep = new Set([
    ...scores.filter(entry => !entry.bad).slice(0, MAX_SCORES),
    ...scores.filter(entry => entry.bad).slice(0, MAX_SCORES),
    ...scores.filter(entry => entry.money < 0).slice(-MAX_SCORES),
  ]);
  return scores.filter(entry => keep.has(entry));
}

// ---- storage: Cloudflare KV when a SCORES binding exists, otherwise the GitHub file ----
const READ_CACHE_MS = 15000;
let cache = null; // { scores, sha, at }

async function readStore(env, fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < READ_CACHE_MS) return cache;
  let scores;
  let sha = null;
  if (env.SCORES) {
    scores = normalizeScores(JSON.parse((await env.SCORES.get(SCORES_PATH)) || '[]'));
  } else {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${SCORES_PATH}?ref=${SCORES_BRANCH}`;
    const response = await fetch(url, { headers: githubHeaders(env.GITHUB_TOKEN) });
    if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
    const file = await response.json();
    scores = normalizeScores(JSON.parse(decodeBase64(file.content)));
    sha = file.sha;
  }
  cache = { scores, sha, at: Date.now() };
  return cache;
}

// Returns true when stored, false when someone else wrote first and we should retry.
async function writeStore(env, scores, sha, name) {
  if (env.SCORES) {
    await env.SCORES.put(SCORES_PATH, JSON.stringify(scores));
    return true;
  }
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${SCORES_PATH}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...githubHeaders(env.GITHUB_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Record leaderboard score for ${name}`,
      content: encodeBase64(`${JSON.stringify(scores, null, 2)}\n`),
      sha,
      branch: SCORES_BRANCH,
    }),
  });
  if (response.ok) return true;
  if (response.status === 409) return false;
  throw new Error(`GitHub write failed (${response.status})`);
}

async function writeScore(env, submitted) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { scores, sha } = await readStore(env, true);
    if (scores.some(entry => entry.id === submitted.id)) {
      return { scores, rank: scores.findIndex(entry => entry.id === submitted.id) + 1 };
    }
    const nextScores = normalizeScores([...scores, submitted]);
    const rank = nextScores.findIndex(entry => entry.id === submitted.id) + 1;
    // Most runs do not make any of the three tables: nothing to store.
    if (!rank) return { scores, rank: 0 };
    if (await writeStore(env, nextScores, sha, submitted.name)) {
      cache = { scores: nextScores, sha: null, at: 0 };
      return { scores: nextScores, rank };
    }
  }
  throw new Error('The leaderboard was busy. Please try again.');
}

// ---- anti-cheat: a run must start with a signed session and take a plausible time ----
const MIN_RUN_MS = 45000;
const MAX_RUN_MS = 12 * 60 * 60 * 1000;
const usedSessions = new Set();
const lastPost = new Map();

async function sign(env, text) {
  const secret = env.SESSION_SECRET || env.GITHUB_TOKEN || 'hoofcraft';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`session:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

async function newSession(env) {
  const started = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  return `${started}.${await sign(env, started)}`;
}

// Returns the run's age in milliseconds, or 0 when the token is not ours.
async function sessionAge(env, token) {
  const [started, mac] = String(token || '').split('.');
  if (!started || !mac || mac !== (await sign(env, started))) return 0;
  return Date.now() - parseInt(started, 36);
}

function plausible(money, bad, ageMs) {
  const minutes = ageMs / 60000;
  const ceiling = bad ? Math.min(5000000, 100000 * minutes) : Math.min(1000000, 40000 * minutes);
  return money >= -100000 && money <= ceiling;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json(request, { ok: true });
    if (!env.GITHUB_TOKEN && !env.SCORES) return json(request, { error: 'Leaderboard is not configured' }, 503);
    if (url.pathname === '/session' && request.method === 'GET') return json(request, { token: await newSession(env) });
    if (url.pathname !== '/scores') return json(request, { error: 'Not found' }, 404);

    try {
      if (request.method === 'GET') {
        const { scores } = await readStore(env);
        return json(request, scores);
      }
      if (request.method === 'POST') {
        const body = await request.json();
        const money = Number(body.money);
        const name = String(body.name || '').trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 10);
        const id = String(body.id || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
        if (!name || !id || !Number.isFinite(money) || money < -100000 || money > 5000000) {
          return json(request, { error: 'Invalid score' }, 400);
        }
        const bad = body.bad === true;
        const age = await sessionAge(env, body.token);
        if (age < MIN_RUN_MS || age > MAX_RUN_MS || usedSessions.has(body.token)) return json(request, { error: 'Invalid session' }, 401);
        if (!plausible(money, bad, age)) return json(request, { error: 'Implausible score' }, 422);
        const ip = request.headers.get('CF-Connecting-IP') || '';
        if (ip && Date.now() - (lastPost.get(ip) || 0) < 10000) return json(request, { error: 'Slow down' }, 429);
        lastPost.set(ip, Date.now());
        if (lastPost.size > 5000) lastPost.clear();
        usedSessions.add(body.token);
        if (usedSessions.size > 20000) usedSessions.clear();
        const result = await writeScore(env, {
          id,
          name,
          money: Math.round(money * 100) / 100,
          createdAt: new Date().toISOString(),
          ...(bad ? { bad: true } : {}),
        });
        return json(request, result, 201);
      }
      return json(request, { error: 'Method not allowed' }, 405);
    } catch (error) {
      console.error(error);
      return json(request, { error: 'Leaderboard temporarily unavailable' }, 502);
    }
  },
};
