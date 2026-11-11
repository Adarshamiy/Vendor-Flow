import express from 'express';
import Database from 'better-sqlite3';
import multer from 'multer';
import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MCP_TOKEN = process.env.MCP_TOKEN || 'dev-token';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

const db = new Database(process.env.DB_PATH || 'vendorflow.db');
db.exec(`
create table if not exists vendors(id integer primary key, name text unique, email text, gst text, pan text, status text default 'active');
create table if not exists docs(id integer primary key, vendor_id int, filename text, mime text, data blob);
create table if not exists requests(id integer primary key, vendor_id int, invoice_no text, amount real, description text, status text default 'pending', created text);
create table if not exists steps(id integer primary key, request_id int, seq int, title text, approver_name text, approver_email text, status text default 'waiting', note text, token text, decided text);
create table if not exists audit(id integer primary key, at text, actor text, action text, detail text);`);

const now = () => new Date().toISOString();
const log = (actor, action, detail) => db.prepare('insert into audit(at,actor,action,detail) values(?,?,?,?)').run(now(), actor, action, detail);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Email via Resend's plain HTTP API (no AI). Without a key it just logs.
async function mail(to, subject, text) {
  if (!to) return;
  if (!process.env.RESEND_API_KEY) return console.log('[mail]', to, subject, text);
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'VendorFlow <onboarding@resend.dev>', to, subject, text })
    });
  } catch (e) { console.error(e); }
}

const vendorByName = n => db.prepare('select * from vendors where lower(name)=lower(?)').get(n);
const reqRow = id => db.prepare('select r.*,v.name vendor from requests r join vendors v on v.id=r.vendor_id where r.id=?').get(id);
const stepRows = id => db.prepare('select * from steps where request_id=? order by seq').all(id);
const view = id => ({
  request: reqRow(id),
  steps: stepRows(id).map(({ seq, title, approver_name, approver_email, status, note, decided }) => ({ seq, title, approver_name, approver_email, status, note, decided }))
});

// Wake the next waiting step, or mark the request approved when none remain.
function activate(rid) {
  const s = db.prepare("select * from steps where request_id=? and status='waiting' order by seq limit 1").get(rid);
  if (!s) { db.prepare("update requests set status='approved' where id=?").run(rid); return log('system', 'request_approved', '#' + rid); }
  db.prepare("update steps set status='pending' where id=?").run(s.id);
  const r = reqRow(rid);
  mail(s.approver_email, `Approval needed: ${r.vendor} ₹${r.amount}`, `${s.title}: ${r.vendor}, invoice ${r.invoice_no}, ₹${r.amount}.\nReview: ${BASE}/a/${s.token}`);
  log('system', 'step_assigned', `#${rid} step ${s.seq} -> ${s.approver_name}`);
}

function createRequest({ vendor, invoice_no, amount, description, approvers }) {
  const v = vendorByName(vendor);
  if (!v) throw new Error('Unknown vendor. Register the vendor first.');
  const id = db.prepare('insert into requests(vendor_id,invoice_no,amount,description,created) values(?,?,?,?,?)')
    .run(v.id, invoice_no || '', amount, description || '', now()).lastInsertRowid;
  approvers.forEach((a, i) => db.prepare('insert into steps(request_id,seq,title,approver_name,approver_email,token) values(?,?,?,?,?,?)')
    .run(id, i + 1, a.title || 'Approval', a.name, a.email || '', crypto.randomBytes(12).toString('hex')));
  log('claude', 'request_created', `#${id} ${v.name} ₹${amount}`);
  activate(id);
  return Number(id);
}

function decide(stepId, approve, note, actor) {
  const s = db.prepare('select * from steps where id=?').get(stepId);
  if (!s || s.status !== 'pending') throw new Error('Step is not pending');
  db.prepare('update steps set status=?,note=?,decided=? where id=?').run(approve ? 'approved' : 'rejected', note || '', now(), stepId);
  log(actor, approve ? 'step_approved' : 'step_rejected', `#${s.request_id} step ${s.seq}${note ? ': ' + note : ''}`);
  if (approve) activate(s.request_id);
  else db.prepare("update requests set status='rejected' where id=?").run(s.request_id);
}

function reassign(rid, seq, name, email, actor = 'claude') {
  const s = db.prepare("select * from steps where request_id=? and seq=? and status in ('waiting','pending')").get(rid, seq);
  if (!s) throw new Error('No open step with that number');
  db.prepare('update steps set approver_name=?,approver_email=? where id=?').run(name, email || '', s.id);
  log(actor, 'step_reassigned', `#${rid} step ${seq} -> ${name}`);
  if (s.status === 'pending') mail(email, 'Approval assigned to you', `${BASE}/a/${s.token}`);
}

// ---- MCP tools (this is how Claude drives the app) ----
const txt = o => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
function buildMcp() {
  const s = new McpServer({ name: 'vendorflow', version: '1.0.0' });
  s.tool('register_vendor', 'Register a vendor or update its details', { name: z.string(), email: z.string().optional(), gst: z.string().optional(), pan: z.string().optional() }, async a => {
    db.prepare('insert into vendors(name,email,gst,pan) values(@name,@email,@gst,@pan) on conflict(name) do update set email=coalesce(@email,email),gst=coalesce(@gst,gst),pan=coalesce(@pan,pan)')
      .run({ name: a.name, email: a.email ?? null, gst: a.gst ?? null, pan: a.pan ?? null });
    log('claude', 'vendor_registered', a.name);
    return txt({ ok: true, vendor: vendorByName(a.name), upload_documents_at: BASE + '/vendors' });
  });
  s.tool('list_vendors', 'List all vendors', {}, async () => txt(db.prepare('select id,name,email,gst,pan,status from vendors').all()));
  s.tool('create_approval_request', 'Create an invoice approval request with an ordered chain of approvers. Each approver becomes a task assigned in order; the next one is notified when the previous approves.', {
    vendor: z.string(), invoice_no: z.string().optional(), amount: z.number(), description: z.string().optional(),
    approvers: z.array(z.object({ name: z.string(), email: z.string().optional(), title: z.string().optional() })).min(1)
  }, async a => { const id = createRequest(a); return txt({ link: `${BASE}/r/${id}`, ...view(id) }); });
  s.tool('list_approvals', 'List approval requests, optionally filtered by status (pending, approved, rejected)', { status: z.string().optional() }, async a =>
    txt(db.prepare(`select r.id,v.name vendor,r.invoice_no,r.amount,r.status from requests r join vendors v on v.id=r.vendor_id ${a.status ? 'where r.status=?' : ''} order by r.id desc`).all(...(a.status ? [a.status] : []))));
  s.tool('get_approval', 'Get one approval request with its steps', { id: z.number() }, async a => txt(view(a.id)));
  s.tool('reassign_step', 'Reassign an open approval step to another person', { request_id: z.number(), seq: z.number(), name: z.string(), email: z.string().optional() }, async a => {
    reassign(a.request_id, a.seq, a.name, a.email); return txt(view(a.request_id));
  });
  return s;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5e6 } });

// Stateless MCP endpoint. The secret token in the URL identifies the connection.
app.post('/mcp/:token', async (req, res) => {
  if (req.params.token !== MCP_TOKEN) return res.status(401).json({ error: 'bad token' });
  const server = buildMcp();
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { t.close(); server.close(); });
  await server.connect(t);
  await t.handleRequest(req, res, req.body);
});
app.all('/mcp/:token', (req, res) => res.status(405).set('Allow', 'POST').end());
// The MCP endpoint uses a URL token, not OAuth. Answer OAuth discovery with 404 (not the basic-auth 401),
// otherwise Claude assumes OAuth is required and fails to connect.
app.all('/.well-known/*', (req, res) => res.sendStatus(404));

// ================= UI (server-rendered, no client framework) =================
const CSS = `
:root{--bg:#f5f6fa;--card:#fff;--ink:#101828;--muted:#667085;--line:#e4e7ec;--brand:#4f46e5;--brand-ink:#fff;--brand-soft:#eef2ff;
--ok:#067647;--ok-bg:#dcfae6;--warn:#b54708;--warn-bg:#fef0c7;--bad:#b42318;--bad-bg:#fee4e2;--wait:#475467;--wait-bg:#f2f4f7;--side:#0f172a}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#141a2e;--ink:#f2f4f7;--muted:#98a2b3;--line:#232b45;--brand:#818cf8;--brand-ink:#0b1020;--brand-soft:#1d2250;
--ok:#6ce9a6;--ok-bg:#053321;--warn:#fec84b;--warn-bg:#3b2a05;--bad:#fda29b;--bad-bg:#3d1311;--wait:#cbd5e1;--wait-bg:#1f2740;--side:#070b18}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
.shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
aside{background:var(--side);color:#cbd5e1;padding:20px 14px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;color:#fff;font-weight:700;font-size:17px;padding:4px 10px 22px}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#6366f1,#22d3ee);display:grid;place-items:center;color:#fff;font-size:15px}
aside nav a{display:flex;align-items:center;gap:10px;color:#cbd5e1;padding:9px 12px;border-radius:9px;margin-bottom:3px;font-weight:500}
aside nav a:hover{background:#1e293b;text-decoration:none;color:#fff}
aside nav a.on{background:#312e81;color:#fff}
aside .foot{position:absolute;bottom:18px;left:24px;font-size:12px;color:#64748b}
main{padding:28px 36px 60px;max-width:1120px;width:100%;min-width:0}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}
h1{font-size:24px;margin:0;letter-spacing:-.01em}.sub{color:var(--muted);margin-top:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px}
.stat .l{color:var(--muted);font-size:12.5px;font-weight:500}.stat .n{font-size:26px;font-weight:700;margin-top:2px}.stat .s{color:var(--muted);font-size:12.5px}
.tablewrap{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:auto}
table{border-collapse:collapse;width:100%}
th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);text-align:left;padding:12px 16px;background:color-mix(in srgb,var(--card) 90%,var(--line));border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:14px 16px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:0}tbody tr:hover td{background:color-mix(in srgb,var(--card) 94%,var(--brand))}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;text-transform:capitalize;white-space:nowrap}
.badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.b-pending{background:var(--warn-bg);color:var(--warn)}.b-approved,.b-active{background:var(--ok-bg);color:var(--ok)}
.b-rejected{background:var(--bad-bg);color:var(--bad)}.b-waiting{background:var(--wait-bg);color:var(--wait)}
.chip{display:inline-block;white-space:nowrap;padding:2px 9px;border-radius:8px;font-size:12px;background:var(--wait-bg);color:var(--wait)}
.chip.warn{background:var(--warn-bg);color:var(--warn)}
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 14px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer}
.btn:hover{background:var(--wait-bg);text-decoration:none}
.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}.btn.primary:hover{filter:brightness(1.08)}
.btn.ok{background:var(--ok);border-color:var(--ok);color:#fff}.btn.bad{background:var(--card);border-color:var(--bad);color:var(--bad)}
.btn.sm{padding:5px 10px;font-size:13px}
input,textarea{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 10px;min-width:0}
input:focus,textarea:focus{outline:2px solid var(--brand);outline-offset:-1px}
input[type=file]{border:0;padding:0;background:transparent;max-width:190px;font-size:12.5px}
input[type=file]::file-selector-button{font:inherit;font-weight:600;font-size:12.5px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:5px 10px;margin-right:8px;cursor:pointer}
label.f{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:4px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.grid .wide{grid-column:1/-1}.grid input{width:100%}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.muted{color:var(--muted)}.small{font-size:12.5px}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.back{display:inline-block;margin-bottom:10px;color:var(--muted);font-weight:500}
.empty{text-align:center;padding:44px 16px;color:var(--muted)}.empty b{display:block;color:var(--ink);font-size:16px;margin-bottom:4px}
.tl{list-style:none;margin:0;padding:0}
.tl li{display:grid;grid-template-columns:36px 1fr;gap:14px;position:relative;padding-bottom:22px}
.tl li:last-child{padding-bottom:0}
.tl li:not(:last-child):before{content:"";position:absolute;left:17px;top:36px;bottom:0;width:2px;background:var(--line)}
.dot{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:14px;border:2px solid var(--line);background:var(--card);color:var(--muted);z-index:1}
.dot.approved{background:var(--ok-bg);border-color:var(--ok);color:var(--ok)}.dot.rejected{background:var(--bad-bg);border-color:var(--bad);color:var(--bad)}
.dot.pending{background:var(--warn-bg);border-color:var(--warn);color:var(--warn)}
.step-h{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.step-h b{font-size:15px}
.note{margin-top:6px;background:var(--wait-bg);border-radius:9px;padding:8px 10px}
.acts{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}.acts form{display:flex;gap:6px;flex-wrap:wrap}
.two{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;align-items:start}
@media (max-width:900px){.two{grid-template-columns:1fr}}
.feed td:first-child{white-space:nowrap}
.act{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;padding:2px 8px;border-radius:7px;background:var(--brand-soft);color:var(--brand);white-space:nowrap}
.avatar{width:34px;height:34px;border-radius:50%;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font-weight:700;flex:none}
.vname{display:flex;gap:12px;align-items:center}
.center{max-width:560px;margin:7vh auto;padding:0 16px}
.amount-big{font-size:34px;font-weight:800;letter-spacing:-.02em}
details summary{cursor:pointer;color:var(--brand);font-weight:600}
@media (max-width:760px){.shell{grid-template-columns:1fr}aside{position:static;height:auto;display:flex;align-items:center;gap:8px;overflow-x:auto;padding:10px}
aside .brand{padding:0 8px 0 4px}aside nav{display:flex}aside .foot{display:none}main{padding:18px 14px 50px}}
`;

const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const badge = s => `<span class="badge b-${esc(s)}">${esc(s)}</span>`;
const initials = n => esc(String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase());
const NAV = [['/', 'Requests', '☰'], ['/vendors', 'Vendors', '▣'], ['/audit', 'Audit trail', '☰']];
const ICON = { '/': '\u{1F4C4}', '/vendors': '\u{1F3E2}', '/audit': '\u{1F551}' };

const page = (t, b, o = {}) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t)} · VendorFlow</title><style>${CSS}</style>
${o.nav === false ? `<div class="center">${b}</div>` : `<div class="shell"><aside><div class="brand"><span class="logo">✓</span>VendorFlow</div>
<nav>${NAV.map(([h, l]) => `<a href="${h}" class="${o.active === h ? 'on' : ''}"><span>${ICON[h]}</span>${l}</a>`).join('')}</nav><div class="foot">Invoice approvals, driven by Claude</div></aside>
<main>${b}</main></div>`}</html>`;

const empty = (title, text) => `<div class="empty"><b>${title}</b>${text}</div>`;

// Approver link from email: no login needed, token is the credential.
app.get('/a/:tok', (req, res) => {
  const s = db.prepare('select * from steps where token=?').get(req.params.tok);
  if (!s) return res.sendStatus(404);
  const r = reqRow(s.request_id);
  res.send(page('Approval', `<div class="card">
<div class="brand" style="color:var(--ink);padding:0 0 14px"><span class="logo">✓</span>VendorFlow</div>
<div class="muted small">Invoice approval for ${esc(s.approver_name)}</div>
<div class="amount-big">${money(r.amount)}</div>
<h2 style="margin:2px 0 10px">${esc(r.vendor)}</h2>
<div class="row" style="margin-bottom:12px"><span class="chip mono">${esc(r.invoice_no || 'No invoice no.')}</span><span class="chip">${esc(s.title)}</span>${badge(s.status)}</div>
${r.description ? `<p class="muted">${esc(r.description)}</p>` : ''}
${s.status === 'pending'
      ? `<form method="post"><label class="f">Note (optional)</label><textarea name="note" rows="2" style="width:100%" placeholder="Add a comment for the audit trail"></textarea>
<div class="row" style="margin-top:12px"><button class="btn ok" name="d" value="approve">Approve</button><button class="btn bad" name="d" value="reject">Reject</button></div></form>`
      : `<p class="muted">This step is ${esc(s.status)}${s.decided ? ' on ' + when(s.decided) : ''}. Nothing more to do.</p>`}</div>`, { nav: false }));
});
app.post('/a/:tok', (req, res) => {
  const s = db.prepare('select * from steps where token=?').get(req.params.tok);
  if (!s) return res.sendStatus(404);
  try { decide(s.id, req.body.d === 'approve', req.body.note, s.approver_name); } catch (e) { /* already decided */ }
  res.redirect('/a/' + req.params.tok);
});

// Everything below needs the admin login (HTTP basic auth).
app.use((req, res, next) => {
  const c = Buffer.from((req.headers.authorization || '').slice(6), 'base64').toString();
  const i = c.indexOf(':');
  if (c.slice(0, i) === ADMIN_USER && c.slice(i + 1) === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="VendorFlow"').sendStatus(401);
});

app.get('/', (req, res) => {
  const all = db.prepare('select r.id,v.name vendor,r.invoice_no,r.amount,r.status,r.created from requests r join vendors v on v.id=r.vendor_id order by r.id desc').all();
  const by = s => all.filter(r => r.status === s);
  const sum = a => a.reduce((t, r) => t + r.amount, 0);
  const stat = (l, a, s) => `<div class="card stat"><div class="l">${l}</div><div class="n">${a.length}</div><div class="s">${s}</div></div>`;
  const rows = all.map(r => `<tr><td><a href="/r/${r.id}"><b>#${r.id}</b></a></td><td><b>${esc(r.vendor)}</b></td><td class="mono">${esc(r.invoice_no) || '—'}</td><td class="num"><b>${money(r.amount)}</b></td><td>${badge(r.status)}</td><td class="muted">${when(r.created)}</td><td class="num"><a href="/r/${r.id}">View</a></td></tr>`).join('');
  res.send(page('Requests', `<div class="head"><div><h1>Approval requests</h1><div class="sub">Every invoice moves through its approver chain in order.</div></div></div>
<div class="stats">${stat('Awaiting approval', by('pending'), money(sum(by('pending'))) + ' pending')}${stat('Approved', by('approved'), money(sum(by('approved'))) + ' cleared')}${stat('Rejected', by('rejected'), money(sum(by('rejected'))) + ' declined')}${stat('Total requests', all, 'all time')}</div>
<div class="tablewrap"><table><thead><tr><th>ID<th>Vendor<th>Invoice<th class="num">Amount<th>Status<th>Created<th></tr></thead><tbody>${rows || `<tr><td colspan="7">${empty('No requests yet', 'Ask Claude: “Create an invoice approval request for ABC Technologies, ₹80,000.”')}</td></tr>`}</tbody></table></div>`, { active: '/' }));
});

app.get('/r/:id', (req, res) => {
  const r = reqRow(req.params.id);
  if (!r) return res.sendStatus(404);
  const steps = stepRows(r.id);
  const items = steps.map(s => {
    const mark = s.status === 'approved' ? '✓' : s.status === 'rejected' ? '✕' : s.seq;
    const open = ['waiting', 'pending'].includes(s.status);
    return `<li><div class="dot ${esc(s.status)}">${mark}</div><div>
<div class="step-h"><b>${esc(s.approver_name)}</b><span class="muted">${esc(s.title)}</span>${badge(s.status)}</div>
<div class="muted small">${esc(s.approver_email) || 'No email'}${s.decided ? ' · ' + when(s.decided) : ''}</div>
${s.note ? `<div class="note">“${esc(s.note)}”</div>` : ''}
<div class="acts">${s.status === 'pending' ? `<form method="post" action="/s/${s.id}"><input name="note" placeholder="Note (optional)" size="18"><button class="btn ok sm" name="d" value="approve">Approve</button><button class="btn bad sm" name="d" value="reject">Reject</button></form>` : ''}
${open ? `<details><summary class="small">Reassign</summary><form method="post" action="/r/${r.id}/reassign" style="margin-top:8px"><input type="hidden" name="seq" value="${s.seq}"><input name="name" placeholder="Name" required size="12"><input name="email" placeholder="Email" size="18"><button class="btn sm">Reassign</button></form></details>` : ''}</div></div></li>`;
  }).join('');
  const editable = r.status === 'pending';
  res.send(page('Request #' + r.id, `<a class="back" href="/">← All requests</a>
<div class="head"><div><div class="row"><h1>#${r.id} · ${esc(r.vendor)}</h1>${badge(r.status)}</div><div class="sub">Created ${when(r.created)}</div></div><div class="amount-big">${money(r.amount)}</div></div>
<div class="two"><div class="card"><h3 style="margin:0 0 16px">Approval chain</h3><ol class="tl">${items}</ol></div>
<div class="card"><h3 style="margin:0 0 14px">Invoice details</h3>
<form method="post" action="/r/${r.id}/edit"><div class="grid">
<div><label class="f">Invoice no.</label><input name="invoice_no" value="${esc(r.invoice_no)}" ${editable ? '' : 'disabled'}></div>
<div><label class="f">Amount (₹)</label><input name="amount" type="number" step="any" value="${r.amount}" ${editable ? '' : 'disabled'}></div>
<div class="wide"><label class="f">Description</label><input name="description" value="${esc(r.description)}" ${editable ? '' : 'disabled'}></div></div>
${editable ? '<div style="margin-top:14px"><button class="btn primary">Save changes</button></div>' : '<p class="muted small" style="margin-bottom:0">Details are locked once a request is decided.</p>'}</form></div></div>`, { active: '/' }));
});
app.post('/r/:id/edit', (req, res) => {
  const b = req.body;
  db.prepare("update requests set invoice_no=?,amount=?,description=? where id=? and status='pending'").run(b.invoice_no, +b.amount, b.description, req.params.id);
  log('admin', 'request_edited', `#${req.params.id} ${money(b.amount)}`);
  res.redirect('/r/' + req.params.id);
});
app.post('/r/:id/reassign', (req, res) => {
  try { reassign(+req.params.id, +req.body.seq, req.body.name, req.body.email, 'admin'); } catch (e) { /* step closed */ }
  res.redirect('/r/' + req.params.id);
});
app.post('/s/:sid', (req, res) => {
  const s = db.prepare('select request_id from steps where id=?').get(req.params.sid);
  if (!s) return res.sendStatus(404);
  try { decide(+req.params.sid, req.body.d === 'approve', req.body.note, 'admin'); } catch (e) { /* not pending */ }
  res.redirect('/r/' + s.request_id);
});

app.get('/vendors', (req, res) => {
  const rows = db.prepare('select * from vendors').all().map(v => {
    const d = db.prepare('select id,filename from docs where vendor_id=?').all(v.id).map(x => `<div><a href="/doc/${x.id}">\u{1F4CE} ${esc(x.filename)}</a></div>`).join('');
    return `<tr><td><div class="vname"><div class="avatar">${initials(v.name)}</div><div><b>${esc(v.name)}</b><div class="muted small">${esc(v.email) || 'No email'}</div></div></div></td>
<td class="mono">${v.gst ? esc(v.gst) : '<span class="chip warn">GST missing</span>'}</td><td class="mono">${v.pan ? esc(v.pan) : '<span class="chip warn">PAN missing</span>'}</td><td>${badge(v.status)}</td>
<td>${d || '<span class="muted small">No documents</span>'}<form method="post" action="/vendors/${v.id}/doc" enctype="multipart/form-data" class="row" style="margin-top:8px;flex-wrap:nowrap"><input type="file" name="f" required><button class="btn sm">Upload</button></form></td></tr>`;
  }).join('');
  res.send(page('Vendors', `<div class="head"><div><h1>Vendors</h1><div class="sub">Onboarded suppliers, tax details and compliance documents.</div></div></div>
<div class="tablewrap"><table><thead><tr><th>Vendor<th>GST<th>PAN<th>Status<th>Documents</tr></thead><tbody>${rows || `<tr><td colspan="5">${empty('No vendors yet', 'Ask Claude to register one, with its GST and PAN.')}</td></tr>`}</tbody></table></div>`, { active: '/vendors' }));
});
app.post('/vendors/:id/doc', up.single('f'), (req, res) => {
  const f = req.file;
  if (f) { db.prepare('insert into docs(vendor_id,filename,mime,data) values(?,?,?,?)').run(req.params.id, f.originalname, f.mimetype, f.buffer); log('admin', 'doc_uploaded', `${f.originalname} vendor#${req.params.id}`); }
  res.redirect('/vendors');
});
app.get('/doc/:id', (req, res) => {
  const d = db.prepare('select * from docs where id=?').get(req.params.id);
  if (!d) return res.sendStatus(404);
  res.set({ 'Content-Type': d.mime, 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(d.filename) + '"' }).send(d.data);
});

app.get('/audit', (req, res) => {
  const rows = db.prepare('select * from audit order by id desc limit 200').all().map(a => `<tr><td class="muted">${when(a.at)}</td><td><b>${esc(a.actor)}</b></td><td><span class="act">${esc(a.action)}</span></td><td>${esc(a.detail)}</td></tr>`).join('');
  res.send(page('Audit trail', `<div class="head"><div><h1>Audit trail</h1><div class="sub">Every action, by Claude, approvers and admins.</div></div><a class="btn" href="/audit.csv">Download CSV</a></div>
<div class="tablewrap feed"><table><thead><tr><th>When<th>Who<th>Action<th>Detail</tr></thead><tbody>${rows || `<tr><td colspan="4">${empty('Nothing logged yet', 'Actions will appear here.')}</td></tr>`}</tbody></table></div>`, { active: '/audit' }));
});
app.get('/audit.csv', (req, res) => {
  const q = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  res.type('text/csv').send('at,actor,action,detail\n' + db.prepare('select * from audit order by id').all().map(a => [a.at, a.actor, a.action, a.detail].map(q).join(',')).join('\n'));
});

app.listen(process.env.PORT || 3000, () => console.log('VendorFlow on', BASE));
