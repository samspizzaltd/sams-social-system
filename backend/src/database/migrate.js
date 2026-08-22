import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  try {
    console.log('🔄 Starting database migration...');

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
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
