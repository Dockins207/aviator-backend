-- =============================================
-- FUNCTIONS AND COMMENTS ON ID GENERATION
-- =============================================

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

-- =============================================
-- FUNCTIONS AND COMMENTS ON ID GENERATION
-- =============================================

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

-- =============================================
-- FUNCTIONS AND COMMENTS ON ID GENERATION
-- =============================================

-- Trigger to activate pending bets when game transitions to in_progress
CREATE TRIGGER activate_pending_bets_trigger
    AFTER UPDATE ON game_sessions
    FOR EACH ROW
    WHEN (OLD.status = 'betting' AND NEW.status = 'in_progress')
    EXECUTE FUNCTION auto_activate_pending_bets();

-- =============================================
-- FUNCTIONS AND COMMENTS ON ID GENERATION
-- =============================================

-- Trigger to resolve active bets when game session completes
CREATE TRIGGER resolve_active_bets_on_game_end
    AFTER UPDATE ON game_sessions
    FOR EACH ROW
    WHEN (OLD.status = 'in_progress' AND NEW.status = 'completed')
    EXECUTE FUNCTION auto_resolve_active_bets();
