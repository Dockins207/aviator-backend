const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  // Determine the connection string
  const connectionString = process.env.DATABASE_URL || 
    'postgresql://localhost:5432/aviator';

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') 
      ? false 
      : { rejectUnauthorized: false }
  });

  const client = await pool.connect();

  try {
    // Create migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        migrated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Get migration files
    const migrationDir = path.join(__dirname, 'migrations');
    const migrationFiles = fs.readdirSync(migrationDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    // Run migrations
    for (const file of migrationFiles) {
      const migrationPath = path.join(migrationDir, file);
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');
      const version = path.basename(file, '.sql');

      // Check if migration has been run
      const { rows } = await client.query(
        'SELECT * FROM schema_migrations WHERE version = $1', 
        [version]
      );

      if (rows.length === 0) {
        console.log(`Running migration: ${file}`);
        await client.query(migrationSql);
        
        // Record migration
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)', 
          [version]
        );
      } else {
        console.log(`Migration ${file} already applied`);
      }
    }

    console.log('All migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migrations if script is called directly
if (require.main === module) {
  runMigrations().catch(console.error);
}

module.exports = { runMigrations };
