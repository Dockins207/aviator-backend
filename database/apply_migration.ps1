#!/usr/bin/env pwsh

# PostgreSQL connection details from .env
$env:PGPASSWORD = '2020'
$DB_HOST = '192.168.75.118'
$DB_PORT = 5432
$DB_NAME = 'aviator_db'
$DB_USER = 'admin'

# Migration files in order
$migrationFiles = @(
    '001_create_users_table.sql',
    '002_create_game_sessions_table.sql',
    '003_create_player_bets_table.sql',
    '004_create_chat_messages_table.sql',
    '005_create_wallet_table.sql'
)

# Function to apply a single migration
function Apply-Migration($file) {
    $fullPath = Join-Path -Path $PSScriptRoot -ChildPath "migrations\$file"
    Write-Host "Applying migration: $file"
    
    psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f $fullPath
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to apply migration: $file"
        exit 1
    }
}

# Apply migrations in order
foreach ($file in $migrationFiles) {
    Apply-Migration $file
}

# Verify table creation
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "\dt"
