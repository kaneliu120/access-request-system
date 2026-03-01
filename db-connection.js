// 数据库连接模块
const sql = require('mssql');

// 数据库配置
const config = {
    server: process.env.AZURE_SQL_SERVER || 'sql-access-request-dev.database.windows.net',
    database: process.env.AZURE_SQL_DATABASE || 'AccessRequestDB',
    user: process.env.AZURE_SQL_USER || 'sqladmin',
    password: process.env.AZURE_SQL_PASSWORD || 'AccessRequestDB@2026',
    options: {
        encrypt: true,
        trustServerCertificate: false,
        connectionTimeout: 30000,
        requestTimeout: 30000
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// 连接池
let pool = null;

/**
 * 获取数据库连接
 */
async function getConnection() {
    try {
        if (!pool) {
            console.log('创建新的数据库连接池...');
            pool = await new sql.ConnectionPool(config).connect();
            console.log('✅ 数据库连接池创建成功');
        }
        return pool;
    } catch (error) {
        console.error('❌ 数据库连接失败:', error.message);
        throw error;
    }
}

/**
 * 执行查询
 */
async function executeQuery(query, params = []) {
    let connection = null;
    try {
        connection = await getConnection();
        const request = connection.request();
        
        // 添加参数
        params.forEach((param, index) => {
            request.input(`param${index}`, param.type || sql.NVarChar, param.value);
        });
        
        const result = await request.query(query);
        return result.recordset;
    } catch (error) {
        console.error('❌ 查询执行失败:', error.message);
        console.error('查询:', query);
        throw error;
    }
}

/**
 * 执行非查询操作 (INSERT, UPDATE, DELETE)
 */
async function executeNonQuery(query, params = []) {
    let connection = null;
    try {
        connection = await getConnection();
        const request = connection.request();
        
        // 添加参数
        params.forEach((param, index) => {
            request.input(`param${index}`, param.type || sql.NVarChar, param.value);
        });
        
        const result = await request.query(query);
        return result.rowsAffected[0];
    } catch (error) {
        console.error('❌ 非查询操作失败:', error.message);
        console.error('操作:', query);
        throw error;
    }
}

/**
 * 测试数据库连接
 */
async function testConnection() {
    try {
        const result = await executeQuery('SELECT @@VERSION as version');
        console.log('✅ 数据库连接测试成功');
        console.log('SQL Server版本:', result[0].version);
        return true;
    } catch (error) {
        console.error('❌ 数据库连接测试失败:', error.message);
        return false;
    }
}

/**
 * 初始化数据库表
 */
async function initializeDatabase() {
    try {
        console.log('开始初始化数据库表...');
        
        // 读取初始化脚本
        const fs = require('fs');
        const path = require('path');
        const initScript = fs.readFileSync('/tmp/init_db_now.sql', 'utf8');
        
        // 分割SQL语句并执行
        const statements = initScript.split('GO').filter(stmt => stmt.trim());
        
        for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i].trim();
            if (stmt) {
                console.log(`执行语句 ${i + 1}/${statements.length}...`);
                await executeNonQuery(stmt);
            }
        }
        
        console.log('✅ 数据库初始化完成');
        return true;
    } catch (error) {
        console.error('❌ 数据库初始化失败:', error.message);
        return false;
    }
}

/**
 * 获取表结构信息
 */
async function getTableInfo() {
    try {
        const query = `
            SELECT 
                t.name AS TableName,
                COUNT(c.column_id) AS ColumnCount,
                SUM(CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END) AS RequiredColumns
            FROM sys.tables t
            JOIN sys.columns c ON t.object_id = c.object_id
            GROUP BY t.name
            ORDER BY t.name;
        `;
        
        const result = await executeQuery(query);
        console.log('📊 数据库表结构信息:');
        result.forEach(row => {
            console.log(`  ${row.TableName}: ${row.ColumnCount}列 (${row.RequiredColumns}个必填列)`);
        });
        
        return result;
    } catch (error) {
        console.error('❌ 获取表结构信息失败:', error.message);
        return [];
    }
}

module.exports = {
    getConnection,
    executeQuery,
    executeNonQuery,
    testConnection,
    initializeDatabase,
    getTableInfo,
    sql
};
