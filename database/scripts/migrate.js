import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import path from 'path';

// Database connection configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'aviator_db',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || '2020'
});

// Logging function
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  console[type](`[${timestamp}] ${message}`);
}

// Migration function
async function runMigrations() {
  const client = await pool.connect();

  try {
    log('Starting database migrations...');

    // Create migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        run_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Path to migration files
    const migrationDir = path.resolve(process.cwd(), '../database/migrations');
    const migrationFiles = fs.readdirSync(migrationDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Ensure migrations run in order

    log(`Found ${migrationFiles.length} migration files`);

    // Run each migration
    for (const file of migrationFiles) {
      const migrationPath = path.join(migrationDir, file);
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');

      // Check if migration has already been run
      const checkMigration = await client.query(
        'SELECT * FROM migrations WHERE name = $1', 
        [file]
      );

      if (checkMigration.rows.length === 0) {
        log(`Running migration: ${file}`);
        
        try {
          // Run migration
          await client.query(migrationSql);

          // Log migration in migrations table
          await client.query(
            'INSERT INTO migrations (name) VALUES ($1)', 
            [file]
          );

          log(`Migration ${file} completed successfully`);
        } catch (migrationError) {
          // Log the full error for debugging
          log(`Migration error details: ${JSON.stringify(migrationError)}`, 'error');

          // Check if error is due to existing table
          if (migrationError.code === '42P07') {
            log(`Table already exists in migration ${file}, skipping`, 'warn');
            
            // Still record the migration to prevent re-running
            await client.query(
              'INSERT INTO migrations (name) VALUES ($1)', 
              [file]
            );
          } else {
            log(`Error in migration ${file}: ${migrationError.message}`, 'error');
            // Decide whether to continue or stop based on error
            if (migrationError.message.includes('current transaction is aborted')) {
              log('Transaction aborted, attempting to continue', 'warn');
              await client.query('ROLLBACK');
              await client.query('BEGIN');
            } else {
              throw migrationError;
            }
          }
        }
      } else {
        log(`Migration ${file} already run, skipping`);
      }
    }

    log('All migrations completed successfully');
  } catch (error) {
    log(`Migration failed: ${error.message}`, 'error');
    throw error;
  } finally {
    // Always release the client
    client.release();
  }
}

// Run migrations
runMigrations()
  .then(() => {
    log('Migration process completed');
    process.exit(0);
  })
  .catch(error => {
    log(`Migration process failed: ${error.message}`, 'error');
    process.exit(1);
  });
