#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function ensureSessionTable() {
  try {
    console.log('🔍 Checking if session table exists...');
    
    // Check if table exists
    const result = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'session'
    `;
    
    if (result && result.length > 0) {
      console.log('✅ Session table already exists!');
      await prisma.$disconnect();
      return;
    }
    
    console.log('📦 Creating session table...');
    
    // Create the session table
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "session" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "shop" TEXT NOT NULL,
        "state" TEXT NOT NULL,
        "isOnline" BOOLEAN NOT NULL DEFAULT false,
        "scope" TEXT,
        "expires" TIMESTAMP,
        "accessToken" TEXT NOT NULL,
        "userId" BIGINT,
        "firstName" TEXT,
        "lastName" TEXT,
        "email" TEXT,
        "accountOwner" BOOLEAN NOT NULL DEFAULT false,
        "locale" TEXT,
        "collaborator" BOOLEAN DEFAULT false,
        "emailVerified" BOOLEAN DEFAULT false
      )
    `;
    
    console.log('✅ Session table created successfully!');
    
    // Verify it was created
    const verify = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'session'
    `;
    
    if (verify && verify.length > 0) {
      console.log('✅ Verified: session table exists!');
    } else {
      throw new Error('Session table was not created');
    }
    
    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ Error ensuring session table:', error.message);
    await prisma.$disconnect();
    process.exit(1);
  }
}

ensureSessionTable();

