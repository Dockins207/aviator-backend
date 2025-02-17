-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Ensure admin role exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin') THEN
        CREATE ROLE admin WITH LOGIN SUPERUSER;
    END IF;
END $$;

-- Create game session enums if they don't exist
DO $$
DECLARE 
    v_type_exists BOOLEAN;
BEGIN
    -- Check and create game_type enum if not exists
    SELECT EXISTS (
        SELECT 1 FROM pg_type 
        WHERE typname = 'game_type'
    ) INTO v_type_exists;

    IF NOT v_type_exists THEN
        CREATE TYPE game_type AS ENUM ('aviator', 'crash', 'roulette');
    END IF;

    -- Check and create game_status enum if not exists
    SELECT EXISTS (
        SELECT 1 FROM pg_type 
        WHERE typname = 'game_status'
    ) INTO v_type_exists;

    IF NOT v_type_exists THEN
        CREATE TYPE game_status AS ENUM (
            'in_progress', 
            'completed'
        );
    END IF;
END $$;

-- Create game sessions table with robust constraints
CREATE TABLE IF NOT EXISTS game_sessions (
    game_session_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game_type game_type NOT NULL,
    status game_status DEFAULT 'in_progress' NOT NULL,
    total_bet_amount NUMERIC(18, 2) DEFAULT 0.00 NOT NULL,
    metadata JSONB DEFAULT '{}',
    
    -- Added columns from game sessions tracking
    multiplier DECIMAL(10, 2) DEFAULT 1.00 NOT NULL,
    crash_point DECIMAL(10, 2) DEFAULT 1.00 NOT NULL,
    crash_point_history JSONB DEFAULT '[]'::JSONB,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_game_sessions_type ON game_sessions(game_type);
CREATE INDEX IF NOT EXISTS idx_game_sessions_status ON game_sessions(status);
CREATE INDEX IF NOT EXISTS idx_game_sessions_created_at ON game_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_game_sessions_metadata ON game_sessions USING GIN (metadata);

-- Add constraints
ALTER TABLE game_sessions 
ADD CONSTRAINT chk_total_bet_amount_non_negative 
CHECK (total_bet_amount >= 0);

-- Optional: Add a trigger to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_game_sessions_modtime
BEFORE UPDATE ON game_sessions
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();

-- Function to update game session metadata with admin privileges
CREATE OR REPLACE FUNCTION update_game_session_metadata(
    p_game_session_id UUID, 
    p_metadata JSONB
) RETURNS VOID SECURITY DEFINER AS $$
BEGIN
    UPDATE game_sessions 
    SET 
        metadata = metadata || p_metadata,
        updated_at = CURRENT_TIMESTAMP
    WHERE game_session_id = p_game_session_id;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

-- Function to clean up old game records
CREATE OR REPLACE FUNCTION cleanup_old_game_records()
RETURNS void AS $$
DECLARE
    retention_days INTEGER := 90; -- Keep records for 90 days
BEGIN
    -- Delete old game sessions
    DELETE FROM game_sessions 
    WHERE created_at < NOW() - INTERVAL '90 days';

    -- Delete corresponding player bets
    DELETE FROM player_bets 
    WHERE game_session_id NOT IN (SELECT game_session_id FROM game_sessions);

    -- Log the cleanup operation
    INSERT INTO system_logs (
        log_level, 
        message, 
        details
    ) VALUES (
        'INFO', 
        'Cleaned up old game records', 
        format('Deleted game sessions and bets older than %s days', retention_days)
    );
END;
$$ LANGUAGE plpgsql;

-- Change table and index owners to admin
ALTER TABLE game_sessions OWNER TO admin;
ALTER INDEX idx_game_sessions_type OWNER TO admin;
ALTER INDEX idx_game_sessions_status OWNER TO admin;
ALTER INDEX idx_game_sessions_created_at OWNER TO admin;
ALTER INDEX idx_game_sessions_metadata OWNER TO admin;
