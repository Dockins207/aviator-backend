-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create bet status enum with simplified statuses
DO $$
DECLARE 
    v_type_exists boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bet_status') INTO v_type_exists;
    IF NOT v_type_exists THEN
        CREATE TYPE bet_status AS ENUM ('pending', 'active', 'won', 'lost');
    END IF;

    -- Create bet_type enum
    SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bet_type') INTO v_type_exists;
    IF NOT v_type_exists THEN
        CREATE TYPE bet_type AS ENUM ('manual', 'auto', 'standard');
    END IF;
END $$;

-- Drop existing constraints and sequence if they exist
DROP SEQUENCE IF EXISTS bet_id_seq;
ALTER TABLE player_bets DROP CONSTRAINT IF EXISTS player_bets_bet_id_key;

-- Create a temporary table to preserve existing data
CREATE TEMPORARY TABLE IF NOT EXISTS temp_player_bets AS 
SELECT 
    user_id, 
    game_session_id, 
    bet_id AS old_bet_id,
    bet_amount, 
    cashout_multiplier, 
    status, 
    payout_amount, 
    autocashout_multiplier, 
    created_at 
FROM player_bets;

-- Drop the original table
DROP TABLE IF EXISTS player_bets;

-- Create the table with UUID bet_id
CREATE TABLE player_bets (
    bet_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    game_session_id UUID NULL REFERENCES game_sessions(game_session_id) ON DELETE CASCADE,
    bet_amount DECIMAL(10, 2) NOT NULL CHECK (bet_amount >= 10),
    cashout_multiplier DECIMAL(10, 2),
    status bet_status DEFAULT 'pending',
    payout_amount DECIMAL(10, 2) CHECK (payout_amount >= 0),
    autocashout_multiplier DECIMAL(10, 2),
    bet_type bet_type DEFAULT 'standard',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_session_complete BOOLEAN DEFAULT FALSE
);

-- Restore data with new bet_id sequence (if temp table exists)
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'temp_player_bets') THEN
        INSERT INTO player_bets (
            user_id, 
            game_session_id, 
            bet_amount, 
            cashout_multiplier, 
            status, 
            payout_amount, 
            autocashout_multiplier, 
            created_at,
            bet_type
        )
        SELECT 
            user_id, 
            game_session_id, 
            bet_amount, 
            cashout_multiplier, 
            status, 
            payout_amount, 
            autocashout_multiplier, 
            created_at,
            'standard' -- Default bet type for existing records
        FROM temp_player_bets;

        -- Drop the temporary table
        DROP TABLE temp_player_bets;
    END IF;
END $$;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_player_bets_user ON player_bets(user_id);
CREATE INDEX IF NOT EXISTS idx_player_bets_game_session ON player_bets(game_session_id);
CREATE INDEX IF NOT EXISTS idx_player_bets_status ON player_bets(status);
CREATE INDEX IF NOT EXISTS idx_player_bets_bet_type ON player_bets(bet_type);

-- Function to get active bets for Redis when game starts
CREATE OR REPLACE FUNCTION get_active_bets_for_redis(p_game_session_id UUID)
RETURNS TABLE (
    bet_id UUID,
    user_id UUID,
    bet_amount DECIMAL(10,2),
    autocashout_multiplier DECIMAL(10,2),
    game_session_id UUID,
    status bet_status
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pb.bet_id,
        pb.user_id,
        pb.bet_amount,
        pb.autocashout_multiplier,
        pb.game_session_id,
        pb.status
    FROM player_bets pb
    WHERE pb.game_session_id = p_game_session_id
    AND pb.status = 'active'::bet_status;
END;
$$ LANGUAGE plpgsql;

-- Function to automatically activate bets during betting window
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

-- Function to enforce bet limit per user per session
CREATE OR REPLACE FUNCTION check_user_bet_limit()
RETURNS TRIGGER AS $$
BEGIN
    IF (
        SELECT COUNT(*) FROM player_bets 
        WHERE user_id = NEW.user_id 
        AND game_session_id = NEW.game_session_id 
        AND status IN ('active', 'pending')
        AND bet_id != NEW.bet_id
    ) >= 2 THEN
        RAISE EXCEPTION 'User cannot place more than 2 bets in a game session';
    END IF;
 
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_bet_limit
BEFORE INSERT ON player_bets
FOR EACH ROW
EXECUTE FUNCTION check_user_bet_limit();

-- Function to resolve bets at the end of a game session
CREATE OR REPLACE FUNCTION resolve_game_session_bets(
    p_game_session_id UUID,
    p_final_crash_point DECIMAL(10, 2)
) RETURNS TABLE (
    total_won_bets INTEGER,
    total_lost_bets INTEGER,
    total_winnings DECIMAL(10, 2)
) AS $$
DECLARE
    v_total_won_bets INTEGER := 0;
    v_total_lost_bets INTEGER := 0;
    v_total_winnings DECIMAL(10, 2) := 0;
BEGIN
    -- Update bets based on cashout and crash point
    UPDATE player_bets pb
    SET 
        status = (
            CASE 
                WHEN pb.cashout_multiplier IS NOT NULL AND pb.cashout_multiplier <= p_final_crash_point 
                THEN 'won'::bet_status
                ELSE 'lost'::bet_status
            END
        ),
        payout_amount = (
            CASE 
                WHEN pb.cashout_multiplier IS NOT NULL AND pb.cashout_multiplier <= p_final_crash_point 
                THEN pb.bet_amount * pb.cashout_multiplier
                ELSE 0
            END
        ),
        is_session_complete = TRUE
    WHERE pb.game_session_id = p_game_session_id
      AND pb.status = 'active'::bet_status;

    -- Count and calculate totals
    SELECT 
        COUNT(CASE WHEN status = 'won'::bet_status THEN 1 END),
        COUNT(CASE WHEN status = 'lost'::bet_status THEN 1 END),
        COALESCE(SUM(CASE WHEN status = 'won'::bet_status THEN payout_amount ELSE 0 END), 0)
    INTO 
        v_total_won_bets, 
        v_total_lost_bets, 
        v_total_winnings
    FROM player_bets
    WHERE game_session_id = p_game_session_id;

    -- Return the results
    RETURN QUERY 
    SELECT 
        v_total_won_bets,
        v_total_lost_bets,
        v_total_winnings;
END;
$$ LANGUAGE plpgsql;

-- Function to automatically manage game session status
CREATE OR REPLACE FUNCTION manage_game_session_status() RETURNS TRIGGER AS $$
BEGIN
    -- Ensure we're using the correct enum type
    NEW.status := NEW.status::game_status;

    -- Automatically mark session as completed when game crashes
    IF NEW.status = 'in_progress'::game_status AND NEW.crash_point IS NOT NULL THEN
        NEW.status := 'completed'::game_status;
        
        -- Resolve bets when session is completed
        PERFORM resolve_game_session_bets(
            NEW.game_session_id, 
            NEW.crash_point
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to manage game session status transitions
CREATE TRIGGER game_session_status_transition
    BEFORE UPDATE ON game_sessions
    FOR EACH ROW
    EXECUTE FUNCTION manage_game_session_status();

-- Drop all versions of the function to clean up - enhanced with unknown types
DROP FUNCTION IF EXISTS place_bet(uuid, numeric, uuid, numeric);
DROP FUNCTION IF EXISTS place_bet(uuid, numeric, uuid);
DROP FUNCTION IF EXISTS place_bet(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS place_bet(uuid, numeric);
DROP FUNCTION IF EXISTS place_bet(unknown, unknown, unknown, unknown);

-- Recreate the function with a clear signature and always set status to pending
CREATE OR REPLACE FUNCTION place_bet(
    p_user_id uuid,
    p_bet_amount numeric,
    p_game_session_id uuid DEFAULT NULL,
    p_autocashout_multiplier numeric DEFAULT NULL
)
RETURNS uuid AS $$
DECLARE
    v_bet_id uuid;
    v_wallet_balance numeric;
BEGIN
    -- Check wallet balance
    SELECT balance INTO v_wallet_balance
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF v_wallet_balance IS NULL OR v_wallet_balance < p_bet_amount THEN
        RAISE EXCEPTION 'Insufficient balance';
    END IF;
    
    -- Deduct bet amount from wallet
    UPDATE wallets 
    SET balance = balance - p_bet_amount
    WHERE user_id = p_user_id;
    
    -- IMPORTANT: Always create bet with NULL game_session_id
    -- We don't try to find a current session anymore
    
    -- Create bet record
    INSERT INTO player_bets (
        user_id, 
        bet_amount, 
        game_session_id,
        status,
        autocashout_multiplier,
        bet_type
    )
    VALUES (
        p_user_id, 
        p_bet_amount, 
        NULL, -- Always NULL regardless of what was passed
        'pending', -- Always pending
        p_autocashout_multiplier,
        CASE 
            WHEN p_autocashout_multiplier IS NOT NULL THEN 'auto'
            ELSE 'manual'
        END
    )
    RETURNING bet_id INTO v_bet_id;
    
    -- Return the created bet ID
    RETURN v_bet_id;
END;
$$ LANGUAGE plpgsql;

-- Function to activate all pending bets for the current in_progress game session
CREATE OR REPLACE FUNCTION activate_pending_bets_with_redis() RETURNS TABLE (
    bet_id UUID,
    user_id UUID,
    bet_amount DECIMAL(10, 2),
    autocashout_multiplier DECIMAL(10, 2),
    game_session_id UUID
) AS $$
DECLARE
    v_game_session_id UUID;
    v_activated_count INTEGER;
BEGIN
    -- Find the current in_progress game session
    SELECT game_session_id INTO v_game_session_id 
    FROM game_sessions 
    WHERE status = 'in_progress' 
    ORDER BY created_at DESC
    LIMIT 1;

    -- If no in_progress session exists, raise an exception
    IF v_game_session_id IS NULL THEN
        RAISE EXCEPTION 'No in_progress game session found';
    END IF;

    -- Assign game session and activate pending bets
    UPDATE player_bets
    SET 
        game_session_id = v_game_session_id,
        status = 'active'
    WHERE status = 'pending'
      AND (game_session_id IS NULL OR game_session_id = v_game_session_id);

    GET DIAGNOSTICS v_activated_count = ROW_COUNT;

    -- Return activated bets for Redis push
    RETURN QUERY 
    SELECT 
        pb.bet_id, 
        pb.user_id, 
        pb.bet_amount, 
        COALESCE(pb.autocashout_multiplier, 0) AS autocashout_multiplier,
        v_game_session_id
    FROM player_bets pb
    WHERE pb.game_session_id = v_game_session_id
      AND pb.status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Drop existing function if exists
DROP FUNCTION IF EXISTS auto_resolve_active_bets() CASCADE;

-- Function to automatically resolve active bets when game session completes
CREATE OR REPLACE FUNCTION auto_resolve_active_bets() RETURNS TRIGGER AS $$
DECLARE
    v_crash_point NUMERIC(5, 2);
BEGIN
    -- Only proceed if we're transitioning from in_progress to completed
    IF NEW.status = 'completed'::game_status AND OLD.status = 'in_progress'::game_status THEN
        -- Get the crash point
        v_crash_point := NEW.crash_point;
        
        -- Update active bets to won/lost based on payout and multipliers
        UPDATE player_bets
        SET
            status = CASE
                -- Check payout first (set by backend during cashout)
                WHEN payout_amount > 0 THEN 'won'::bet_status
                -- Check manual cashout
                WHEN cashout_multiplier IS NOT NULL AND cashout_multiplier > 1.00 THEN 'won'::bet_status
                -- Check auto cashout against crash point
                WHEN autocashout_multiplier IS NOT NULL AND
                     v_crash_point >= autocashout_multiplier
                THEN 'won'::bet_status
                -- Otherwise lost
                ELSE 'lost'::bet_status
            END,
            payout_amount = CASE
                WHEN payout_amount > 0 THEN payout_amount
                WHEN cashout_multiplier IS NOT NULL AND cashout_multiplier <= v_crash_point
                THEN bet_amount * cashout_multiplier
                WHEN autocashout_multiplier IS NOT NULL AND v_crash_point >= autocashout_multiplier
                THEN bet_amount * autocashout_multiplier
                ELSE 0
            END
        WHERE
            status = 'active'::bet_status
            AND game_session_id = NEW.game_session_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to resolve active bets when game session completes
CREATE TRIGGER resolve_active_bets_on_game_end
    AFTER UPDATE ON game_sessions
    FOR EACH ROW
    WHEN (OLD.status = 'in_progress' AND NEW.status = 'completed')
    EXECUTE FUNCTION auto_resolve_active_bets();

-- Remove the update_player_bets_modtime trigger and function
DROP TRIGGER IF EXISTS update_player_bets_modtime ON player_bets;
DROP FUNCTION IF EXISTS update_player_bets_modtime();

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

-- Debug trigger function to log when each trigger fires
CREATE OR REPLACE FUNCTION log_trigger_execution() RETURNS TRIGGER AS $$
BEGIN
    RAISE NOTICE 'Trigger % executed on % for row %', TG_NAME, TG_TABLE_NAME, NEW;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Remove triggers that monitor game_sessions from the player_bets file
DROP TRIGGER IF EXISTS activate_pending_bets_on_game_start ON game_sessions;
DROP TRIGGER IF EXISTS assign_pending_bets_on_session_create ON game_sessions;
DROP TRIGGER IF EXISTS debug_assign_pending_bets ON game_sessions;
DROP TRIGGER IF EXISTS debug_activate_pending_bets ON game_sessions;

-- First check what columns actually exist
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'player_bets';
