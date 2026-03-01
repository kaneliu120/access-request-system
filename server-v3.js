// Enterprise Internal Access Request System v3
// Supports: multi-role + two-level approval + auto user info + time-range query
const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3030;
const JWT_SECRET = process.env.JWT_SECRET || 'access-request-jwt-secret-v3-2026';
const JWT_EXPIRES = '8h';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB Config ───────────────────────────────────────────────
const dbConfig = {
  user: process.env.DB_USER || 'sqladmin',
  password: process.env.DB_PASSWORD || 'AccessRequestDB@2026',
  server: process.env.DB_SERVER || 'sql-access-request-dev.database.windows.net',
  database: process.env.DB_NAME || 'AccessRequestDB',
  options: { encrypt: true, trustServerCertificate: false },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let pool;
async function getPool() {
  if (!pool) { pool = await sql.connect(dbConfig); console.log('✅ DB connected'); }
  return pool;
}
getPool().catch(e => console.error('DB init error:', e.message));

// ─── Auth Middleware ──────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in, please login' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Token expired, please login again' }); }
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

// ─── Health ───────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const p = await getPool().catch(() => null);
  res.json({
    status: 'healthy', version: '3.0',
    timestamp: new Date().toISOString(),
    database: p ? 'connected' : 'disconnected',
    port: PORT,
    features: ['multi-role', 'two-level-approval', 'auto-user-info', 'time-range-query', 'immutable-audit']
  });
});

// ─── Auth ─────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    const p = await getPool();
    const r = await p.request()
      .input('email', sql.NVarChar, email.trim().toLowerCase())
      .query('SELECT * FROM Users WHERE email=@email AND isActive=1');
    const user = r.recordset[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({
      id: user.id, email: user.email, name: user.name,
      role: user.role, department: user.department || '', jobTitle: user.jobTitle || ''
    }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department, jobTitle: user.jobTitle }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me — return full user info (auto-fill, cannot be forged by frontend)
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input('id', sql.Int, req.user.id)
      .query('SELECT id,name,email,role,department,jobTitle,isActive,createdAt FROM Users WHERE id=@id');
    const user = r.recordset[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/register (admin only)
app.post('/api/auth/register', auth, role('admin'), async (req, res) => {
  const { name, email, password, role: userRole, department, jobTitle } = req.body;
  const validRoles = ['requester', 'approver_l1', 'approver_l2', 'admin'];
  if (!name || !email || !password || !userRole) return res.status(400).json({ error: 'All fields are required' });
  if (!validRoles.includes(userRole)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const p = await getPool();
    const ex = await p.request().input('email', sql.NVarChar, email.trim().toLowerCase())
      .query('SELECT id FROM Users WHERE email=@email');
    if (ex.recordset.length) return res.status(409).json({ error: 'Email already exists' });
    const hash = await bcrypt.hash(password, 10);
    const r = await p.request()
      .input('name', sql.NVarChar, name)
      .input('email', sql.NVarChar, email.trim().toLowerCase())
      .input('hash', sql.NVarChar, hash)
      .input('role', sql.NVarChar, userRole)
      .input('dept', sql.NVarChar, department || '')
      .input('title', sql.NVarChar, jobTitle || '')
      .query(`INSERT INTO Users(name,email,password_hash,role,department,jobTitle)
              OUTPUT INSERTED.id,INSERTED.name,INSERTED.email,INSERTED.role,INSERTED.department,INSERTED.jobTitle
              VALUES(@name,@email,@hash,@role,@dept,@title)`);
    res.status(201).json({ message: 'User created successfully', user: r.recordset[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', auth, role('admin'), async (req, res) => {
  const p = await getPool();
  const r = await p.request().query('SELECT id,name,email,role,department,jobTitle,isActive,createdAt FROM Users ORDER BY createdAt DESC');
  res.json({ users: r.recordset });
});

app.put('/api/users/:id', auth, role('admin'), async (req, res) => {
  const { role: userRole, isActive, department, jobTitle } = req.body;
  const p = await getPool();
  await p.request()
    .input('id', sql.Int, req.params.id)
    .input('role', sql.NVarChar, userRole)
    .input('active', sql.Bit, isActive ? 1 : 0)
    .input('dept', sql.NVarChar, department || '')
    .input('title', sql.NVarChar, jobTitle || '')
    .query('UPDATE Users SET role=@role,isActive=@active,department=@dept,jobTitle=@title,updatedAt=GETUTCDATE() WHERE id=@id');
  res.json({ message: 'User updated' });
});

// ─── Requests ────────────────────────────────────────────────
// GET /api/requests — role-isolated + time-range query + pagination
app.get('/api/requests', auth, async (req, res) => {
  try {
    const p = await getPool();
    const { startDate, endDate, status, requestType, department, search, page = 1, limit = 10 } = req.query;
    const userRole = req.user.role;

    // Parse pagination params
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const offset = (pageNum - 1) * limitNum;

    // Role-based base conditions
    let roleWhere = '';
    if (userRole === 'approver_l1') {
      roleWhere = `AND (r.status='pending_l1' OR EXISTS(SELECT 1 FROM ApprovalRecords ar WHERE ar.requestId=r.id AND ar.approverId=${req.user.id}))`;
    } else if (userRole === 'approver_l2') {
      roleWhere = `AND (r.status='pending_l2' OR EXISTS(SELECT 1 FROM ApprovalRecords ar WHERE ar.requestId=r.id AND ar.approverId=${req.user.id}))`;
    } else if (userRole === 'requester') {
      roleWhere = `AND r.requesterId=${req.user.id}`;
    }
    // admin sees all, no extra condition

    const request = p.request();
    let extras = '';

    if (startDate) { request.input('sd', sql.DateTime, new Date(startDate)); extras += ' AND r.createdAt>=@sd'; }
    if (endDate)   { request.input('ed', sql.DateTime, new Date(endDate));   extras += ' AND r.createdAt<=@ed'; }
    if (status)    { request.input('st', sql.NVarChar, status);              extras += ' AND r.status=@st'; }
    if (requestType){ request.input('rt', sql.NVarChar, requestType);        extras += ' AND r.requestType=@rt'; }
    if (department) { request.input('dp', sql.NVarChar, department);         extras += ' AND r.department=@dp'; }
    if (search)    { request.input('sq', sql.NVarChar, `%${search}%`);       extras += ' AND (r.targetResource LIKE @sq OR r.reason LIKE @sq OR u.name LIKE @sq)'; }

    // Get total count
    const countResult = await request.query(`
      SELECT COUNT(*) as total
      FROM AccessRequests r
      LEFT JOIN Users u ON r.requesterId=u.id
      WHERE 1=1 ${roleWhere} ${extras}
    `);
    const total = countResult.recordset[0].total;

    // Get paginated data
    const result = await request.query(`
      SELECT r.*, u.name as uName, u.department as uDept, u.jobTitle as uTitle
      FROM AccessRequests r
      LEFT JOIN Users u ON r.requesterId=u.id
      WHERE 1=1 ${roleWhere} ${extras}
      ORDER BY r.createdAt DESC
      OFFSET ${offset} ROWS FETCH NEXT ${limitNum} ROWS ONLY
    `);
    
    const totalPages = Math.ceil(total / limitNum);
    
    res.json({ 
      requests: result.recordset,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: total,
        pages: totalPages,
        hasPrev: pageNum > 1,
        hasNext: pageNum < totalPages
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/requests/:id
app.get('/api/requests/:id', auth, async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, req.params.id).query(`
      SELECT r.*, u.name as uName, u.department as uDept, u.jobTitle as uTitle
      FROM AccessRequests r LEFT JOIN Users u ON r.requesterId=u.id WHERE r.id=@id
    `);
    if (!r.recordset.length) return res.status(404).json({ error: 'Request not found' });
    const item = r.recordset[0];
    const uRole = req.user.role;
    if (uRole === 'requester' && item.requesterId !== req.user.id)
      return res.status(403).json({ error: 'Insufficient permissions' });
    // Get full approval history (immutable)
    const hist = await p.request().input('rid', sql.Int, req.params.id)
      .query('SELECT * FROM ApprovalRecords WHERE requestId=@rid ORDER BY createdAt ASC');
    res.json({ ...item, approvalHistory: hist.recordset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/requests — create request (user info auto-filled from server)
app.post('/api/requests', auth, async (req, res) => {
  const { requestType, targetResource, reason, durationDays, priority } = req.body;
  if (!requestType || !targetResource || !reason)
    return res.status(400).json({ error: 'Required: requestType, targetResource, reason' });
  try {
    const p = await getPool();
    // Read user info from DB — do not trust frontend-supplied email/name
    const uRes = await p.request().input('id', sql.Int, req.user.id)
      .query('SELECT name,email,department,jobTitle FROM Users WHERE id=@id');
    const u = uRes.recordset[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    const days = parseInt(durationDays) || 30;
    const startDate = new Date();
    const endDate = new Date(Date.now() + days * 86400000);

    const r = await p.request()
      .input('rName', sql.NVarChar, u.name)
      .input('rEmail', sql.NVarChar, u.email)
      .input('dept', sql.NVarChar, u.department || '')
      .input('title', sql.NVarChar, u.jobTitle || '')
      .input('rType', sql.NVarChar, requestType)
      .input('tRes', sql.NVarChar, targetResource)
      .input('reason', sql.NVarChar, reason)
      .input('days', sql.Int, days)
      .input('prio', sql.NVarChar, priority || 'normal')
      .input('sd', sql.DateTime, startDate)
      .input('ed', sql.DateTime, endDate)
      .input('uid', sql.Int, req.user.id)
      .query(`
        INSERT INTO AccessRequests
          (requesterName,requesterEmail,department,jobTitle,requestType,targetResource,reason,durationDays,priority,startDate,endDate,status,requesterId)
        OUTPUT INSERTED.*
        VALUES(@rName,@rEmail,@dept,@title,@rType,@tRes,@reason,@days,@prio,@sd,@ed,'draft',@uid)
      `);
    res.status(201).json({ message: 'Request created successfully', requestId: r.recordset[0].id, request: r.recordset[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/requests/:id/submit
app.post('/api/requests/:id/submit', auth, async (req, res) => {
  try {
    const p = await getPool();
    const c = await p.request().input('id', sql.Int, req.params.id).query('SELECT * FROM AccessRequests WHERE id=@id');
    const item = c.recordset[0];
    if (!item) return res.status(404).json({ error: 'Request not found' });
    if (req.user.role !== 'admin' && item.requesterId !== req.user.id)
      return res.status(403).json({ error: 'Insufficient permissions' });
    if (item.status !== 'draft')
      return res.status(400).json({ error: `Request with status [${item.status}] cannot be submitted` });
    const up = await p.request().input('id', sql.Int, req.params.id)
      .query(`UPDATE AccessRequests SET status='pending_l1',updatedAt=GETUTCDATE() OUTPUT INSERTED.* WHERE id=@id`);
    res.json({ message: 'Submitted, awaiting L1 approval', request: up.recordset[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/requests/:id/approve
app.post('/api/requests/:id/approve', auth, role('approver_l1', 'approver_l2', 'admin'), async (req, res) => {
  const { comment } = req.body;
  try {
    const p = await getPool();
    const c = await p.request().input('id', sql.Int, req.params.id).query('SELECT * FROM AccessRequests WHERE id=@id');
    const item = c.recordset[0];
    if (!item) return res.status(404).json({ error: 'Request not found' });
    const r = req.user.role;
    let level, nextStatus, msg;
    if ((r === 'approver_l1' || r === 'admin') && item.status === 'pending_l1')
      { level = 'L1'; nextStatus = 'pending_l2'; msg = 'L1 approved, awaiting L2 review'; }
    else if ((r === 'approver_l2' || r === 'admin') && item.status === 'pending_l2')
      { level = 'L2'; nextStatus = 'approved'; msg = 'L2 approved, request has been approved'; }
    else return res.status(400).json({ error: `Status [${item.status}] cannot be approved by this role` });

    // Write immutable approval record
    await p.request()
      .input('rid', sql.Int, req.params.id).input('lv', sql.NVarChar, level)
      .input('aid', sql.Int, req.user.id).input('an', sql.NVarChar, req.user.name)
      .input('ae', sql.NVarChar, req.user.email).input('act', sql.NVarChar, 'approve')
      .input('cmt', sql.NVarChar, comment || '')
      .query('INSERT INTO ApprovalRecords(requestId,level,approverId,approverName,approverEmail,action,comment) VALUES(@rid,@lv,@aid,@an,@ae,@act,@cmt)');

    const up = await p.request().input('id', sql.Int, req.params.id)
      .input('st', sql.NVarChar, nextStatus)
      .query(`UPDATE AccessRequests SET status=@st,updatedAt=GETUTCDATE() OUTPUT INSERTED.* WHERE id=@id`);
    res.json({ message: msg, level, request: up.recordset[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/requests/:id/reject
app.post('/api/requests/:id/reject', auth, role('approver_l1', 'approver_l2', 'admin'), async (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'Rejection reason is required' });
  try {
    const p = await getPool();
    const c = await p.request().input('id', sql.Int, req.params.id).query('SELECT * FROM AccessRequests WHERE id=@id');
    const item = c.recordset[0];
    if (!item) return res.status(404).json({ error: 'Request not found' });
    const r = req.user.role;
    let level;
    if ((r === 'approver_l1' || r === 'admin') && item.status === 'pending_l1') level = 'L1';
    else if ((r === 'approver_l2' || r === 'admin') && item.status === 'pending_l2') level = 'L2';
    else return res.status(400).json({ error: `Status [${item.status}] cannot be rejected by this role` });

    await p.request()
      .input('rid', sql.Int, req.params.id).input('lv', sql.NVarChar, level)
      .input('aid', sql.Int, req.user.id).input('an', sql.NVarChar, req.user.name)
      .input('ae', sql.NVarChar, req.user.email).input('act', sql.NVarChar, 'reject')
      .input('cmt', sql.NVarChar, comment)
      .query('INSERT INTO ApprovalRecords(requestId,level,approverId,approverName,approverEmail,action,comment) VALUES(@rid,@lv,@aid,@an,@ae,@act,@cmt)');

    const up = await p.request().input('id', sql.Int, req.params.id)
      .query(`UPDATE AccessRequests SET status='rejected',updatedAt=GETUTCDATE() OUTPUT INSERTED.* WHERE id=@id`);
    res.json({ message: `${level} rejected`, request: up.recordset[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stats — statistics (admin + approver visible)
app.get('/api/stats', auth, role('admin', 'approver_l1', 'approver_l2'), async (req, res) => {
  try {
    const p = await getPool();
    const { startDate, endDate } = req.query;
    const request = p.request();
    let extras = '';
    if (startDate) { request.input('sd', sql.DateTime, new Date(startDate)); extras += ' AND createdAt>=@sd'; }
    if (endDate)   { request.input('ed', sql.DateTime, new Date(endDate));   extras += ' AND createdAt<=@ed'; }

    const ov = await request.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='pending_l1' THEN 1 ELSE 0 END) as pending_l1,
        SUM(CASE WHEN status='pending_l2' THEN 1 ELSE 0 END) as pending_l2,
        SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) as draft
      FROM AccessRequests WHERE 1=1 ${extras}
    `);
    const byType = await p.request().query(`
      SELECT requestType, COUNT(*) as count FROM AccessRequests WHERE 1=1 ${extras} GROUP BY requestType ORDER BY count DESC
    `);
    res.json({ overview: ov.recordset[0], byType: byType.recordset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SPA fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'public', 'index.html'));
  else res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Enterprise Access Request System v3 started`);
  console.log(`📡 Local: http://localhost:${PORT}`);
  console.log(`🏥 Health: http://localhost:${PORT}/api/health`);
  console.log(`\n👥 Roles:`);
  console.log(`   requester     → Requester (create/view own requests)`);
  console.log(`   approver_l1   → L1 Approver (approve pending_l1)`);
  console.log(`   approver_l2   → L2 Approver (approve pending_l2)`);
  console.log(`   admin         → Administrator (all permissions)`);
  console.log(`\n✅ Features: auto user info | time-range query | immutable audit records\n`);
});
