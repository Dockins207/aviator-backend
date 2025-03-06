import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Pool } = pg;

// Create a new pool using the connection string
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runSeedScripts() {
  const client = await pool.connect();

  try {
    // Path to seeds directory
    const seedsDir = path.resolve(process.cwd(), 'seeds');
    
    // Read all SQL seed files
    const seedFiles = await fs.readdir(seedsDir);
    
    // Sort seed files to ensure correct order
    const sortedSeedFiles = seedFiles
      .filter(file => file.endsWith('.sql'))
      .sort();

    for (const file of sortedSeedFiles) {
      const seedPath = path.join(seedsDir, file);
      const seedScript = await fs.readFile(seedPath, 'utf8');
      
      console.log(`Running seed script: ${file}`);
      
      // Execute seed script
      await client.query(seedScript);
    }

    console.log('Database seeding completed successfully');
  } catch (error) {
    console.error('Error during database seeding:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the seeding process
runSeedScripts();
