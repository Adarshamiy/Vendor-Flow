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

const page = (t, b, nav = true) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${t}</title>
<style>body{font:15px system-ui;max-width:900px;margin:2rem auto;padding:0 1rem}nav a{margin-right:1rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}input{padding:4px}button{padding:4px 10px}form{margin:4px 0}</style>
${nav ? '<nav><a href=/>Requests</a><a href=/vendors>Vendors</a><a href=/audit>Audit trail</a></nav>' : ''}${b}`;

// Approver link from email: no login needed, token is the credential.
app.get('/a/:tok', (req, res) => {
  const s = db.prepare('select * from steps where token=?').get(req.params.tok);
  if (!s) return res.sendStatus(404);
  const r = reqRow(s.request_id);
  res.send(page('Approval', `<h2>${esc(r.vendor)}: ₹${r.amount}</h2><p>Invoice ${esc(r.invoice_no)}. ${esc(r.description)}</p><p>Your task: ${esc(s.title)} (${s.status})</p>
${s.status === 'pending' ? '<form method=post><input name=note placeholder="Note (optional)"> <button name=d value=approve>Approve</button> <button name=d value=reject>Reject</button></form>' : ''}`, false));
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
  const rows = db.prepare('select r.id,v.name vendor,r.invoice_no,r.amount,r.status from requests r join vendors v on v.id=r.vendor_id order by r.id desc').all()
    .map(r => `<tr><td><a href=/r/${r.id}>#${r.id}</a></td><td>${esc(r.vendor)}</td><td>${esc(r.invoice_no)}</td><td>₹${r.amount}</td><td>${r.status}</td></tr>`).join('');
  res.send(page('VendorFlow', `<h2>Approval requests</h2><table><tr><th>ID<th>Vendor<th>Invoice<th>Amount<th>Status</tr>${rows || '<tr><td colspan=5>No requests yet. Ask Claude to create one.</td></tr>'}</table>`));
});

app.get('/r/:id', (req, res) => {
  const r = reqRow(req.params.id);
  if (!r) return res.sendStatus(404);
  const rows = stepRows(r.id).map(s => `<tr><td>${s.seq}</td><td>${esc(s.title)}</td><td>${esc(s.approver_name)}<br><small>${esc(s.approver_email)}</small></td><td>${s.status}</td><td>${esc(s.note)}</td><td>
${['waiting', 'pending'].includes(s.status) ? `<form method=post action=/r/${r.id}/reassign><input type=hidden name=seq value=${s.seq}><input name=name placeholder=name required size=10><input name=email placeholder=email size=14><button>Reassign</button></form>` : ''}
${s.status === 'pending' ? `<form method=post action=/s/${s.id}><input name=note placeholder=note size=10><button name=d value=approve>Approve</button><button name=d value=reject>Reject</button></form>` : ''}</td></tr>`).join('');
  res.send(page('Request', `<h2>#${r.id} ${esc(r.vendor)}: ${r.status}</h2>
<form method=post action=/r/${r.id}/edit>Invoice <input name=invoice_no value="${esc(r.invoice_no)}" size=10> ₹<input name=amount type=number step=any value=${r.amount}> <input name=description value="${esc(r.description)}" size=30> <button>Save changes</button></form>
<table><tr><th>#<th>Task<th>Assignee<th>Status<th>Note<th></tr>${rows}</table>`));
});
app.post('/r/:id/edit', (req, res) => {
  const b = req.body;
  db.prepare("update requests set invoice_no=?,amount=?,description=? where id=? and status='pending'").run(b.invoice_no, +b.amount, b.description, req.params.id);
  log('admin', 'request_edited', `#${req.params.id} ₹${b.amount}`);
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
    const d = db.prepare('select id,filename from docs where vendor_id=?').all(v.id).map(x => `<a href=/doc/${x.id}>${esc(x.filename)}</a>`).join(', ');
    return `<tr><td>${esc(v.name)}</td><td>${esc(v.email)}</td><td>${esc(v.gst)}</td><td>${esc(v.pan)}</td><td>${d}<form method=post action=/vendors/${v.id}/doc enctype=multipart/form-data><input type=file name=f required><button>Upload document</button></form></td></tr>`;
  }).join('');
  res.send(page('Vendors', `<h2>Vendors</h2><table><tr><th>Name<th>Email<th>GST<th>PAN<th>Documents</tr>${rows || '<tr><td colspan=5>No vendors yet. Ask Claude to register one.</td></tr>'}</table>`));
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
  const rows = db.prepare('select * from audit order by id desc limit 200').all().map(a => `<tr><td>${a.at}</td><td>${esc(a.actor)}</td><td>${a.action}</td><td>${esc(a.detail)}</td></tr>`).join('');
  res.send(page('Audit trail', `<h2>Audit trail</h2><p><a href=/audit.csv>Download CSV</a></p><table><tr><th>When<th>Who<th>Action<th>Detail</tr>${rows}</table>`));
});
app.get('/audit.csv', (req, res) => {
  const q = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  res.type('text/csv').send('at,actor,action,detail\n' + db.prepare('select * from audit order by id').all().map(a => [a.at, a.actor, a.action, a.detail].map(q).join(',')).join('\n'));
});

app.listen(process.env.PORT || 3000, () => console.log('VendorFlow on', BASE));
