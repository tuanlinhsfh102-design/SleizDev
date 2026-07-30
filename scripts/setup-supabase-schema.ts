// Try to connect to Supabase Postgres and create schema

import { Client } from 'pg';
import fs from 'fs';
import path from 'path';

const SUPABASE_PROJECT_REF = 'okeyouuilaldknazzhkx';
const SERVICE_KEY = 'sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj';

const SQL_FILE = path.resolve(process.cwd(), 'supabase-schema.sql');
const sql = fs.readFileSync(SQL_FILE, 'utf-8');

const connectionStrings = [
  `postgresql://postgres:${SERVICE_KEY}@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`,
  `postgresql://postgres.${SUPABASE_PROJECT_REF}:${SERVICE_KEY}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
  `postgresql://postgres.${SUPABASE_PROJECT_REF}:${SERVICE_KEY}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  `postgresql://postgres.${SUPABASE_PROJECT_REF}:${SERVICE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
  `postgresql://postgres.${SUPABASE_PROJECT_REF}:${SERVICE_KEY}@aws-0-us-west-1.pooler.supabase.com:6543/postgres`,
  `postgresql://postgres.${SUPABASE_PROJECT_REF}:${SERVICE_KEY}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`,
];

async function tryConnect() {
  for (const connStr of connectionStrings) {
    const client = new Client({
      connectionString: connStr,
      connectionTimeoutMillis: 5000,
      ssl: { rejectUnauthorized: false },
    });

    try {
      console.log(`Trying: ${connStr.replace(SERVICE_KEY, '***')}...`);
      await client.connect();
      console.log('✓ Connected!');

      console.log('Executing schema SQL...');
      await client.query(sql);
      console.log('✓ Schema created successfully!');

      await client.end();
      return true;
    } catch (error: any) {
      console.log(`✗ Failed: ${error.message.substring(0, 100)}`);
      try {
        await client.end();
      } catch {}
    }
  }
  return false;
}

tryConnect().then((success) => {
  if (success) {
    console.log('\n✅ Database schema setup complete!');
    process.exit(0);
  } else {
    console.log('\n❌ Could not connect to database. User needs to run SQL manually.');
    process.exit(1);
  }
});
