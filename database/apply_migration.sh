#!/bin/bash

# PostgreSQL connection details
DB_NAME="aviator_db"
DB_USER="postgres"

# Apply the migration
psql -U $DB_USER -d $DB_NAME -f /home/kins/Desktop/aviator-backend/database/migrations/007_create_user_refresh_tokens.sql

# Verify table creation
psql -U $DB_USER -d $DB_NAME -c "\dt"
psql -U $DB_USER -d $DB_NAME -c "SELECT * FROM user_refresh_tokens;"
