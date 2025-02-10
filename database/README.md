# Aviator Database

## Prerequisites
- PostgreSQL 13+
- Node.js 18+

## Setup

1. Create PostgreSQL Database
```bash
createdb aviator
createuser aviator_admin
```

2. Install Dependencies
```bash
npm install
```

## Database Migrations

Run migrations:
```bash
npm run migrate
```

Rollback last migration:
```bash
npm run migrate:down
```

Create new migration:
```bash
npm run migrate:create migration_name
```

## Seeding Data

Seed initial data:
```bash
npm run seed
```

## Database Structure
- `migrations/`: Database schema changes
- `seeds/`: Initial data population
- `schemas/`: Optional schema definitions
- `queries/`: Complex or reusable SQL queries
