const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  try {
    console.log('🔄 Starting database migration...');

    const schemaPath = path.join(__dirname, '../../../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schema);

    console.log('✅ Database migration complete!');
    console.log('✅ Tables created:');
    console.log('  - accounts');
    console.log('  - content');
    console.log('  - media');
    console.log('  - analytics');
    console.log('  - comments');
    console.log('  - competitors');
    console.log('  - trends');
    console.log('  - branding');
    console.log('  - users');

    await pool.end();
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
