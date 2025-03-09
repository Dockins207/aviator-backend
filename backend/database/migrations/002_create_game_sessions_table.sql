-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop all related objects in correct order
DO $$ 
BEGIN
    -- Drop functions first
    DROP FUNCTION IF EXISTS cleanup_old_game_records() CASCADE;
    DROP FUNCTION IF EXISTS mark_game_session_complete(UUID, numeric) CASCADE;
    DROP FUNCTION IF EXISTS manage_game_session_status() CASCADE;
    
    -- Drop tables and related objects
    DROP TABLE IF EXISTS game_sessions CASCADE;
    
    -- Drop types last
    DROP TYPE IF EXISTS game_type CASCADE;
    DROP TYPE IF EXISTS game_status CASCADE;
EXCEPTION WHEN OTHERS THEN
    -- Ignore errors during drop
END $$;

-- Create enums
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'game_type') THEN
        CREATE TYPE game_type AS ENUM ('aviator');
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'game_status') THEN
        CREATE TYPE game_status AS ENUM ('betting', 'in_progress', 'completed');
    END IF;
END $$;

-- Create game sessions table
CREATE TABLE game_sessions (
    game_session_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game_type game_type NOT NULL,
    status game_status DEFAULT 'betting' NOT NULL,
    total_bet_amount NUMERIC(18, 2) DEFAULT 0.00 NOT NULL,
    crash_point numeric(5,2),
    ended_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_total_bet_amount_non_negative CHECK (total_bet_amount >= 0)
);

-- Execute this in your PostgreSQL database
ALTER TABLE game_sessions 
ALTER COLUMN crash_point TYPE numeric(5,2) USING (crash_point::text::numeric);

-- Create indexes
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_game_sessions_type') THEN
        CREATE INDEX idx_game_sessions_type ON game_sessions(game_type);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_game_sessions_status') THEN
        CREATE INDEX idx_game_sessions_status ON game_sessions(status);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_game_sessions_created_at') THEN
        CREATE INDEX idx_game_sessions_created_at ON game_sessions(created_at);
    END IF;
END $$;

-- Create status management trigger function
CREATE OR REPLACE FUNCTION manage_game_session_status() 
RETURNS TRIGGER AS $$
BEGIN
    -- Ensure we're using the correct enum type
    NEW.status := NEW.status::game_status;

    -- Set ended_at when game is completed
    IF NEW.status = 'completed'::game_status AND NEW.crash_point IS NOT NULL THEN
        NEW.ended_at := CURRENT_TIMESTAMP;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create status management trigger
DROP TRIGGER IF EXISTS game_session_status_transition ON game_sessions;
CREATE TRIGGER game_session_status_transition 
    BEFORE UPDATE ON game_sessions 
    FOR EACH ROW 
    EXECUTE FUNCTION manage_game_session_status();

-- Create completion function
CREATE OR REPLACE FUNCTION mark_game_session_complete(
    p_game_session_id UUID,
    p_crash_point numeric(5,2)
) RETURNS VOID AS $$
BEGIN
    UPDATE game_sessions 
    SET 
        status = 'completed'::game_status,
        crash_point = p_crash_point,
        ended_at = CURRENT_TIMESTAMP
    WHERE game_session_id = p_game_session_id 
      AND status = 'in_progress'::game_status;
END;
$$ LANGUAGE plpgsql;

-- Create cleanup function
CREATE OR REPLACE FUNCTION cleanup_old_game_records()
RETURNS void AS $$
DECLARE
    retention_days INTEGER := 90;
BEGIN
    DELETE FROM game_sessions 
    WHERE created_at < NOW() - INTERVAL '90 days';

    -- Note: player_bets cleanup is handled by foreign key constraints
END;
$$ LANGUAGE plpgsql;

-- Check column data type
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'game_sessions' AND column_name = 'crash_point';
