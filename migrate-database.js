// 数据库迁移脚本 - 企业内部存取权限申请系统 v3
const sql = require('mssql');
require('dotenv').config();

const config = {
    user: process.env.DB_USER || 'sqladmin',
    password: process.env.DB_PASSWORD || 'AccessRequestDB@2026',
    server: process.env.DB_SERVER || 'sql-access-request-dev.database.windows.net',
    database: process.env.DB_NAME || 'AccessRequestDB',
    options: { encrypt: true, trustServerCertificate: false }
};

async function migrateDB() {
    console.log('🔌 连接数据库进行迁移...');
    let pool;
    try {
        pool = await sql.connect(config);
        console.log('✅ 数据库连接成功');

        // 1. 备份现有数据
        console.log('📋 备份现有数据...');
        const backupResult = await pool.request().query(`
            SELECT COUNT(*) as cnt FROM AccessRequests;
            SELECT COUNT(*) as cnt FROM Users;
            SELECT COUNT(*) as cnt FROM ApprovalRecords;
        `);
        console.log(`ℹ️  当前数据统计:`);
        console.log(`   - AccessRequests: ${backupResult.recordsets[0][0].cnt} 条`);
        console.log(`   - Users: ${backupResult.recordsets[1][0].cnt} 条`);
        console.log(`   - ApprovalRecords: ${backupResult.recordsets[2][0].cnt} 条`);

        // 2. 检查并修改 Users 表
        console.log('📋 检查 Users 表结构...');
        const userColumns = await pool.request().query(`
            SELECT COLUMN_NAME, DATA_TYPE 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'Users'
        `);
        const userColumnNames = userColumns.recordset.map(c => c.COLUMN_NAME.toLowerCase());
        
        if (!userColumnNames.includes('department')) {
            console.log('➕ 添加 department 字段到 Users 表...');
            await pool.request().query(`
                ALTER TABLE Users ADD department NVARCHAR(100) NULL;
            `);
            console.log('✅ department 字段添加成功');
        }
        
        if (!userColumnNames.includes('jobtitle')) {
            console.log('➕ 添加 jobTitle 字段到 Users 表...');
            await pool.request().query(`
                ALTER TABLE Users ADD jobTitle NVARCHAR(100) NULL;
            `);
            console.log('✅ jobTitle 字段添加成功');
        }

        // 3. 检查并修改 AccessRequests 表
        console.log('📋 检查 AccessRequests 表结构...');
        const requestColumns = await pool.request().query(`
            SELECT COLUMN_NAME, DATA_TYPE 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'AccessRequests'
        `);
        const requestColumnNames = requestColumns.recordset.map(c => c.COLUMN_NAME.toLowerCase());
        
        // 重命名现有字段以保持兼容性
        console.log('🔄 重命名字段以匹配新需求...');
        
        // 检查并重命名 employeeName → requesterName (保持兼容)
        if (requestColumnNames.includes('employeename') && !requestColumnNames.includes('requestername')) {
            console.log('📝 重命名 employeeName → requesterName...');
            await pool.request().query(`
                EXEC sp_rename 'AccessRequests.employeeName', 'requesterName', 'COLUMN';
            `);
        }
        
        // 检查并重命名 employeeEmail → requesterEmail (保持兼容)
        if (requestColumnNames.includes('employeeemail') && !requestColumnNames.includes('requesteremail')) {
            console.log('📝 重命名 employeeEmail → requesterEmail...');
            await pool.request().query(`
                EXEC sp_rename 'AccessRequests.employeeEmail', 'requesterEmail', 'COLUMN';
            `);
        }
        
        // 检查并重命名 justification → reason (保持兼容)
        if (requestColumnNames.includes('justification') && !requestColumnNames.includes('reason')) {
            console.log('📝 重命名 justification → reason...');
            await pool.request().query(`
                EXEC sp_rename 'AccessRequests.justification', 'reason', 'COLUMN';
            `);
        }
        
        // 检查并重命名 resourceName → targetResource (保持兼容)
        if (requestColumnNames.includes('resourcename') && !requestColumnNames.includes('targetresource')) {
            console.log('📝 重命名 resourceName → targetResource...');
            await pool.request().query(`
                EXEC sp_rename 'AccessRequests.resourceName', 'targetResource', 'COLUMN';
            `);
        }
        
        // 检查并重命名 requestedDurationDays → durationDays (保持兼容)
        if (requestColumnNames.includes('requesteddurationdays') && !requestColumnNames.includes('durationdays')) {
            console.log('📝 重命名 requestedDurationDays → durationDays...');
            await pool.request().query(`
                EXEC sp_rename 'AccessRequests.requestedDurationDays', 'durationDays', 'COLUMN';
            `);
        }

        // 4. 添加新字段
        console.log('📋 添加新字段到 AccessRequests 表...');
        
        if (!requestColumnNames.includes('department')) {
            console.log('➕ 添加 department 字段...');
            await pool.request().query(`
                ALTER TABLE AccessRequests ADD department NVARCHAR(100) NULL;
            `);
        }
        
        if (!requestColumnNames.includes('jobtitle')) {
            console.log('➕ 添加 jobTitle 字段...');
            await pool.request().query(`
                ALTER TABLE AccessRequests ADD jobTitle NVARCHAR(100) NULL;
            `);
        }
        
        if (!requestColumnNames.includes('startdate')) {
            console.log('➕ 添加 startDate 字段...');
            await pool.request().query(`
                ALTER TABLE AccessRequests ADD startDate DATETIME NULL;
            `);
        }
        
        if (!requestColumnNames.includes('enddate')) {
            console.log('➕ 添加 endDate 字段...');
            await pool.request().query(`
                ALTER TABLE AccessRequests ADD endDate DATETIME NULL;
            `);
        }
        
        if (!requestColumnNames.includes('priority')) {
            console.log('➕ 添加 priority 字段...');
            await pool.request().query(`
                ALTER TABLE AccessRequests ADD priority NVARCHAR(20) DEFAULT 'normal';
            `);
        }

        // 5. 更新现有数据
        console.log('🔄 更新现有数据...');
        
        // 更新现有记录的 department 和 jobTitle
        await pool.request().query(`
            UPDATE AccessRequests 
            SET department = 'IT部门', 
                jobTitle = '员工',
                startDate = DATEADD(day, -30, GETDATE()),
                endDate = DATEADD(day, 30, GETDATE())
            WHERE department IS NULL;
        `);
        
        // 更新现有用户的 department 和 jobTitle
        await pool.request().query(`
            UPDATE Users 
            SET department = CASE 
                WHEN role = 'admin' THEN 'IT管理部'
                WHEN role LIKE 'approver%' THEN '审批部' 
                ELSE '员工部门' 
            END,
            jobTitle = CASE 
                WHEN role = 'admin' THEN '系统管理员'
                WHEN role = 'approver_l1' THEN '一级审批员'
                WHEN role = 'approver_l2' THEN '二级审批员'
                ELSE '员工'
            END
            WHERE department IS NULL;
        `);

        // 6. 验证迁移结果
        console.log('✅ 验证迁移结果...');
        const finalCheck = await pool.request().query(`
            SELECT 
                (SELECT COUNT(*) FROM AccessRequests) as requestCount,
                (SELECT COUNT(*) FROM Users) as userCount,
                (SELECT COUNT(*) FROM ApprovalRecords) as approvalCount
        `);
        
        console.log('\n🎉 数据库迁移完成！');
        console.log('📊 迁移后数据统计:');
        console.log(`   - AccessRequests: ${finalCheck.recordset[0].requestCount} 条`);
        console.log(`   - Users: ${finalCheck.recordset[0].userCount} 条`);
        console.log(`   - ApprovalRecords: ${finalCheck.recordset[0].approvalCount} 条`);
        
        console.log('\n✅ 新增字段:');
        console.log('   - Users.department: 部门信息');
        console.log('   - Users.jobTitle: 职位信息');
        console.log('   - AccessRequests.department: 申请部门');
        console.log('   - AccessRequests.jobTitle: 申请职位');
        console.log('   - AccessRequests.startDate: 开始日期');
        console.log('   - AccessRequests.endDate: 结束日期');
        console.log('   - AccessRequests.priority: 优先级');
        
        console.log('\n🔄 重命名字段:');
        console.log('   - employeeName → requesterName');
        console.log('   - employeeEmail → requesterEmail');
        console.log('   - justification → reason');
        console.log('   - resourceName → targetResource');
        console.log('   - requestedDurationDays → durationDays');

    } catch (err) {
        console.error('❌ 迁移失败:', err.message);
        console.error('详细错误:', err);
        process.exit(1);
    } finally {
        if (pool) await pool.close();
    }
}

// 执行迁移
migrateDB().catch(err => {
    console.error('❌ 迁移执行失败:', err.message);
    process.exit(1);
});