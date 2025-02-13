-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create game session enums
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'game_status') THEN
        CREATE TYPE game_status AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'game_type') THEN
        CREATE TYPE game_type AS ENUM ('aviator', 'crash', 'roulette');
    END IF;
END $$;

-- Create game_sessions table
CREATE TABLE game_sessions (
    game_session_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game_type game_type NOT NULL,
    total_bet_amount DECIMAL(10, 2) DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster game type lookups
CREATE INDEX idx_game_sessions_type ON game_sessions(game_type);
