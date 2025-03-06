#!/bin/bash

# Database Setup and Migration Script for Aviator Backend

# Fail on any error
set -e

# Configuration
DB_NAME="aviator_db"
DB_USER="admin"
MIGRATIONS_DIR="../migrations"

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to log messages
log_message() {
    echo -e "${GREEN}[DB SETUP]${NC} $1"
}

# Function to log errors
log_error() {
    echo -e "${RED}[DB ERROR]${NC} $1"
}

# Check if PostgreSQL is installed
check_postgres() {
    if ! command -v psql &> /dev/null; then
        log_error "PostgreSQL is not installed. Please install PostgreSQL."
        exit 1
    fi
}

# Create database if not exists
create_database() {
    log_message "Checking/Creating database: ${DB_NAME}"
    sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME}"
    
    log_message "Granting privileges to ${DB_USER}"
    sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER}"
}

# Run migrations
run_migrations() {
    log_message "Running migrations from ${MIGRATIONS_DIR}"
    
    # Sort migrations to ensure correct order
    MIGRATIONS=$(ls -1 "${MIGRATIONS_DIR}"/*.sql | sort)
    
    for migration in $MIGRATIONS; do
        log_message "Applying migration: $(basename "$migration")"
        sudo -u postgres psql -d "${DB_NAME}" -f "$migration"
    done
}

# Verify database setup
verify_database() {
    log_message "Verifying database setup"
    sudo -u postgres psql -d "${DB_NAME}" -c "SELECT 'Database is ready' AS status"
}

# Main execution
main() {
    check_postgres
    create_database
    run_migrations
    verify_database
    
    log_message "Database setup completed successfully! 🚀"
}

# Run the main function
main
