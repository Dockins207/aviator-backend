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
END $$;

-- Drop existing constraints and sequence if they exist
DROP SEQUENCE IF EXISTS bet_id_seq;
ALTER TABLE player_bets DROP CONSTRAINT IF EXISTS player_bets_bet_id_key;

-- Create a new sequence for bet_id
CREATE SEQUENCE bet_id_seq START 1;

-- Create a temporary table to preserve existing data
CREATE TEMPORARY TABLE temp_player_bets AS 
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
DROP TABLE player_bets;

-- Recreate the table with BIGINT bet_id
CREATE TABLE player_bets (
    bet_id BIGINT PRIMARY KEY DEFAULT nextval('bet_id_seq'),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    game_session_id UUID NOT NULL REFERENCES game_sessions(game_session_id) ON DELETE CASCADE,
    bet_amount DECIMAL(10, 2) NOT NULL CHECK (bet_amount >= 10),
    cashout_multiplier DECIMAL(10, 2),
    status bet_status DEFAULT 'pending',
    payout_amount DECIMAL(10, 2) CHECK (payout_amount >= 0),
    autocashout_multiplier DECIMAL(10, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Restore data with new bet_id sequence
INSERT INTO player_bets (
    user_id, 
    game_session_id, 
    bet_amount, 
    cashout_multiplier, 
    status, 
    payout_amount, 
    autocashout_multiplier, 
    created_at
)
SELECT 
    user_id, 
    game_session_id, 
    bet_amount, 
    cashout_multiplier, 
    status, 
    payout_amount, 
    autocashout_multiplier, 
    created_at 
FROM temp_player_bets;

-- Drop the temporary table
DROP TABLE temp_player_bets;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_player_bets_user ON player_bets(user_id);
CREATE INDEX IF NOT EXISTS idx_player_bets_game_session ON player_bets(game_session_id);
CREATE INDEX IF NOT EXISTS idx_player_bets_status ON player_bets(status);

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

-- Function to place a new bet
CREATE OR REPLACE FUNCTION place_bet(
    p_user_id UUID,
    p_game_session_id UUID,
    p_bet_amount DECIMAL(10, 2),
    p_autocashout_multiplier DECIMAL(10, 2) DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    v_bet_id BIGINT;
BEGIN
    -- Insert the bet with 'pending' status, letting the sequence generate bet_id
    INSERT INTO player_bets (
        user_id, 
        game_session_id, 
        bet_amount, 
        status, 
        autocashout_multiplier
    ) VALUES (
        p_user_id,
        p_game_session_id,
        p_bet_amount,
        'pending',
        p_autocashout_multiplier
    ) RETURNING bet_id INTO v_bet_id;
    
    RETURN v_bet_id;
END;
$$ LANGUAGE plpgsql;

-- Function to update bet status with state transition validation
CREATE OR REPLACE FUNCTION update_bet_status(
    p_bet_id BIGINT, 
    p_new_status bet_status
) RETURNS VOID AS $$
DECLARE
    v_current_status bet_status;
BEGIN
    -- Get current status
    SELECT status INTO v_current_status 
    FROM player_bets 
    WHERE bet_id = p_bet_id;

    -- Validate state transitions
    IF v_current_status IS NULL THEN
        RAISE EXCEPTION 'Bet with ID % not found', p_bet_id;
    END IF;

    -- State transition rules
    CASE 
        WHEN v_current_status = 'pending' AND p_new_status = 'active' THEN
            UPDATE player_bets 
            SET status = p_new_status 
            WHERE bet_id = p_bet_id;
        
        WHEN v_current_status = 'active' AND p_new_status IN ('won', 'lost') THEN
            UPDATE player_bets 
            SET 
                status = p_new_status,
                payout_amount = CASE 
                    WHEN p_new_status = 'won' THEN bet_amount * cashout_multiplier 
                    ELSE 0 
                END
            WHERE bet_id = p_bet_id;
        
        ELSE
            RAISE EXCEPTION 'Invalid status transition from % to %', v_current_status, p_new_status;
    END CASE;
END;
$$ LANGUAGE plpgsql;

-- Function to activate all pending bets for a game session and push to Redis
CREATE OR REPLACE FUNCTION activate_pending_bets_with_redis(
    p_game_session_id UUID
) RETURNS TABLE (
    bet_id BIGINT,
    user_id UUID,
    bet_amount DECIMAL(10, 2),
    autocashout_multiplier DECIMAL(10, 2)
) AS $$
DECLARE
    v_activated_count INTEGER;
BEGIN
    -- Activate all pending bets for the specified game session
    UPDATE player_bets
    SET status = 'active'
    WHERE game_session_id = p_game_session_id
      AND status = 'pending';
    
    GET DIAGNOSTICS v_activated_count = ROW_COUNT;

    -- Return active bets for Redis push
    RETURN QUERY 
    SELECT 
        bet_id, 
        user_id, 
        bet_amount, 
        COALESCE(autocashout_multiplier, 0) AS autocashout_multiplier
    FROM player_bets
    WHERE game_session_id = p_game_session_id
      AND status = 'active';
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
        status = CASE 
            WHEN pb.cashout_multiplier IS NOT NULL AND pb.cashout_multiplier <= p_final_crash_point THEN 'won'
            ELSE 'lost'
        END,
        payout_amount = CASE 
            WHEN pb.cashout_multiplier IS NOT NULL AND pb.cashout_multiplier <= p_final_crash_point 
            THEN pb.bet_amount * pb.cashout_multiplier
            ELSE 0
        END
    WHERE pb.game_session_id = p_game_session_id
      AND pb.status = 'active';

    -- Count and calculate totals
    SELECT 
        COUNT(CASE WHEN status = 'won' THEN 1 END),
        COUNT(CASE WHEN status = 'lost' THEN 1 END),
        COALESCE(SUM(CASE WHEN status = 'won' THEN payout_amount ELSE 0 END), 0)
    INTO 
        v_total_won_bets, 
        v_total_lost_bets, 
        v_total_winnings
    FROM player_bets
    WHERE game_session_id = p_game_session_id;

    -- Return the results
    RETURN QUERY 
    SELECT v_total_won_bets, v_total_lost_bets, v_total_winnings;
END;
$$ LANGUAGE plpgsql;

-- Remove the update_player_bets_modtime trigger and function
DROP TRIGGER IF EXISTS update_player_bets_modtime ON player_bets;
DROP FUNCTION IF EXISTS update_player_bets_modtime();
