-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop all related objects in correct order
DO $$ 
BEGIN
    -- Drop functions first
    DROP FUNCTION IF EXISTS cleanup_old_game_records() CASCADE;
    DROP FUNCTION IF EXISTS mark_game_session_complete(UUID, numeric) CASCADE;
    DROP FUNCTION IF EXISTS manage_game_session_status() CASCADE;
    DROP FUNCTION IF EXISTS auto_activate_pending_bets() CASCADE;
    DROP FUNCTION IF EXISTS assign_pending_bets_to_new_session() CASCADE;
    DROP FUNCTION IF EXISTS log_trigger_execution() CASCADE;
    
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

-- Mark game session complete function
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

-- Debug trigger function to log when each trigger fires
CREATE OR REPLACE FUNCTION log_trigger_execution() RETURNS TRIGGER AS $$
BEGIN
    RAISE NOTICE 'Trigger % executed on % for row %', TG_NAME, TG_TABLE_NAME, NEW;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to activate pending bets when game transitions to in_progress
CREATE OR REPLACE FUNCTION auto_activate_pending_bets() RETURNS TRIGGER AS $$
DECLARE
    v_session_start_time TIMESTAMP WITH TIME ZONE;
    v_betting_window_end TIMESTAMP WITH TIME ZONE;
    v_current_time TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Ensure we're transitioning from betting to in_progress
    IF NEW.status = 'in_progress' AND OLD.status = 'betting' THEN
        -- Calculate betting window
        v_session_start_time := OLD.created_at;
        v_current_time := CURRENT_TIMESTAMP;
        v_betting_window_end := v_session_start_time + INTERVAL '5 seconds';

        -- Comprehensive bet activation - includes nulls and already assigned
        UPDATE player_bets
        SET 
            status = 'active',
            game_session_id = NEW.game_session_id
        WHERE 
            -- Activate pending bets
            status = 'pending' 
            -- Either unassigned OR already assigned to this session
            AND (game_session_id IS NULL OR game_session_id = NEW.game_session_id)
            -- Include bets created before or during the 5-second window
            AND created_at <= v_betting_window_end;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to assign pending bets to new game sessions
CREATE OR REPLACE FUNCTION assign_pending_bets_to_new_session() 
RETURNS TRIGGER AS $$
BEGIN
    -- Only execute when a new game session is created with 'betting' status
    IF NEW.status = 'betting' THEN
        -- Assign all pending bets without a session to this new session
        UPDATE player_bets
        SET game_session_id = NEW.game_session_id
        WHERE 
            status = 'pending' 
            AND game_session_id IS NULL;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- This ensures only one game session can be "in_progress" at a time
CREATE OR REPLACE FUNCTION enforce_single_active_game() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'in_progress' AND 
       EXISTS (SELECT 1 FROM game_sessions 
               WHERE status = 'in_progress' 
               AND game_session_id <> NEW.game_session_id) THEN
        RAISE EXCEPTION 'Cannot have multiple active games: Another game is already in progress';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add a constraint to ensure only one active session at a time
CREATE OR REPLACE FUNCTION enforce_single_active_session() RETURNS TRIGGER AS $$
BEGIN
    -- Count active sessions excluding the current one being created/updated
    IF (TG_OP = 'INSERT' AND NEW.status IN ('in_progress', 'betting')) OR 
       (TG_OP = 'UPDATE' AND NEW.status IN ('in_progress', 'betting') AND OLD.status != NEW.status) THEN
        
        IF EXISTS (
            SELECT 1 FROM game_sessions 
            WHERE status IN ('in_progress', 'betting') 
            AND game_session_id != COALESCE(NEW.game_session_id, '00000000-0000-0000-0000-000000000000')
        ) THEN
            RAISE EXCEPTION 'Cannot have multiple active game sessions';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Remove any existing triggers to avoid duplication
DROP TRIGGER IF EXISTS assign_pending_bets_trigger ON game_sessions;
DROP TRIGGER IF EXISTS activate_pending_bets_trigger ON game_sessions;
DROP TRIGGER IF EXISTS debug_assign_pending_bets ON game_sessions;
DROP TRIGGER IF EXISTS debug_activate_pending_bets ON game_sessions;
DROP TRIGGER IF EXISTS enforce_single_active_game_trigger ON game_sessions;
DROP TRIGGER IF EXISTS enforce_single_active_session_trigger ON game_sessions;

-- Create triggers on game_sessions table
CREATE TRIGGER assign_pending_bets_trigger
    AFTER INSERT ON game_sessions
    FOR EACH ROW
    WHEN (NEW.status = 'betting')
    EXECUTE FUNCTION assign_pending_bets_to_new_session();

CREATE TRIGGER activate_pending_bets_trigger
    AFTER UPDATE ON game_sessions
    FOR EACH ROW
    WHEN (OLD.status = 'betting' AND NEW.status = 'in_progress')
    EXECUTE FUNCTION auto_activate_pending_bets();

CREATE TRIGGER debug_assign_pending_bets
    AFTER INSERT ON game_sessions
    FOR EACH ROW
    EXECUTE FUNCTION log_trigger_execution();
    
CREATE TRIGGER debug_activate_pending_bets
    AFTER UPDATE ON game_sessions
    FOR EACH ROW 
    WHEN (OLD.status = 'betting' AND NEW.status = 'in_progress')
    EXECUTE FUNCTION log_trigger_execution();

CREATE TRIGGER enforce_single_active_game_trigger
    BEFORE UPDATE OR INSERT ON game_sessions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_single_active_game();

CREATE TRIGGER enforce_single_active_session_trigger
BEFORE INSERT OR UPDATE ON game_sessions
FOR EACH ROW EXECUTE FUNCTION enforce_single_active_session();
