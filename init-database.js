// 数据库初始化脚本
const sql = require('mssql');
require('dotenv').config();

const config = {
    user: process.env.DB_USER || 'sqladmin',
    password: process.env.DB_PASSWORD || 'AccessRequestDB@2026',
    server: process.env.DB_SERVER || 'sql-access-request-dev.database.windows.net',
    database: process.env.DB_NAME || 'AccessRequestDB',
    options: { encrypt: true, trustServerCertificate: false }
};

async function initDB() {
    console.log('🔌 连接数据库...');
    let pool;
    try {
        pool = await sql.connect(config);
        console.log('✅ 数据库连接成功');

        // 1. AccessRequests 表
        console.log('📋 创建 AccessRequests 表...');
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AccessRequests' AND xtype='U')
            CREATE TABLE AccessRequests (
                id INT IDENTITY(1,1) PRIMARY KEY,
                employeeName NVARCHAR(100) NOT NULL,
                employeeEmail NVARCHAR(100) NOT NULL,
                requestType NVARCHAR(50) DEFAULT 'access',
                resourceName NVARCHAR(100) NOT NULL,
                resourceType NVARCHAR(50) DEFAULT 'system',
                justification NVARCHAR(500) NOT NULL,
                requestedAccessLevel NVARCHAR(50) DEFAULT 'read',
                requestedDurationDays INT DEFAULT 30,
                status NVARCHAR(50) DEFAULT 'draft',
                createdAt DATETIME DEFAULT GETDATE(),
                updatedAt DATETIME DEFAULT GETDATE()
            )
        `);
        console.log('✅ AccessRequests 表创建成功');

        // 2. Approvals 表
        console.log('📋 创建 Approvals 表...');
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Approvals' AND xtype='U')
            CREATE TABLE Approvals (
                id INT IDENTITY(1,1) PRIMARY KEY,
                requestId INT NOT NULL,
                approverName NVARCHAR(100) NOT NULL,
                approverEmail NVARCHAR(100) NOT NULL,
                approvalStatus NVARCHAR(50) NOT NULL,
                approvalNotes NVARCHAR(500),
                approvedAt DATETIME DEFAULT GETDATE()
            )
        `);
        console.log('✅ Approvals 表创建成功');

        // 3. AuditLogs 表
        console.log('📋 创建 AuditLogs 表...');
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AuditLogs' AND xtype='U')
            CREATE TABLE AuditLogs (
                id INT IDENTITY(1,1) PRIMARY KEY,
                requestId INT,
                action NVARCHAR(50) NOT NULL,
                performedBy NVARCHAR(100),
                details NVARCHAR(500),
                timestamp DATETIME DEFAULT GETDATE()
            )
        `);
        console.log('✅ AuditLogs 表创建成功');

        // 4. ProvisioningQueue 表
        console.log('📋 创建 ProvisioningQueue 表...');
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ProvisioningQueue' AND xtype='U')
            CREATE TABLE ProvisioningQueue (
                id INT IDENTITY(1,1) PRIMARY KEY,
                requestId INT NOT NULL,
                status NVARCHAR(50) DEFAULT 'pending',
                createdAt DATETIME DEFAULT GETDATE(),
                processedAt DATETIME
            )
        `);
        console.log('✅ ProvisioningQueue 表创建成功');

        // 5. 插入测试数据
        console.log('📊 插入测试数据...');
        const checkCount = await pool.request().query('SELECT COUNT(*) as cnt FROM AccessRequests');
        if (checkCount.recordset[0].cnt === 0) {
            await pool.request().query(`
                INSERT INTO AccessRequests (employeeName, employeeEmail, requestType, resourceName, resourceType, justification, requestedAccessLevel, requestedDurationDays, status)
                VALUES
                (N'张三', 'zhangsan@company.com', 'access', N'生产数据库', 'database', N'需要访问生产数据库进行数据分析工作', 'read', 30, 'submitted'),
                (N'李四', 'lisi@company.com', 'admin', N'内部OA系统', 'system', N'新员工入职，需要访问OA系统处理日常工作', 'read', 90, 'approved'),
                (N'王五', 'wangwu@company.com', 'access', N'财务报表系统', 'system', N'本季度财务审计需要访问相关数据', 'read', 7, 'submitted')
            `);
            // 插入测试审批记录
            await pool.request().query(`
                INSERT INTO Approvals (requestId, approverName, approverEmail, approvalStatus, approvalNotes)
                VALUES (2, N'管理员', 'admin@company.com', 'approved', N'新员工权限申请，审批通过')
            `);
            // 更新第二条为已通过
            await pool.request().query(`UPDATE AccessRequests SET status='approved' WHERE id=2`);
            console.log('✅ 测试数据插入成功 (3条申请)');
        } else {
            console.log(`ℹ️  已存在 ${checkCount.recordset[0].cnt} 条数据，跳过测试数据插入`);
        }

        // 6. 验证
        const result = await pool.request().query('SELECT COUNT(*) as cnt FROM AccessRequests');
        console.log(`\n🎉 数据库初始化完成！AccessRequests 共 ${result.recordset[0].cnt} 条记录`);
        console.log('\n✅ 所有表已创建:');
        console.log('   - AccessRequests (权限申请主表)');
        console.log('   - Approvals (审批记录表)');
        console.log('   - AuditLogs (审计日志表)');
        console.log('   - ProvisioningQueue (权限配置队列)');

    } catch (err) {
        console.error('❌ 初始化失败:', err.message);
        process.exit(1);
    } finally {
        if (pool) await pool.close();
    }
}

initDB();
