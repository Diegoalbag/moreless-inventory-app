#!/usr/bin/env node
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

console.log('🚀 Starting database setup...');

try {
  console.log('📦 Generating Prisma client...');
  execSync('npx prisma generate', { stdio: 'inherit' });
  
  console.log('🗄️  Pushing database schema...');
  const pushResult = execSync('npx prisma db push --accept-data-loss --skip-generate', { 
    stdio: 'inherit',
    encoding: 'utf-8'
  });
  console.log('Prisma db push result:', pushResult);
  
  console.log('✅ Verifying database connection...');
  const prisma = new PrismaClient();
  
  // Wait a moment for database to be ready
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Test connection by checking if Session table exists
  try {
    const result = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Session', 'session')`;
    console.log('Tables found:', result);
    
    // Try to query the Session table (Prisma uses quoted names)
    await prisma.$queryRaw`SELECT 1 FROM "Session" LIMIT 1`;
    console.log('✅ Session table exists and is accessible!');
  } catch (e) {
    console.error('❌ Error verifying Session table:', e.message);
    console.error('Full error:', e);
    
    // List all tables to debug
    try {
      const allTables = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
      console.log('All tables in database:', allTables);
    } catch (listError) {
      console.error('Could not list tables:', listError.message);
    }
    
    throw new Error(`Session table verification failed: ${e.message}`);
  }
  
  await prisma.$disconnect();
  console.log('✅ Database setup complete!');
  process.exit(0);
} catch (error) {
  console.error('❌ Database setup failed:', error.message);
  process.exit(1);
}

