-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create required enum types
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

-- Clean up any existing versions of ALL functions to ensure clean slate
DROP FUNCTION IF EXISTS process_cashout(uuid, uuid, decimal);
DROP FUNCTION IF EXISTS cashout_bet(uuid, uuid, decimal);
DROP FUNCTION IF EXISTS get_user_active_bets(uuid);
DROP FUNCTION IF EXISTS can_cashout_bet(uuid, uuid);
DROP FUNCTION IF EXISTS get_cashout_status(uuid, uuid);
DROP FUNCTION IF EXISTS get_active_bets_for_redis(uuid);
DROP FUNCTION IF EXISTS auto_activate_pending_bets();
DROP FUNCTION IF EXISTS check_user_bet_limit();
DROP FUNCTION IF EXISTS resolve_game_session_bets(uuid, decimal);
DROP FUNCTION IF EXISTS manage_game_session_status();
DROP FUNCTION IF EXISTS place_bet(uuid, numeric, uuid, numeric);
DROP FUNCTION IF EXISTS place_bet(uuid, numeric, uuid);
DROP FUNCTION IF EXISTS place_bet(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS place_bet(uuid, numeric);
DROP FUNCTION IF EXISTS place_bet(unknown, unknown, unknown, unknown);
DROP FUNCTION IF EXISTS activate_pending_bets_with_redis();
DROP FUNCTION IF EXISTS auto_resolve_active_bets();
DROP FUNCTION IF EXISTS assign_pending_bets_to_new_session();
DROP FUNCTION IF EXISTS log_trigger_execution();
DROP FUNCTION IF EXISTS update_player_bets_modtime();

-- Remove triggers that may conflict
DROP TRIGGER IF EXISTS update_player_bets_modtime ON player_bets;
DROP TRIGGER IF EXISTS activate_pending_bets_on_game_start ON game_sessions;
DROP TRIGGER IF EXISTS assign_pending_bets_on_session_create ON game_sessions;
DROP TRIGGER IF EXISTS debug_assign_pending_bets ON game_sessions;
DROP TRIGGER IF EXISTS debug_activate_pending_bets ON game_sessions;
DROP TRIGGER IF EXISTS enforce_bet_limit ON player_bets;
DROP TRIGGER IF EXISTS game_session_status_transition ON game_sessions;
DROP TRIGGER IF EXISTS resolve_active_bets_on_game_end ON game_sessions;

-- =====================================================
-- CASHOUT-RELATED FUNCTIONS
-- =====================================================

-- Main cashout processing function with comprehensive validation
CREATE OR REPLACE FUNCTION process_cashout(
    p_user_id UUID,
    p_bet_id UUID,
    p_cashout_multiplier DECIMAL(10, 2)
) RETURNS TABLE (
    success BOOLEAN,
    payout_amount DECIMAL(10, 2),
    message TEXT
) AS $$
DECLARE
    v_bet RECORD;
    v_game_session RECORD;
    v_payout DECIMAL(10, 2);
BEGIN
    -- Parameter validation
    IF p_cashout_multiplier IS NULL OR p_cashout_multiplier <= 1 THEN
        RETURN QUERY SELECT false, 0::DECIMAL(10,2), 'Cashout multiplier must be greater than 1';
        RETURN;
    END IF;

    -- Verify bet exists and belongs to user (with row locking)
    SELECT * INTO v_bet
    FROM player_bets
    WHERE bet_id = p_bet_id
    AND user_id = p_user_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 0::DECIMAL(10,2), 'Bet not found or does not belong to user';
        RETURN;
    END IF;
    
    -- Ensure bet is active
    IF v_bet.status != 'active' THEN
        RETURN QUERY SELECT false, 0::DECIMAL(10,2), 
            'Bet is not active (current status: ' || v_bet.status || ')';
        RETURN;
    END IF;
    
    -- Check that the game session is in progress
    SELECT * INTO v_game_session
    FROM game_sessions
    WHERE game_session_id = v_bet.game_session_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 0::DECIMAL(10,2), 'Game session not found';
        RETURN;
    END IF;

    IF v_game_session.status != 'in_progress' THEN
        RETURN QUERY SELECT false, 0::DECIMAL(10,2), 
            'Game session is not in progress (current status: ' || v_game_session.status || ')';
        RETURN;
    END IF;
    
    -- Calculate payout with rounding to 2 decimal places
    v_payout := ROUND((v_bet.bet_amount * p_cashout_multiplier)::numeric, 2);
    
    -- Process transaction as an atomic operation
    BEGIN
        -- Update bet with cashout information
        UPDATE player_bets
        SET 
            status = 'won',
            cashout_multiplier = p_cashout_multiplier,
            payout_amount = v_payout
        WHERE bet_id = p_bet_id;
        
        -- Credit user wallet - handle last_updated column gracefully if it exists
        UPDATE wallets
        SET 
            balance = balance + v_payout,
            last_updated = CASE 
                WHEN EXISTS (SELECT 1 FROM information_schema.columns 
                             WHERE table_name = 'wallets' AND column_name = 'last_updated')
                THEN NOW()
                ELSE last_updated
            END
        WHERE user_id = p_user_id;
        
        -- Try to record the transaction in wallet_transactions if table exists
        BEGIN
            INSERT INTO wallet_transactions (
                user_id, 
                amount, 
                transaction_type, 
                reference_id, 
                description
            )
            VALUES (
                p_user_id, 
                v_payout, 
                'credit', 
                p_bet_id, 
                'Game cashout at ' || p_cashout_multiplier || 'x'
            );
        EXCEPTION WHEN undefined_table THEN
            -- Table doesn't exist, skip recording transaction
            NULL;
        END;
        
        -- Return success info
        RETURN QUERY SELECT true, v_payout, 'Cashout processed successfully at ' || p_cashout_multiplier || 'x multiplier';
        
    EXCEPTION WHEN OTHERS THEN
        -- On error, return failure
        RETURN QUERY SELECT false, 0::DECIMAL(10,2), 'Error processing cashout: ' || SQLERRM;
    END;
END;
$$ LANGUAGE plpgsql;

-- Front-end API function for cashout (returns JSON response)
CREATE OR REPLACE FUNCTION cashout_bet(
    p_user_id UUID,
    p_bet_id UUID,
    p_current_multiplier DECIMAL(10, 2)
) RETURNS JSON AS $$
DECLARE
    result RECORD;
BEGIN
    -- Process the cashout and return result as JSON
    SELECT * INTO result FROM process_cashout(p_user_id, p_bet_id, p_current_multiplier);
    
    RETURN json_build_object(
        'success', result.success,
        'payout_amount', result.payout_amount,
        'message', result.message
    );
END;
$$ LANGUAGE plpgsql;

-- Helper function to get a user's active bets
CREATE OR REPLACE FUNCTION get_user_active_bets(p_user_id UUID) 
RETURNS TABLE (
    bet_id UUID,
    bet_amount DECIMAL(10, 2),
    game_session_id UUID,
    status TEXT,
    autocashout_multiplier DECIMAL(10, 2)
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pb.bet_id,
        pb.bet_amount,
        pb.game_session_id,
        pb.status::TEXT,
        pb.autocashout_multiplier
    FROM 
        player_bets pb
        JOIN game_sessions gs ON pb.game_session_id = gs.game_session_id
    WHERE 
        pb.user_id = p_user_id 
        AND pb.status = 'active'
        AND gs.status = 'in_progress';
END;
$$ LANGUAGE plpgsql;

-- Quick validation function to check if a bet can be cashed out
CREATE OR REPLACE FUNCTION can_cashout_bet(
    p_user_id UUID,
    p_bet_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    v_bet RECORD;
    v_game_session RECORD;
BEGIN
    -- Check if bet exists and belongs to user
    SELECT * INTO v_bet
    FROM player_bets
    WHERE bet_id = p_bet_id
    AND user_id = p_user_id;
    
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Check if bet is active
    IF v_bet.status != 'active' THEN
        RETURN FALSE;
    END IF;
    
    -- Check if game session is in progress
    SELECT * INTO v_game_session
    FROM game_sessions
    WHERE game_session_id = v_bet.game_session_id;
    
    IF NOT FOUND OR v_game_session.status != 'in_progress' THEN
        RETURN FALSE;
    END IF;
    
    -- All checks passed
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Detailed function to get cashout status with reason
CREATE OR REPLACE FUNCTION get_cashout_status(
    p_user_id UUID,
    p_bet_id UUID
) RETURNS JSON AS $$
DECLARE
    v_bet RECORD;
    v_game_session RECORD;
    v_error TEXT;
BEGIN
    -- Check if bet exists and belongs to user
    SELECT * INTO v_bet
    FROM player_bets
    WHERE bet_id = p_bet_id;
    
    IF NOT FOUND THEN
        v_error := 'Bet not found';
        RETURN json_build_object('can_cashout', FALSE, 'reason', v_error);
    END IF;
    
    IF v_bet.user_id != p_user_id THEN
        v_error := 'Bet does not belong to user';
        RETURN json_build_object('can_cashout', FALSE, 'reason', v_error);
    END IF;
    
    -- Check if bet is active
    IF v_bet.status != 'active' THEN
        v_error := 'Bet is not active (status: ' || v_bet.status || ')';
        RETURN json_build_object('can_cashout', FALSE, 'reason', v_error);
    END IF;
    
    -- Check if game session is in progress
    SELECT * INTO v_game_session
    FROM game_sessions
    WHERE game_session_id = v_bet.game_session_id;
    
    IF NOT FOUND THEN
        v_error := 'Game session not found';
        RETURN json_build_object('can_cashout', FALSE, 'reason', v_error);
    END IF;
    
    IF v_game_session.status != 'in_progress' THEN
        v_error := 'Game session is not in progress (status: ' || v_game_session.status || ')';
        RETURN json_build_object('can_cashout', FALSE, 'reason', v_error);
    END IF;
    
    -- All checks passed
    RETURN json_build_object('can_cashout', TRUE);
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- BET MANAGEMENT FUNCTIONS
-- =====================================================

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

-- Function to assign pending bets to new game sessions 
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

-- =====================================================
-- CREATE TRIGGERS
-- =====================================================

-- Trigger to enforce bet limit
CREATE TRIGGER enforce_bet_limit
BEFORE INSERT ON player_bets
FOR EACH ROW
EXECUTE FUNCTION check_user_bet_limit();

-- Trigger to manage game session status transitions
CREATE TRIGGER game_session_status_transition
    BEFORE UPDATE ON game_sessions
    FOR EACH ROW
    EXECUTE FUNCTION manage_game_session_status();

-- Trigger to resolve active bets when game session completes
CREATE TRIGGER resolve_active_bets_on_game_end
    AFTER UPDATE ON game_sessions
    FOR EACH ROW
    WHEN (OLD.status = 'in_progress' AND NEW.status = 'completed')
    EXECUTE FUNCTION auto_resolve_active_bets();
