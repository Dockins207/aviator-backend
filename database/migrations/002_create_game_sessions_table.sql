-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create game session enums if they don't exist
DO $$
BEGIN
    -- Create game_type enum if not exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'game_type'
    ) THEN
        CREATE TYPE game_type AS ENUM ('aviator', 'crash', 'roulette');
    END IF;

    -- Create game_status enum if not exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'game_status'
    ) THEN
        CREATE TYPE game_status AS ENUM (
            'pending', 
            'in_progress', 
            'completed', 
            'cancelled', 
            'betting', 
            'starting', 
            'crashed'
        );
    END IF;
END $$;

-- Drop existing game_sessions table if it exists
DROP TABLE IF EXISTS game_sessions;

-- Create game_sessions table
CREATE TABLE game_sessions (
    game_session_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game_type game_type NOT NULL,
    status game_status NOT NULL DEFAULT 'betting',
    total_bet_amount DECIMAL(10, 2) DEFAULT 0.00,
    crash_point DECIMAL(10, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (game_type, status)
);

-- Create index for faster game type lookups
CREATE INDEX idx_game_sessions_type ON game_sessions(game_type);

-- Create index for faster status lookups
CREATE INDEX idx_game_sessions_status ON game_sessions(status);

-- Change table owner to admin
ALTER TABLE game_sessions OWNER TO admin;
