# Aviator Backend Database Management

## Database Setup and Migration

### Prerequisites
- PostgreSQL installed
- PostgreSQL user 'admin' created
- Bash shell

### Setup Script

The `scripts/db_setup.sh` script automates database creation and migration:

```bash
# Navigate to the scripts directory
cd database/scripts

# Make script executable (if not already)
chmod +x db_setup.sh

# Run the setup script
./db_setup.sh
```

### What the Script Does
1. Checks PostgreSQL installation
2. Creates `aviator_db` database if not exists
3. Grants privileges to 'admin' user
4. Runs migrations in order
5. Verifies database setup

### Migrations
- Migrations are SQL files in the `migrations/` directory
- Sorted and applied in numerical order
- Each migration should be idempotent

### Troubleshooting
- Ensure PostgreSQL is running
- Verify database user permissions
- Check migration files for SQL syntax errors

### Configuration
Modify script variables for custom:
- Database name
- Database user
- Migration directory

## Contributing
- Add new migrations with sequential numbering
- Test migrations before committing
