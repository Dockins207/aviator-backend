#!/usr/bin/env pwsh

# PostgreSQL connection details
$DB_HOST = '192.168.75.118'
$DB_PORT = 5432
$DB_NAME = 'aviator_db'
$DB_USER = 'admin'
$DB_PASSWORD = '2020'

# Migration files in order
$migrationFiles = @(
    '001_create_users_table.sql',
    '002_create_game_sessions_table.sql',
    '003_create_player_bets_table.sql',
    '004_create_chat_messages_table.sql',
    '005_create_wallet_table.sql'
)

# Function to apply a single migration
function Apply-Migration {
    param($file)

    $fullPath = Join-Path -Path $PSScriptRoot -ChildPath "migrations\$file"
    Write-Host "Applying migration: $file"
    
    $env:PGPASSWORD = $DB_PASSWORD
    
    try {
        $tableName = $file -replace '^\d+_create_(.+)_table\.sql$', '$1'
        
        # Drop table if exists
        & psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "DROP TABLE IF EXISTS $tableName CASCADE;"
        
        # Apply migration
        & psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f $fullPath
        
        if ($LASTEXITCODE -ne 0) {
            throw "Migration failed: $file"
        }
        
        Write-Host "Successfully applied migration: $file"
    }
    catch {
        Write-Error "Error in migration $file`: $_"
        throw
    }
}

# Apply migrations
foreach ($file in $migrationFiles) {
    Apply-Migration -file $file
}

# Verify tables
Write-Host "Verifying database tables..."
& psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "\dt"
