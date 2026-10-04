'use strict';
/**
 * PrepMyJob — relais sécurisé vers l'API Anthropic (remplace api/chat.js de Vercel).
 * Écoute en local (127.0.0.1) ; nginx sert les pages statiques et transmet /api/ ici.
 *
 * Protections (l'ancien relais était ouvert : n'importe qui pouvait dépenser la clé API) :
 *  - origine obligatoire = prepmyjob.com (ou localhost pour les tests)
 *  - le modèle est imposé par le serveur (variable MODEL), jamais choisi par le client
 *  - max_tokens plafonné, taille du corps plafonnée, images limitées
 *  - quota par IP et par jour + plafond global par jour (coût maximal connu)
 *  - aucun contenu (CV, offre) n'est écrit dans les journaux : seulement date, quota, statut
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Chargement minimal du fichier .env (pas de dépendance)
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) { /* ignoré */ }

const PORT = parseInt(process.env.PORT || '5100', 10);
const HOST = '127.0.0.1';
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const MAX_BODY = 8 * 1024 * 1024;           // images de CV comprises
const MAX_TOKENS_CAP = 4000;
const MAX_TEXT_CHARS = 150000;
const MAX_IMAGES = 6;
const PER_IP_DAY = parseInt(process.env.PER_IP_DAY || '60', 10);
const GLOBAL_DAY = parseInt(process.env.GLOBAL_DAY || '400', 10);
const ALLOWED_HOSTS = new Set(['prepmyjob.com', 'www.prepmyjob.com', 'localhost', '127.0.0.1']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

let day = '';
let globalCount = 0;
const perIp = new Map();

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; globalCount = 0; perIp.clear(); }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const fail = (res, status, message) => send(res, status, { error: { type: 'proxy_error', message } });

function originAllowed(req) {
  const origin = req.headers['origin'];
  if (!origin) return false;
  try { return ALLOWED_HOSTS.has(new URL(origin).hostname); } catch (e) { return false; }
}

function clientIp(req) {
  const xr = req.headers['x-real-ip'];
  return (typeof xr === 'string' && xr) || req.socket.remoteAddress || 'inconnue';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Valide et reconstruit un corps minimal : rien d'autre que ce qu'on autorise ne part chez Anthropic. */
function sanitize(input) {
  if (!input || typeof input !== 'object') return { error: 'Requête invalide.' };
  const { messages, system } = input;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) return { error: 'Requête invalide.' };
  let chars = 0, images = 0;
  const clean = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return { error: 'Requête invalide.' };
    if (typeof m.content === 'string') {
      chars += m.content.length;
      clean.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const b of m.content) {
        if (b && b.type === 'text' && typeof b.text === 'string') {
          chars += b.text.length; blocks.push({ type: 'text', text: b.text });
        } else if (b && b.type === 'image' && b.source && b.source.type === 'base64' && IMAGE_TYPES.has(b.source.media_type) && typeof b.source.data === 'string') {
          images += 1; blocks.push({ type: 'image', source: { type: 'base64', media_type: b.source.media_type, data: b.source.data } });
        } else return { error: 'Contenu non pris en charge.' };
      }
      clean.push({ role: m.role, content: blocks });
    } else return { error: 'Requête invalide.' };
  }
  if (chars > MAX_TEXT_CHARS) return { error: 'Texte trop long.' };
  if (images > MAX_IMAGES) return { error: 'Trop d’images.' };
  const body = { model: MODEL, max_tokens: Math.min(Math.max(parseInt(input.max_tokens, 10) || 1000, 1), MAX_TOKENS_CAP), messages: clean };
  if (typeof system === 'string' && system.length > 0 && system.length <= 30000) body.system = system;
  return { body };
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/api/health') return send(res, 200, { ok: true, configured: Boolean(KEY), day, globalCount });
  if (url !== '/api/chat') return fail(res, 404, 'Introuvable.');
  if (req.method !== 'POST') return fail(res, 405, 'Méthode non autorisée.');
  if (!KEY) return fail(res, 503, 'Service momentanément indisponible.');
  if (!originAllowed(req)) return fail(res, 403, 'Origine non autorisée.');

  rollDay();
  const ip = clientIp(req);
  const ipKey = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  const used = perIp.get(ipKey) || 0;
  if (used >= PER_IP_DAY) return fail(res, 429, 'Limite quotidienne atteinte. Réessaie demain.');
  if (globalCount >= GLOBAL_DAY) return fail(res, 429, 'Le service est très sollicité aujourd’hui. Réessaie demain.');

  let parsed;
  try { parsed = JSON.parse(await readBody(req)); }
  catch (e) { return fail(res, e && e.code === 413 ? 413 : 400, e && e.code === 413 ? 'Fichier trop volumineux.' : 'Requête invalide.'); }

  const s = sanitize(parsed);
  if (s.error) return fail(res, 400, s.error);

  perIp.set(ipKey, used + 1);
  globalCount += 1;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(s.body),
      signal: AbortSignal.timeout(110000),
    });
    const data = await r.json();
    console.log(`${new Date().toISOString()} chat status=${r.status} ip=${ipKey} ip_today=${used + 1} global=${globalCount}`);
    if (!r.ok) return send(res, r.status === 401 || r.status === 403 ? 502 : r.status, { error: { type: 'upstream_error', message: (data && data.error && data.error.message) || 'Erreur du moteur IA.' } });
    return send(res, 200, data);
  } catch (e) {
    console.log(`${new Date().toISOString()} chat erreur=${e && e.name}`);
    return fail(res, 504, 'Le moteur IA ne répond pas. Réessaie dans un instant.');
  }
});

server.listen(PORT, HOST, () => console.log(`PrepMyJob relais prêt sur ${HOST}:${PORT} (modèle ${MODEL}, clé ${KEY ? 'présente' : 'ABSENTE'})`));
