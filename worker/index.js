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
    }))
    .sort((a, b) => b.money - a.money || a.name.localeCompare(b.name));
}

// Keep both ends of the table: the richest runs and the deepest debts.
function trimScores(scores) {
  if (scores.length <= MAX_SCORES * 2) return scores;
  return [...scores.slice(0, MAX_SCORES), ...scores.slice(-MAX_SCORES)];
}

async function readScores(token) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${SCORES_PATH}?ref=${SCORES_BRANCH}`;
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  const file = await response.json();
  return { scores: normalizeScores(JSON.parse(decodeBase64(file.content))), sha: file.sha };
}

async function writeScore(token, submitted) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { scores, sha } = await readScores(token);
    const existing = scores.find(entry => entry.id === submitted.id);
    const nextScores = normalizeScores(existing ? scores : [...scores, submitted]);
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${SCORES_PATH}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Record leaderboard score for ${submitted.name}`,
        content: encodeBase64(`${JSON.stringify(nextScores, null, 2)}\n`),
        sha,
        branch: SCORES_BRANCH,
      }),
    });
    if (response.ok) {
      return { scores: nextScores, rank: nextScores.findIndex(entry => entry.id === submitted.id) + 1 };
    }
    if (response.status !== 409) throw new Error(`GitHub write failed (${response.status})`);
  }
  throw new Error('The leaderboard was busy. Please try again.');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json(request, { ok: true });
    if (url.pathname !== '/scores') return json(request, { error: 'Not found' }, 404);
    if (!env.GITHUB_TOKEN) return json(request, { error: 'Leaderboard is not configured' }, 503);

    try {
      if (request.method === 'GET') {
        const { scores } = await readScores(env.GITHUB_TOKEN);
        return json(request, scores);
      }
      if (request.method === 'POST') {
        const body = await request.json();
        const money = Number(body.money);
        const name = String(body.name || '').trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 10);
        const id = String(body.id || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
        if (!name || !id || !Number.isFinite(money) || money < -100000 || money > 1000000) {
          return json(request, { error: 'Invalid score' }, 400);
        }
        const result = await writeScore(env.GITHUB_TOKEN, {
          id,
          name,
          money: Math.round(money * 100) / 100,
          createdAt: new Date().toISOString(),
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
