// 企业内部存取权限申请系统 v3 - 完整功能版
// 支持: 2-3角色 + 双阶审核 + 自动用户信息 + 时间查询
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
  if (!token) return res.status(401).json({ error: '未登录，请先登录' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Token 已过期，请重新登录' }); }
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: '无权限执行此操作' });
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
  if (!email || !password) return res.status(400).json({ error: '请输入邮箱和密码' });
  try {
    const p = await getPool();
    const r = await p.request()
      .input('email', sql.NVarChar, email.trim().toLowerCase())
      .query('SELECT * FROM Users WHERE email=@email AND isActive=1');
    const user = r.recordset[0];
    if (!user) return res.status(401).json({ error: '邮箱或密码错误' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: '邮箱或密码错误' });
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

// GET /api/auth/me — 返回完整用户信息（自动带入，不可前端伪造）
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input('id', sql.Int, req.user.id)
      .query('SELECT id,name,email,role,department,jobTitle,isActive,createdAt FROM Users WHERE id=@id');
    const user = r.recordset[0];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/register (admin only)
app.post('/api/auth/register', auth, role('admin'), async (req, res) => {
  const { name, email, password, role: userRole, department, jobTitle } = req.body;
  const validRoles = ['requester', 'approver_l1', 'approver_l2', 'admin'];
  if (!name || !email || !password || !userRole) return res.status(400).json({ error: '所有字段必填' });
  if (!validRoles.includes(userRole)) return res.status(400).json({ error: '无效的角色' });
  try {
    const p = await getPool();
    const ex = await p.request().input('email', sql.NVarChar, email.trim().toLowerCase())
      .query('SELECT id FROM Users WHERE email=@email');
    if (ex.recordset.length) return res.status(409).json({ error: '邮箱已存在' });
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
    res.status(201).json({ message: '用户创建成功', user: r.recordset[0] });
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
  res.json({ message: '用户已更新' });
});

// ─── Requests ────────────────────────────────────────────────
// GET /api/requests — 角色隔离 + 时间范围查询 + 分页支持
app.get('/api/requests', auth, async (req, res) => {
  try {
    const p = await getPool();
    const { startDate, endDate, status, requestType, department, search, page = 1, limit = 10 } = req.query;
    const userRole = req.user.role;

    // 解析分页参数
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const offset = (pageNum - 1) * limitNum;

    // 角色隔离基础条件
    let roleWhere = '';
    if (userRole === 'approver_l1') {
      roleWhere = `AND (r.status='pending_l1' OR EXISTS(SELECT 1 FROM ApprovalRecords ar WHERE ar.requestId=r.id AND ar.approverId=${req.user.id}))`;
    } else if (userRole === 'approver_l2') {
      roleWhere = `AND (r.status='pending_l2' OR EXISTS(SELECT 1 FROM ApprovalRecords ar WHERE ar.requestId=r.id AND ar.approverId=${req.user.id}))`;
    } else if (userRole === 'requester') {
      roleWhere = `AND r.requesterId=${req.user.id}`;
    }
    // admin 看全部，无额外条件

    const request = p.request();
    let extras = '';

    if (startDate) { request.input('sd', sql.DateTime, new Date(startDate)); extras += ' AND r.createdAt>=@sd'; }
    if (endDate)   { request.input('ed', sql.DateTime, new Date(endDate));   extras += ' AND r.createdAt<=@ed'; }
    if (status)    { request.input('st', sql.NVarChar, status);              extras += ' AND r.status=@st'; }
    if (requestType){ request.input('rt', sql.NVarChar, requestType);        extras += ' AND r.requestType=@rt'; }
    if (department) { request.input('dp', sql.NVarChar, department);         extras += ' AND r.department=@dp'; }
    if (search)    { request.input('sq', sql.NVarChar, `%${search}%`);       extras += ' AND (r.targetResource LIKE @sq OR r.reason LIKE @sq OR u.name LIKE @sq)'; }

    // 获取总数
    const countResult = await request.query(`
      SELECT COUNT(*) as total
      FROM AccessRequests r
      LEFT JOIN Users u ON r.requesterId=u.id
      WHERE 1=1 ${roleWhere} ${extras}
    `);
    const total = countResult.recordset[0].total;

    // 获取分页数据
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
    if (!r.recordset.length) return res.status(404).json({ error: '申请不存在' });
    const item = r.recordset[0];
    const uRole = req.user.role;
    if (uRole === 'requester' && item.requesterId !== req.user.id)
      return res.status(403).json({ error: '无权限查看此申请' });
    // 获取完整审核历史（不可删除/覆盖）
    const hist = await p.request().input('rid', sql.Int, req.params.id)
      .query('SELECT * FROM ApprovalRecords WHERE requestId=@rid ORDER BY createdAt ASC');
    res.json({ ...item, approvalHistory: hist.recordset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/requests — 创建申请（从服务端自动带入用户信息）
app.post('/api/requests', auth, async (req, res) => {
  const { requestType, targetResource, reason, durationDays, priority } = req.body;
  if (!requestType || !targetResource || !reason)
    return res.status(400).json({ error: '请填写: requestType、targetResource、reason' });
  try {
    const p = await getPool();
    // 从数据库读取用户信息 — 不信任前端传入的 email/name
    const uRes = await p.request().input('id', sql.Int, req.user.id)
      .query('SELECT name,email,department,jobTitle FROM Users WHERE id=@id');
    const u = uRes.recordset[0];
    if (!u) return res.status(404).json({ error: '用户不存在' });

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
    res.status(201).json({ message: '申请创建成功', requestId: r.recordset[0].id, request: r.recordset[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/requests/:id/submit
app.post('/api/requests/:id/submit', auth, async (req, res) => {
  try {
    const p = await getPool();
    const c = await p.request().input('id', sql.Int, req.params.id).query('SELECT * FROM AccessRequests WHERE id=@id');
    const item = c.recordset[0];
    if (!item) return res.status(404).json({ error: '申请不存在' });
    if (req.user.role !== 'admin' && item.requesterId !== req.user.id)
      return res.status(403).json({ error: '无权限提交此申请' });
    if (item.status !== 'draft')
      return res.status(400).json({ error: `当前状态 [${item.status}] 不可提交` });
    const up = await p.request().input('id', sql.Int, req.params.id)
      .query(`UPDATE AccessRequests SET status='pending_l1',updatedAt=GETUTCDATE() OUTPUT INSERTED.* WHERE id=@id`);
    res.json({ message: '已提交，等待 L1 审批', request: up.recordset[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/requests/:id/approve
app.post('/api/requests/:id/approve', auth, role('approver_l1', 'approver_l2', 'admin'), async (req, res) => {
  const { comment } = req.body;
  try {
    const p = await getPool();
    const c = await p.request().input('id', sql.Int, req.params.id).query('SELECT * FROM AccessRequests WHERE id=@id');
    const item = c.recordset[0];
    if (!item) return res.status(404).json({ error: '申请不存在' });
    const r = req.user.role;
    let level, nextStatus, msg;
    if ((r === 'approver_l1' || r === 'admin') && item.status === 'pending_l1')
      { level = 'L1'; nextStatus = 'pending_l2'; msg = 'L1 通过，等待 L2 审批'; }
    else if ((r === 'approver_l2' || r === 'admin') && item.status === 'pending_l2')
      { level = 'L2'; nextStatus = 'approved'; msg = 'L2 通过，申请已批准'; }
    else return res.status(400).json({ error: `状态 [${item.status}] 不允许此角色审批` });

    // 写入不可覆盖的审核记录
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
  if (!comment) return res.status(400).json({ error: '拒绝时必须填写原因' });
  try {
    const p = await getPool();
    const c = await p.request().input('id', sql.Int, req.params.id).query('SELECT * FROM AccessRequests WHERE id=@id');
    const item = c.recordset[0];
    if (!item) return res.status(404).json({ error: '申请不存在' });
    const r = req.user.role;
    let level;
    if ((r === 'approver_l1' || r === 'admin') && item.status === 'pending_l1') level = 'L1';
    else if ((r === 'approver_l2' || r === 'admin') && item.status === 'pending_l2') level = 'L2';
    else return res.status(400).json({ error: `状态 [${item.status}] 不允许此角色操作` });

    await p.request()
      .input('rid', sql.Int, req.params.id).input('lv', sql.NVarChar, level)
      .input('aid', sql.Int, req.user.id).input('an', sql.NVarChar, req.user.name)
      .input('ae', sql.NVarChar, req.user.email).input('act', sql.NVarChar, 'reject')
      .input('cmt', sql.NVarChar, comment)
      .query('INSERT INTO ApprovalRecords(requestId,level,approverId,approverName,approverEmail,action,comment) VALUES(@rid,@lv,@aid,@an,@ae,@act,@cmt)');

    const up = await p.request().input('id', sql.Int, req.params.id)
      .query(`UPDATE AccessRequests SET status='rejected',updatedAt=GETUTCDATE() OUTPUT INSERTED.* WHERE id=@id`);
    res.json({ message: `${level} 审批拒绝`, request: up.recordset[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/requests/stats — 统计（admin + approver 可见）
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
  else res.status(404).json({ error: '端点不存在' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 企业内部存取权限申请系统 v3 已启动`);
  console.log(`📡 本地地址: http://localhost:${PORT}`);
  console.log(`🏥 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`\n👥 角色权限:`);
  console.log(`   requester     → 申请人 (创建/查看自己的申请)`);
  console.log(`   approver_l1   → L1 审批员 (审批 pending_l1)`);
  console.log(`   approver_l2   → L2 审批员 (审批 pending_l2)`);
  console.log(`   admin         → 管理员 (全部权限)`);
  console.log(`\n✅ 特性: 自动带入用户信息 | 时间范围查询 | 不可覆盖审核记录\n`);
});
