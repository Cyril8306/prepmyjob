'use strict';
/**
 * PrepMyJob — relais sécurisé vers l'API Anthropic + pass payant (Stripe).
 * Écoute en local (127.0.0.1) ; nginx sert les pages statiques et transmet /api/ ici.
 *
 * Protections :
 *  - les consignes envoyées à l'IA sont écrites ICI : la page n'envoie que ses données (CV, offre, réponse),
 *    le relais ne peut donc pas servir à autre chose qu'à PrepMyJob
 *  - origine obligatoire = prepmyjob.com (ou localhost pour les tests)
 *  - modèle imposé par le serveur (variable MODEL), max_tokens fixé par étape, tailles plafonnées
 *  - étapes gratuites (analyse, lecture d'image, lecture d'une annonce par son lien) : quota par IP et par jour
 *    + plafond global par jour
 *  - étapes payantes (questions, simulation, lettre) : pass vérifié ici (30 jours, 5 offres, 200 générations)
 *  - lecture d'annonce par lien : http(s) seulement, ports 80/443, adresses internes refusées au moment
 *    même de la connexion, 4 redirections et 4 Mo au plus, 10 s
 *  - aucun CV ni offre n'est écrit dans les journaux ni sur le disque : un pass ne garde que des empreintes
 *    (e-mail, offres), des compteurs et la référence du paiement
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const tls = require('tls');
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
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const SITE_URL = (process.env.SITE_URL || 'https://prepmyjob.com').replace(/\/$/, '');
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.hostinger.com';
const SMTP_USER = process.env.SMTP_USER || 'contact@prepmyjob.com';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAX_BODY = 8 * 1024 * 1024;           // images de CV comprises
const PER_IP_DAY = parseInt(process.env.PER_IP_DAY || '60', 10);   // appels gratuits par IP et par jour
const GLOBAL_DAY = parseInt(process.env.GLOBAL_DAY || '400', 10);  // appels gratuits par jour, tout le site
const ACCOUNT_IP_DAY = 30;                  // paiement, activation, récupération, rétractation : par IP et par jour
const ALLOWED_HOSTS = new Set(['prepmyjob.com', 'www.prepmyjob.com', 'localhost', '127.0.0.1']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Le pass (CGV : public/cgv.html). Le texte de la case doit rester identique à celui de public/app.html.
const PASS_PRICE_CENTS = 1400;
const PASS_DAYS = 30;
const PASS_OFFRES = 5;
const PASS_CALLS = 200;
const RETRACT_DAYS = 14;
const CGV_VERSION = '2026-10-13';
const CONSENT_TEXT = "J'accepte les conditions générales de vente et je demande l'accès immédiat au pass. Je reconnais qu'en cas de rétractation dans les 14 jours, seule la part non utilisée me sera remboursée.";
const DAY_MS = 86400000;

const DATA_DIR = path.join(__dirname, '..', 'data');
const PASS_FILE = path.join(DATA_DIR, 'passes.json');
const RETRACT_FILE = path.join(DATA_DIR, 'retractations.json');
const OUTBOX = path.join(DATA_DIR, 'outbox');
fs.mkdirSync(OUTBOX, { recursive: true });

// Secret local : les e-mails ne sont gardés que sous forme d'empreinte, illisible sans ce fichier.
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
let SECRET = '';
try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { /* 1er démarrage */ }
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }
const emailKey = (e) => crypto.createHmac('sha256', SECRET).update(String(e || '').trim().toLowerCase()).digest('hex');
const offreKey = (o) => crypto.createHash('sha256').update(String(o).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const passes = Object.assign(Object.create(null), readJson(PASS_FILE, {}));
const getPass = (id) => (typeof id === 'string' && /^pmj_[a-f0-9]{32}$/.test(id) ? passes[id] || null : null);
function savePasses() {
  const limit = Date.now() - 365 * DAY_MS; // effacés un an après expiration
  for (const [id, p] of Object.entries(passes)) if (p.expires < limit) delete passes[id];
  writeJson(PASS_FILE, passes);
}

let day = '';
let globalCount = 0;
const perIp = new Map();
const perIpAccount = new Map();

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; globalCount = 0; perIp.clear(); perIpAccount.clear(); }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const fail = (res, status, message, type) => send(res, status, { error: { type: type || 'proxy_error', message } });

function originAllowed(req) {
  const origin = req.headers['origin'];
  if (!origin) return false;
  try { return ALLOWED_HOSTS.has(new URL(origin).hostname); } catch (e) { return false; }
}

function ipKeyOf(req) {
  const xr = req.headers['x-real-ip'];
  const ip = (typeof xr === 'string' && xr) || req.socket.remoteAddress || 'inconnue';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}
function limitAccount(req) {
  const k = ipKeyOf(req), n = perIpAccount.get(k) || 0;
  if (n >= ACCOUNT_IP_DAY) return false;
  perIpAccount.set(k, n + 1);
  return true;
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

const str = (v, max, min) => (typeof v === 'string' && v.trim().length >= (min || 1) && v.length <= max ? v : null);
const euros = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';
const dateFr = (ms) => new Date(ms).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' });
const dateHeureFr = (ms) => new Date(ms).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ---------- Consignes IA (une par étape) ---------- */
const Q_FORMAT = " JSON array: [{\"cat\":\"catégorie courte\",\"q\":\"la question\",\"why\":\"pourquoi le recruteur pose ça + sur quel élément du CV ça s'appuie\",\"model\":\"réponse type complète à la 1ère personne, 3-6 phrases, ancrée sur le parcours réel du candidat\",\"tips\":\"1 conseil court\"}]";
// 14 questions = 2 demandes de 7 en parallèle : une demande de 14 dépasse 4 000 tokens et ~110 s.
const Q_LOTS = [
  "Génère 7 questions d'entretien : 1 de présentation, 2 de motivation (pour le poste et pour l'entreprise), 4 sur les compétences techniques du poste.",
  "Génère 7 questions d'entretien : 2 comportementales (méthode STAR), 2 mises en situation concrètes du poste, 2 questions pièges sur les points faibles du CV par rapport à l'offre, 1 question de clôture.",
];
const STEPS = {
  analyse: {
    paid: false, max: 1500,
    build(d) {
      const cv = str(d.cv, 60000, 30), offre = str(d.offre, 60000, 30);
      if (!cv || !offre) return null;
      return {
        system: "Tu es un recruteur senior et coach carrière. Analyse l'adéquation entre un CV et une offre d'emploi. Détecte la langue de l'offre et réponds DANS CETTE LANGUE. Réponds UNIQUEMENT en JSON valide, sans texte autour.",
        content: "OFFRE D'EMPLOI:\n" + offre + "\n\nCV DU CANDIDAT:\n" + cv + "\n\nRéponds en JSON: {\"langue\":\"fr/en/es/de\",\"poste\":\"intitulé du poste visé\",\"score\":nombre 0-100 d'adéquation,\"resume\":\"1 phrase de synthèse\",\"forces\":[\"3-4 atouts concrets du candidat pour CE poste\"],\"risques\":[\"2-3 points faibles ou manques à anticiper en entretien\"],\"axes\":[\"2-3 conseils pour cartonner l'entretien\"]}",
      };
    },
  },
  ocr: {
    paid: false, max: 2000,
    build(d) {
      const im = d.image;
      if (!im || !IMAGE_TYPES.has(im.media_type) || !str(im.data, MAX_BODY)) return null;
      return { content: [
        { type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } },
        { type: 'text', text: "Transcris fidelement et integralement tout le texte present dans cette image (CV ou offre d'emploi). Renvoie uniquement le texte brut, sans commentaire ni ajout." },
      ] };
    },
  },
  questions: {
    paid: true, max: 4000, offre: true,
    build(d) {
      const cv = str(d.cv, 60000, 30), offre = str(d.offre, 60000, 30), lot = Q_LOTS[d.lot];
      if (!cv || !offre || !lot) return null;
      return {
        system: "Tu es un recruteur expert qui prépare un candidat à son entretien. Génère des questions RÉALISTES que le recruteur posera, basées sur le CV et l'offre. Chaque question doit avoir une réponse type rédigée À LA PREMIÈRE PERSONNE (comme si le candidat la disait), ancrée sur SON parcours réel. Réponds dans la langue de l'offre. UNIQUEMENT du JSON valide.",
        content: "OFFRE:\n" + offre + "\n\nCV:\n" + cv + "\n\n" + lot + Q_FORMAT,
      };
    },
  },
  eval: {
    paid: true, max: 1800,
    build(d) {
      const cv = str(d.cv, 60000, 30), q = str(d.question, 2000), ans = str(d.answer, 10000, 10);
      if (!cv || !q || !ans) return null;
      return {
        system: "Tu es un recruteur " + (d.hard === true ? "exigeant et critique" : "bienveillant mais honnête") + ". Évalue la réponse d'un candidat en entretien. Réponds dans la langue de la question. UNIQUEMENT du JSON valide.",
        content: "CONTEXTE CV:\n" + cv.slice(0, 1500) + "\n\nQUESTION POSÉE:\n" + q + "\n\nRÉPONSE DU CANDIDAT:\n" + ans + "\n\nÉvalue. JSON: {\"note\":0-10,\"bien\":[\"ce qui marche, 1-3 points\"],\"manque\":[\"ce qui manque ou à améliorer, 1-3 points\"],\"version\":\"une version améliorée de la réponse à la 1ère personne\"}",
      };
    },
  },
  lettre: {
    paid: true, max: 2000, offre: true,
    build(d) {
      const cv = str(d.cv, 60000, 30), offre = str(d.offre, 60000, 30), lm = d.lm ? str(d.lm, 30000) : '';
      if (!cv || !offre || lm === null) return null;
      return {
        system: "Tu es un expert en candidatures. Rédige une lettre de motivation percutante, sincère et personnalisée, basée sur le CV et l'offre. Détecte la langue de l'offre et rédige DANS CETTE LANGUE. Pas de placeholders type [Nom], utilise les vraies infos du CV. Seule exception : n'écris jamais de date toi-même ; là où la lettre porte la date, écris exactement {{DATE}} (elle sera remplacée automatiquement par la date du jour complète). Texte brut uniquement : aucune mise en forme Markdown (pas d'astérisques, pas de dièses). Réponds uniquement avec le texte de la lettre.",
        content: "OFFRE:\n" + offre + "\n\nCV:\n" + cv + (lm ? "\n\nANCIENNE LETTRE (pour le style/infos):\n" + lm : "") + "\n\nRédige la lettre de motivation complète, prête à envoyer.",
      };
    },
  },
};

/* ---------- Stripe (API REST, sans dépendance) ---------- */
async function stripe(method, pathname, params, idempotencyKey) {
  const qs = params ? new URLSearchParams(params).toString() : '';
  const headers = { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey; // une même opération n'est jamais exécutée deux fois
  const r = await fetch('https://api.stripe.com/v1/' + pathname + (method === 'GET' && qs ? '?' + qs : ''), {
    method,
    headers,
    body: method === 'GET' ? undefined : qs,
    signal: AbortSignal.timeout(20000),
  });
  const d = await r.json();
  // Message exact de Stripe dans le journal du serveur (pm2 logs) : une panne se diagnostique en une fois
  if (!r.ok) throw Object.assign(new Error(((d.error && [d.error.type, d.error.code, d.error.message].filter(Boolean).join(' / ')) || 'stripe').slice(0, 400)), { status: r.status });
  return d;
}
const sessionPaid = (s) => s && s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required')
  && s.metadata && s.metadata.produit === 'pass30';

/* ---------- E-mails (SMTP de la boîte contact@, sans dépendance) ---------- */
let MAIL_OK = false;
function smtp(commands) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(465, SMTP_HOST, { servername: SMTP_HOST });
    sock.setEncoding('utf8');
    sock.setTimeout(20000, () => { sock.destroy(); reject(new Error('smtp_delai')); });
    sock.on('error', reject);
    let buf = '', i = 0;
    sock.on('data', (chunk) => {
      buf += chunk;
      if (!buf.endsWith('\r\n')) return;
      const lines = buf.split('\r\n');
      const last = lines[lines.length - 2];
      if (!last || !/^\d{3} /.test(last)) return;          // réponse incomplète
      buf = '';
      const [cmd, expected] = commands[i];
      if (String(last).slice(0, 1) !== String(expected).slice(0, 1)) { sock.destroy(); return reject(new Error('smtp_' + last.slice(0, 3) + (cmd ? '_' + cmd.split(' ')[0] : ''))); }
      i += 1;
      if (i >= commands.length) { sock.end(); return resolve(true); }
      sock.write(commands[i][0] + '\r\n');
    });
  });
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const smtpLogin = () => [[null, 220], ['EHLO prepmyjob.com', 250], ['AUTH PLAIN ' + b64('\0' + SMTP_USER + '\0' + SMTP_PASS), 235]];
/** Envoie un e-mail texte. Sans mot de passe SMTP, il est rangé dans data/outbox (trace) au lieu d'être envoyé. */
async function sendMail(to, subject, text, bcc) {
  const mail = [
    `From: PrepMyJob <${SMTP_USER}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@prepmyjob.com>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    b64(text).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  if (!SMTP_PASS) {
    fs.writeFileSync(path.join(OUTBOX, Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.txt'), `To: ${to}\nSubject: ${subject}\n\n${text}`, { mode: 0o600 });
    return false;
  }
  const rcpts = [to].concat(bcc && bcc !== to ? [bcc] : []);
  await smtp([...smtpLogin(), [`MAIL FROM:<${SMTP_USER}>`, 250], ...rcpts.map((r) => [`RCPT TO:<${r}>`, 250]),
    ['DATA', 354], [mail + '\r\n.', 250], ['QUIT', 221]]);
  return true;
}

// Texte des CGV joint à la confirmation de commande (une seule source : public/cgv.html)
function cgvText() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'cgv.html'), 'utf8');
    const m = html.match(/<article id="cgv">([\s\S]*?)<\/article>/);
    return (m ? m[1] : '')
      .replace(/<h[12][^>]*>/g, '\n\n').replace(/<\/h[12]>/g, '\n').replace(/<li[^>]*>/g, '\n- ')
      .replace(/<\/p>|<br\s*\/?>|<\/tr>/g, '\n').replace(/<\/t[hd]>/g, ' ').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch (e) { return 'Conditions générales de vente : ' + SITE_URL + '/cgv'; }
}

/* ---------- Pass ---------- */
const passInfo = (p) => ({
  pass: p.id, created: p.created, expires: p.expires, offres: p.offres.length, offresMax: PASS_OFFRES,
  restant: Math.max(0, PASS_CALLS - p.calls), retractable: Date.now() < p.created + RETRACT_DAYS * DAY_MS && !p.retracte,
});

async function createPassFromSession(s) {
  const again = Object.values(passes).find((p) => p.session === s.id); // deux activations simultanées
  if (again) return again;
  const created = s.created * 1000;
  const email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
  const p = {
    id: 'pmj_' + crypto.randomBytes(16).toString('hex'), session: s.id, pi: s.payment_intent || null,
    email: emailKey(email), created, expires: created + PASS_DAYS * DAY_MS,
    offres: [], calls: 0, montant: s.amount_total || 0, retracte: null,
  };
  passes[p.id] = p; savePasses();
  console.log(`${new Date().toISOString()} evenement=pass_active montant=${p.montant}`);
  if (email) {
    const text = [
      'Bonjour,', '', 'Merci pour votre achat. Voici la confirmation de votre commande.', '',
      'Produit : Pass PrepMyJob 30 jours',
      `Prix payé : ${euros(p.montant)} TTC (TVA non applicable, art. 293 B du CGI)`,
      `Date de la commande : ${dateHeureFr(created)} (heure de Paris)`,
      `Accès : jusqu'au ${dateFr(p.expires)}, pour ${PASS_OFFRES} offres d'emploi au maximum`,
      `Référence : ${s.id.slice(-12)}`, '',
      'VOTRE DEMANDE D\'ACCÈS IMMÉDIAT', 'Avant de payer, vous avez coché la case suivante :', `« ${CONSENT_TEXT} »`, '',
      'RÉTRACTATION',
      `Vous pouvez vous rétracter jusqu'au ${dateFr(created + RETRACT_DAYS * DAY_MS)} depuis la page ${SITE_URL}/retractation (« Renoncer au contrat ici ») ou en écrivant à ${SMTP_USER}.`,
      `Chaque offre d'emploi déjà préparée est due (1/${PASS_OFFRES} du prix) ; le reste vous est remboursé.`, '',
      'RETROUVER VOTRE PASS SUR UN AUTRE APPAREIL',
      `Sur ${SITE_URL}/app, touchez « Vous avez déjà un pass ? » et saisissez cette adresse e-mail.`, '',
      'Les conditions générales de vente en vigueur lors de votre commande figurent ci-dessous.', '',
      'Cyril CRETIN — PrepMyJob (entrepreneur individuel, SIREN 825 243 439)', SMTP_USER, '',
      '──────────', cgvText(),
    ].join('\n');
    sendMail(email, 'Votre pass PrepMyJob : confirmation de commande', text)
      .catch((e) => console.log(`${new Date().toISOString()} email_confirmation erreur=${e.message}`));
  }
  return p;
}

/** Compte un appel gratuit (IP + plafond global du jour). Renvoie le message de refus, ou null si c'est accepté. */
function quotaGratuit(ipKey) {
  const used = perIp.get(ipKey) || 0;
  if (used >= PER_IP_DAY) return 'Limite quotidienne atteinte. Réessaie demain.';
  if (globalCount >= GLOBAL_DAY) return 'Le service est très sollicité aujourd’hui. Réessaie demain.';
  perIp.set(ipKey, used + 1); globalCount += 1;
  return null;
}

/** Appel au modèle (consignes fixes). Renvoie le texte de la réponse, ou lève une erreur. */
async function claude(system, content, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(110000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('ia_' + r.status);
  return (data.content && data.content[0] && data.content[0].text) || '';
}

/* ---------- Lecture d'une annonce à partir de son lien ---------- */
function ipInterne(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = String(ip).toLowerCase();
  if (v.startsWith('::ffff:')) return ipInterne(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}
// Résolution contrôlée au moment même de la connexion : le lien ne peut pas viser le serveur ni un réseau interne
function lookupPublic(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => ipInterne(a.address))) return cb(new Error('adresse_interdite'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
function lirePage(lien, sauts = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(lien); } catch (e) { return reject(new Error('lien_invalide')); }
    if (!/^https?:$/.test(url.protocol) || (url.port && !['80', '443'].includes(url.port)) || url.username || url.password) return reject(new Error('lien_invalide'));
    // Une adresse IP écrite en clair ne passe pas par la résolution DNS : contrôle direct
    const hoteIp = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hoteIp) && ipInterne(hoteIp)) return reject(new Error('adresse_interdite'));
    const req = (url.protocol === 'https:' ? https : http).get(url, {
      lookup: lookupPublic, timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PrepMyJob/1.0; +https://prepmyjob.com/aide)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'fr-FR,fr;q=0.9', 'Accept-Encoding': 'gzip, deflate, br' },
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        if (sauts >= 4) return reject(new Error('trop_de_redirections'));
        return resolve(lirePage(new URL(r.headers.location, url).href, sauts + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(Object.assign(new Error('http_' + r.statusCode), { status: r.statusCode })); }
      const enc = String(r.headers['content-encoding'] || '').toLowerCase();
      const flux = enc === 'gzip' ? r.pipe(zlib.createGunzip()) : enc === 'br' ? r.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? r.pipe(zlib.createInflate()) : r;
      let taille = 0; const morceaux = [];
      flux.on('data', (c) => { taille += c.length; if (taille > 4 * 1024 * 1024) { req.destroy(); reject(new Error('page_trop_lourde')); } else morceaux.push(c); });
      flux.on('end', () => resolve(Buffer.concat(morceaux).toString('utf8')));
      flux.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('delai')));
    req.on('error', reject);
  });
}
const entites = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const texteDeHtml = (h) => entites(String(h || '').replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|li|h\d|div|tr|ul|ol)>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
// La plupart des sites d'emploi décrivent l'annonce en données structurées (schema.org JobPosting)
function annonceStructuree(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const items = [].concat(data).flatMap((x) => (x && x['@graph']) ? x['@graph'] : [x]);
    const jp = items.find((x) => x && [].concat(x['@type']).includes('JobPosting'));
    if (!jp) continue;
    const nom = (o) => (typeof o === 'string' ? o : o && typeof o.name === 'string' ? o.name : '');
    const lieux = [].concat(jp.jobLocation || []).map((l) => l && l.address && [l.address.addressLocality, l.address.postalCode].filter((v) => typeof v === 'string').join(' ')).filter(Boolean);
    const texte = [
      typeof jp.title === 'string' ? jp.title : '',
      nom(jp.hiringOrganization) && 'Entreprise : ' + nom(jp.hiringOrganization),
      lieux.length ? 'Lieu : ' + lieux.join(', ') : '',
      [].concat(jp.employmentType || []).filter((v) => typeof v === 'string').length ? 'Contrat : ' + [].concat(jp.employmentType).join(', ') : '',
      '', texteDeHtml(texteDeHtml(jp.description)),
    ].filter((l, i) => l || i === 4).join('\n').trim();
    return { titre: typeof jp.title === 'string' ? jp.title : '', texte };
  }
  return null;
}
const MSG_LIEN_BLOQUE = "Ce site ne laisse pas lire l'annonce complète (c'est le cas d'Indeed ou de France Travail). Faites une capture d'écran de l'annonce et déposez-la dans « L'offre d'emploi ».";

async function handleLien(req, res, d) {
  const lien = typeof d.url === 'string' ? d.url.trim() : '';
  if (!lien || lien.length > 2000) return fail(res, 400, 'Lien invalide.');
  const refus = quotaGratuit(ipKeyOf(req));
  if (refus) return fail(res, 429, refus);
  let hote = '?';
  try { hote = new URL(lien).hostname; } catch (e) { return fail(res, 400, 'Lien invalide.'); }
  let html;
  try { html = await lirePage(lien); }
  catch (e) {
    console.log(`${new Date().toISOString()} lien site=${hote} erreur=${e.message}`);
    return fail(res, 422, e.message === 'lien_invalide' || e.message === 'adresse_interdite' ? 'Lien invalide.' : MSG_LIEN_BLOQUE, 'lien_bloque');
  }
  let a = annonceStructuree(html), source = 'structure';
  if (!a || a.texte.length < 200) {
    // Pas de données structurées : l'IA isole le texte de l'annonce dans le texte brut de la page
    const brut = texteDeHtml(html).slice(0, 25000);
    let t = '';
    if (KEY && brut.length > 200) {
      try {
        t = (await claude("Tu reçois le texte brut d'une page web. Si elle contient une offre d'emploi AVEC sa description (missions ou profil recherché), recopie uniquement le texte de l'offre (intitulé, entreprise, lieu, contrat, missions, profil, conditions), fidèlement, sans rien inventer ni résumer, en texte brut sans aucune mise en forme Markdown. Si la page ne contient pas d'offre, ou seulement l'intitulé et le lieu sans les missions ni le profil, réponds exactement : AUCUNE_OFFRE", brut, 2500)).trim()
          .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/^\s*-{3,}\s*$/gm, '').replace(/\*\*/g, '').trim();
      } catch (e) { t = ''; }
    }
    // Une annonce réduite à l'intitulé et au lieu donnerait une mauvaise analyse : on propose la capture d'écran
    if (!t || t.includes('AUCUNE_OFFRE') || t.length < 400) {
      console.log(`${new Date().toISOString()} lien site=${hote} resultat=aucune_offre`);
      return fail(res, 422, MSG_LIEN_BLOQUE, 'lien_bloque');
    }
    a = { titre: t.split('\n')[0].slice(0, 120), texte: t }; source = 'ia';
  }
  console.log(`${new Date().toISOString()} lien site=${hote} source=${source}`);
  return send(res, 200, { titre: a.titre, texte: a.texte.slice(0, 30000), source });
}

/* ---------- Routes ---------- */
async function handleAI(req, res, d) {
  const step = STEPS[d.step];
  if (!step) return fail(res, 400, 'Requête invalide.');
  if (!KEY) return fail(res, 503, 'Service momentanément indisponible.');
  const built = step.build(d);
  if (!built) return fail(res, 400, 'Requête invalide.');

  let p = null, newOffre = null;
  const ipKey = ipKeyOf(req);
  if (step.paid) {
    p = getPass(req.headers['x-pass']);
    if (!p) return fail(res, 402, 'Cette étape fait partie du pass PrepMyJob.', 'pass_required');
    if (p.retracte) return fail(res, 402, 'Ce pass a fait l\'objet d\'une rétractation.', 'pass_required');
    if (p.expires < Date.now()) return fail(res, 402, 'Votre pass a expiré.', 'pass_expired');
    if (p.calls >= PASS_CALLS) return fail(res, 402, `Votre pass a atteint sa limite de ${PASS_CALLS} générations.`, 'pass_limit');
    if (step.offre) {
      const k = offreKey(d.offre);
      if (!p.offres.includes(k)) {
        if (p.offres.length >= PASS_OFFRES) return fail(res, 402, `Votre pass couvre ${PASS_OFFRES} offres d'emploi : elles sont toutes utilisées.`, 'pass_limit');
        newOffre = k; p.offres.push(k);
      }
    }
    p.calls += 1; savePasses();
  } else {
    const refus = quotaGratuit(ipKey);
    if (refus) return fail(res, 429, refus);
  }
  const refund = () => { if (p) { p.calls -= 1; if (newOffre) p.offres = p.offres.filter((k) => k !== newOffre); savePasses(); } };

  const body = { model: MODEL, max_tokens: step.max, messages: [{ role: 'user', content: built.content }] };
  if (built.system) body.system = built.system;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(110000),
    });
    const data = await r.json();
    console.log(`${new Date().toISOString()} ia etape=${d.step} status=${r.status} ip=${ipKey} ${p ? 'pass' : 'gratuit global=' + globalCount}`);
    if (!r.ok) { refund(); return send(res, r.status === 401 || r.status === 403 ? 502 : r.status, { error: { type: 'upstream_error', message: (data && data.error && data.error.message) || 'Erreur du moteur IA.' } }); }
    return send(res, 200, data);
  } catch (e) {
    refund();
    console.log(`${new Date().toISOString()} ia erreur=${e && e.name}`);
    return fail(res, 504, 'Le moteur IA ne répond pas. Réessaie dans un instant.');
  }
}

async function handleCheckout(req, res, d) {
  if (!STRIPE_KEY) return fail(res, 503, 'Le paiement n’est pas encore ouvert. Réessayez bientôt.');
  const email = typeof d.email === 'string' ? d.email.trim() : '';
  if (!EMAIL_RE.test(email) || email.length > 200) return fail(res, 400, 'Adresse e-mail invalide.');
  if (d.consent !== true) return fail(res, 400, 'Cochez la case des conditions de vente pour continuer.');
  if (!limitAccount(req)) return fail(res, 429, 'Trop de tentatives aujourd’hui. Réessayez demain.');
  const now = new Date();
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'payment', locale: 'fr', customer_email: email,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': String(PASS_PRICE_CENTS),
    'line_items[0][price_data][product_data][name]': 'Pass PrepMyJob 30 jours',
    'line_items[0][price_data][product_data][description]': `Jusqu'à ${PASS_OFFRES} offres d'emploi : questions et réponses types, simulation notée, lettre de motivation. Paiement unique, sans abonnement.`,
    'payment_intent_data[receipt_email]': email,
    'payment_intent_data[description]': `Pass PrepMyJob 30 jours (accès immédiat demandé, CGV du ${dateFr(Date.parse(CGV_VERSION))})`,
    // Facture envoyée par Stripe après paiement (réglage Stripe « Paiements réussis » activé)
    'invoice_creation[enabled]': 'true',
    'invoice_creation[invoice_data][description]': `Pass PrepMyJob 30 jours, ${PASS_OFFRES} offres d'emploi au maximum. Accès immédiat demandé par le client. Rétractation : ${SITE_URL}/retractation`,
    'invoice_creation[invoice_data][footer]': 'TVA non applicable, art. 293 B du CGI. Cyril CRETIN, entrepreneur individuel, SIREN 825 243 439.',
    'invoice_creation[invoice_data][metadata][produit]': 'pass30',
    'metadata[produit]': 'pass30', 'metadata[cgv]': CGV_VERSION,
    'metadata[consentement_le]': now.toISOString(), 'metadata[consentement]': CONSENT_TEXT,
    allow_promotion_codes: 'true',
    // « Managed Payments » (activé par défaut sur le compte réel) ferait de Stripe le vendeur légal (+3,5 %, TVA facturée) :
    // le vendeur reste Cyril CRETIN, en franchise de TVA, comme l'indiquent les CGV.
    'managed_payments[enabled]': 'false',
    success_url: SITE_URL + '/app?pass={CHECKOUT_SESSION_ID}',
    cancel_url: SITE_URL + '/app?paiement=annule',
  });
  console.log(`${now.toISOString()} evenement=paiement_ouvert`);
  return send(res, 200, { url: s.url });
}

async function handleActivate(req, res, d) {
  const sid = typeof d.session_id === 'string' ? d.session_id : '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,250}$/.test(sid)) return fail(res, 400, 'Lien de paiement invalide.');
  const existing = Object.values(passes).find((p) => p.session === sid);
  if (existing) return send(res, 200, passInfo(existing));
  if (!STRIPE_KEY) return fail(res, 503, 'Le paiement n’est pas encore ouvert.');
  if (!limitAccount(req)) return fail(res, 429, 'Trop de tentatives aujourd’hui. Réessayez demain.');
  const s = await stripe('GET', 'checkout/sessions/' + sid);
  if (!sessionPaid(s)) return fail(res, 402, 'Paiement non confirmé.', 'pass_required');
  return send(res, 200, passInfo(await createPassFromSession(s)));
}

// Retrouver son pass avec l'e-mail du paiement (autre appareil, ou retour sur le site jamais terminé)
async function handleRecover(req, res, d) {
  const email = typeof d.email === 'string' ? d.email.trim() : '';
  if (!EMAIL_RE.test(email) || email.length > 200) return fail(res, 400, 'Adresse e-mail invalide.');
  if (!limitAccount(req)) return fail(res, 429, 'Trop de tentatives aujourd’hui. Réessayez demain.');
  const k = emailKey(email), now = Date.now();
  let p = Object.values(passes).filter((x) => x.email === k && x.expires > now && !x.retracte).sort((a, b) => b.expires - a.expires)[0];
  if (!p && STRIPE_KEY) {
    const list = await stripe('GET', 'checkout/sessions', { 'customer_details[email]': email, status: 'complete', limit: '10' });
    const s = (list.data || []).filter((x) => sessionPaid(x) && x.created * 1000 + PASS_DAYS * DAY_MS > now
      && !Object.values(passes).some((q) => q.session === x.id && q.retracte)).sort((a, b) => b.created - a.created)[0];
    if (s) p = await createPassFromSession(s);
  }
  if (!p) return fail(res, 404, 'Aucun pass actif pour cette adresse e-mail.');
  return send(res, 200, passInfo(p));
}

async function handleStatus(req, res) {
  const p = getPass(req.headers['x-pass']);
  if (!p || p.retracte || p.expires < Date.now()) return fail(res, 404, 'Pass introuvable ou expiré.', 'pass_required');
  return send(res, 200, passInfo(p));
}

// Fonctionnalité de rétractation (« Renoncer au contrat ici ») : enregistrement, remboursement, accusé de réception
async function handleRetract(req, res, d) {
  const nom = str(d.nom, 120, 2), email = typeof d.email === 'string' ? d.email.trim() : '';
  const ref = d.reference ? str(d.reference, 120) : '';
  const ar = typeof d.email_ar === 'string' && d.email_ar.trim() ? d.email_ar.trim() : email;
  if (!nom || !EMAIL_RE.test(email) || !EMAIL_RE.test(ar) || ref === null || d.confirm !== true) return fail(res, 400, 'Merci de remplir votre nom et l’e-mail utilisé pour le paiement.');
  if (!limitAccount(req)) return fail(res, 429, 'Trop de tentatives aujourd’hui. Écrivez-nous à ' + SMTP_USER + '.');
  const at = Date.now(), k = emailKey(email);
  const p = Object.values(passes).filter((x) => x.email === k && !x.retracte && at < x.created + RETRACT_DAYS * DAY_MS).sort((a, b) => b.created - a.created)[0];
  let issue;
  if (p) {
    const due = Math.round(p.montant * Math.min(p.offres.length, PASS_OFFRES) / PASS_OFFRES);
    const amount = Math.max(0, p.montant - due);
    p.retracte = new Date(at).toISOString(); savePasses();
    let refunded = amount === 0;
    if (amount > 0 && p.pi && STRIPE_KEY) {
      try { await stripe('POST', 'refunds', { payment_intent: p.pi, amount: String(amount), reason: 'requested_by_customer' }, 'retractation-' + p.id); refunded = true; }
      catch (e) { console.log(`${new Date().toISOString()} remboursement erreur=${e.message}`); }
    }
    issue = amount === 0
      ? `Les ${PASS_OFFRES} offres d'emploi du pass ayant été préparées, le montant payé correspond au service fourni : aucun remboursement n'est dû (CGV, article 7). Votre pass est désactivé.`
      : `Remboursement : ${euros(amount)} sur le moyen de paiement utilisé (${p.offres.length} offre(s) préparée(s) sur ${PASS_OFFRES}, CGV article 7). `
        + (refunded ? 'Il a été lancé aujourd’hui ; selon votre banque, il apparaît sous 5 à 10 jours.' : 'Il sera effectué dans les 14 jours au plus tard.') + ' Votre pass est désactivé.';
    console.log(`${new Date().toISOString()} evenement=retractation montant_rembourse=${amount} automatique=${refunded}`);
  } else {
    issue = 'Nous n’avons pas retrouvé automatiquement d’achat de moins de 14 jours avec cette adresse e-mail. Nous examinons votre demande et revenons vers vous par e-mail.';
    console.log(`${new Date().toISOString()} evenement=retractation_a_verifier`);
  }
  const quand = dateHeureFr(at);
  const list = readJson(RETRACT_FILE, []).filter((x) => Date.parse(x.le) > at - 5 * 365 * DAY_MS); // gardées 5 ans
  list.push({ le: new Date(at).toISOString(), nom, email, reference: ref, email_ar: ar, pass: p ? p.id : null, issue });
  writeJson(RETRACT_FILE, list);
  const text = [
    `Bonjour ${nom},`, '',
    `Nous avons bien reçu votre déclaration de rétractation, envoyée le ${quand} (heure de Paris).`, '',
    'Contenu de votre déclaration :',
    `- Nom : ${nom}`, '- Contrat : Pass PrepMyJob 30 jours',
    `- E-mail utilisé pour l'achat : ${email}`, `- Référence indiquée : ${ref || '(aucune)'}`,
    `- E-mail pour cet accusé de réception : ${ar}`, '', issue, '',
    'Cyril CRETIN — PrepMyJob', SMTP_USER,
  ].join('\n');
  let envoye = false;
  try { envoye = await sendMail(ar, 'Accusé de réception de votre rétractation — PrepMyJob', text, SMTP_USER); }
  catch (e) { console.log(`${new Date().toISOString()} email_retractation erreur=${e.message}`); }
  return send(res, 200, { ok: true, le: quand, issue, email_envoye: envoye });
}

const ROUTES = {
  '/api/ai': handleAI, '/api/checkout': handleCheckout, '/api/pass/activate': handleActivate,
  '/api/pass/recover': handleRecover, '/api/pass/status': handleStatus, '/api/retractation': handleRetract,
  '/api/offre-lien': handleLien,
};

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/api/health') return send(res, 200, { ok: true, configured: Boolean(KEY), paiement: Boolean(STRIPE_KEY), email: MAIL_OK, day, globalCount });
  const route = ROUTES[url];
  if (!route) return fail(res, 404, 'Introuvable.');
  if (req.method !== 'POST') return fail(res, 405, 'Méthode non autorisée.');
  if (!originAllowed(req)) return fail(res, 403, 'Origine non autorisée.');

  rollDay();
  let parsed;
  try { parsed = JSON.parse(await readBody(req)); }
  catch (e) { return fail(res, e && e.code === 413 ? 413 : 400, e && e.code === 413 ? 'Fichier trop volumineux.' : 'Requête invalide.'); }
  if (!parsed || typeof parsed !== 'object') return fail(res, 400, 'Requête invalide.');
  try { return await route(req, res, parsed); }
  catch (e) {
    console.log(`${new Date().toISOString()} ${url} erreur=${e && e.message}`);
    return fail(res, 502, url === '/api/ai' ? 'Erreur du moteur IA.' : 'Le paiement est momentanément indisponible. Réessayez dans un instant.');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PrepMyJob relais prêt sur ${HOST}:${PORT} (modèle ${MODEL}, clé ${KEY ? 'présente' : 'ABSENTE'}, paiement ${STRIPE_KEY ? (STRIPE_KEY.startsWith('sk_live') || STRIPE_KEY.startsWith('rk_live') ? 'RÉEL' : 'TEST') : 'fermé'})`);
  // Vérifie la connexion à la boîte e-mail au démarrage (sans rien envoyer) : visible dans /api/health
  if (SMTP_PASS) smtp([...smtpLogin(), ['QUIT', 221]]).then(() => { MAIL_OK = true; console.log('E-mail : connexion SMTP OK'); })
    .catch((e) => console.log(`E-mail : connexion SMTP en échec (${e.message})`));
  else console.log('E-mail : SMTP non configuré (les e-mails sont rangés dans data/outbox)');
});
