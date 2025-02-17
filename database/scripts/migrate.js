import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  const logLevels = {
    'info': console.log,
    'warn': console.warn,
    'error': console.error
  };
  
  const logFunc = logLevels[type] || console.log;
  logFunc(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
}

// Function to ensure admin role and privileges
async function ensureAdminRole(client) {
  try {
    // Check if admin role exists
    const adminRoleCheck = await client.query(`
      SELECT 1 FROM pg_roles WHERE rolname = 'admin'
    `);

    if (adminRoleCheck.rows.length === 0) {
      log('Creating admin role', 'info');
      await client.query(`
        CREATE ROLE admin WITH LOGIN SUPERUSER;
      `);
    }

    // Ensure admin has necessary privileges
    await client.query(`
      GRANT ALL PRIVILEGES ON SCHEMA public TO admin;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admin;
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO admin;
      GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO admin;
    `);

    log('Admin role and privileges ensured', 'info');
  } catch (error) {
    log(`Error ensuring admin role: ${error.message}`, 'error');
    throw error;
  }
}

// Function to check and create extensions
async function ensureExtensions(client) {
  const requiredExtensions = [
    'uuid-ossp',   // UUID generation
    'pgcrypto'     // Encryption and hashing
  ];

  const optionalExtensions = [
    'pg_stat_statements'  // Query performance tracking
  ];

  for (const ext of requiredExtensions) {
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
      log(`Ensured ${ext} extension is installed`, 'info');
    } catch (error) {
      log(`Error installing required ${ext} extension: ${error.message}`, 'error');
      throw error;  // Fail for required extensions
    }
  }

  // Try optional extensions without throwing errors
  for (const ext of optionalExtensions) {
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
      log(`Ensured optional ${ext} extension is installed`, 'info');
    } catch (error) {
      log(`Could not install optional ${ext} extension: ${error.message}`, 'warn');
    }
  }
}

// Enhanced pre-migration validation
async function validateDatabaseObject(client, objectType, objectName, schemaName = 'public') {
  try {
    let query = '';
    switch (objectType) {
      case 'TYPE':
        query = `
          SELECT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE t.typname = $1 AND n.nspname = $2
          ) AS exists
        `;
        break;
      case 'TABLE':
        query = `
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = $1 AND table_schema = $2
          ) AS exists
        `;
        break;
      case 'COLUMN':
        query = `
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE column_name = $1 AND table_schema = $2
          ) AS exists
        `;
        break;
      case 'INDEX':
        query = `
          SELECT EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE indexname = $1 AND schemaname = $2
          ) AS exists
        `;
        break;
      case 'CONSTRAINT':
        query = `
          SELECT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = $1 AND table_schema = $2
          ) AS exists
        `;
        break;
      default:
        throw new Error(`Unsupported object type: ${objectType}`);
    }

    const result = await client.query(query, [objectName, schemaName]);
    return result.rows[0].exists;
  } catch (error) {
    log(`Validation error for ${objectType} ${objectName}: ${error.message}`, 'error');
    return false;
  }
}

// Function to execute SQL with robust error handling
async function executeSql(client, sql, filename) {
  try {
    // Skip execution if table already exists
    if (sql.includes('CREATE TABLE')) {
      const tableName = sql.match(/CREATE TABLE\s+(\w+)/i)[1];
      const tableExistsCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = $1
        )
      `, [tableName]);
      
      if (tableExistsCheck.rows[0].exists) {
        log(`Table ${tableName} already exists. Skipping creation.`, 'info');
        return;
      }
    }

    // Skip adding constraint if it already exists
    if (sql.includes('ADD CONSTRAINT')) {
      const constraintMatch = sql.match(/ADD\s+CONSTRAINT\s+(\w+)/i);
      if (constraintMatch) {
        const constraintName = constraintMatch[1];
        const constraintExistsCheck = await client.query(`
          SELECT EXISTS (
            SELECT 1 
            FROM information_schema.table_constraints 
            WHERE constraint_name = $1
          )
        `, [constraintName]);
        
        if (constraintExistsCheck.rows[0].exists) {
          log(`Constraint ${constraintName} already exists. Skipping.`, 'info');
          return;
        }
      }
    }

    // Execute SQL
    await client.query(sql);
    log(`Successfully executed SQL from ${filename}`, 'info');
  } catch (error) {
    // Specific handling for constraint errors
    if (error.code === '42710') {  // Duplicate constraint
      log(`Constraint already exists in ${filename}, skipping`, 'warn');
      return;
    }
    
    log(`Error executing SQL from ${filename}: ${error.message}`, 'error');
    throw error;
  }
}

// Function to create enums if they don't exist
async function createEnumTypes(client) {
  try {
    // Skip enum creation in this function
    log('Skipping enum type creation in migration script', 'info');
  } catch (error) {
    log(`Error in createEnumTypes: ${error.message}`, 'warn');
  }
}

// Function to update enum types with data migration
async function updateEnumTypes(client) {
  try {
    // Check if game_sessions table exists
    const gameSessionsExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'game_sessions'
      ) AS exists
    `);

    // Check if player_bets table exists
    const playerBetsExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'player_bets'
      ) AS exists
    `);

    // Only proceed if tables exist
    if (gameSessionsExists.rows[0].exists) {
      // Check game_status enum exists
      const gameStatusExists = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_type 
          WHERE typname = 'game_status'
        ) AS exists
      `);

      // If game_status enum doesn't exist, log a warning
      if (!gameStatusExists.rows[0].exists) {
        log('game_status enum does not exist. Ensure migration 002_create_game_sessions_table.sql has run.', 'warn');
      }
    }

    // Only proceed if tables exist
    if (playerBetsExists.rows[0].exists) {
      // Check bet_status enum exists
      const betStatusExists = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_type 
          WHERE typname = 'bet_status'
        ) AS exists
      `);

      // If bet_status enum doesn't exist, log a warning
      if (!betStatusExists.rows[0].exists) {
        log('bet_status enum does not exist. Ensure migration 003_create_player_bets_table.sql has run.', 'warn');
      }
    }

    log('Enum types check completed', 'info');
  } catch (error) {
    log(`Error checking enum types: ${error.message}`, 'error');
    log('Skipping enum updates', 'warn');
  }
}

// Function to generate referral code
async function createReferralCodeFunction(client) {
  try {
    await client.query(`
      CREATE OR REPLACE FUNCTION generate_referral_code()
      RETURNS TRIGGER AS $$
      DECLARE
        new_referral_code TEXT;
        is_unique BOOLEAN := false;
      BEGIN
        WHILE NOT is_unique LOOP
          -- Generate a random 8-character alphanumeric code
          new_referral_code := upper(substring(md5(random()::text), 1, 8));
          
          -- Check if the code is unique
          PERFORM 1 FROM users WHERE referral_code = new_referral_code;
          
          IF NOT FOUND THEN
            is_unique := true;
          END IF;
        END LOOP;
        
        NEW.referral_code := new_referral_code;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      -- Drop trigger if it exists to avoid conflicts
      DROP TRIGGER IF EXISTS generate_user_referral_code ON users;

      -- Trigger to generate referral code before insert
      CREATE TRIGGER generate_user_referral_code
      BEFORE INSERT ON users
      FOR EACH ROW
      WHEN (NEW.referral_code IS NULL)
      EXECUTE FUNCTION generate_referral_code();
    `);
    log('Referral code function and trigger created successfully', 'info');
  } catch (error) {
    log(`Error creating referral code function: ${error.message}`, 'error');
    throw error;
  }
}

// Migration function
async function runMigrations() {
  const client = await pool.connect();
  
  try {
    // Ensure admin role and privileges
    await ensureAdminRole(client);

    // Ensure extensions
    await ensureExtensions(client);

    // Create referral code function
    await createReferralCodeFunction(client);

    // Find migration files
    const migrationDir = path.resolve(__dirname, '../migrations');
    const migrationFiles = await fs.promises.readdir(migrationDir)
      .then(files => files
        .filter(file => file.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b))
      );

    log(`Found ${migrationFiles.length} migration files`, 'info');

    // Run migrations
    for (const filename of migrationFiles) {
      const filePath = path.join(migrationDir, filename);
      const sql = await fs.promises.readFile(filePath, 'utf8');

      try {
        log(`Executing migration: ${filename}`, 'info');
        await executeSql(client, sql, filename);
        log(`Successfully executed migration: ${filename}`, 'info');
      } catch (error) {
        log(`Error executing migration ${filename}: ${error.message}`, 'error');
        log(`Problematic SQL: ${sql}`, 'error');
        throw error;
      }
    }

    // Update enum types after migrations
    await updateEnumTypes(client);

    log('Migration process completed successfully', 'info');
  } catch (error) {
    log(`Migration process failed: ${error.message}`, 'error');
    throw error;
  } finally {
    client.release();
  }
}

// Run migrations
runMigrations()
  .then(() => {
    log('Migration process completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
