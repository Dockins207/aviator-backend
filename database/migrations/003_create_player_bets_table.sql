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

-- Create player_bets table if not exists
CREATE TABLE IF NOT EXISTS player_bets 
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    game_session_id UUID NOT NULL REFERENCES game_sessions(game_session_id) ON DELETE CASCADE,
    bet_id UUID NOT NULL UNIQUE,
    bet_amount DECIMAL(10, 2) NOT NULL CHECK (bet_amount >= 10),
    cashout_multiplier DECIMAL(10, 2),
    status bet_status DEFAULT 'pending',
    payout_amount DECIMAL(10, 2) CHECK (payout_amount >= 0),
    autocashout_multiplier DECIMAL(10, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_player_bets_user ON player_bets(user_id);
CREATE INDEX IF NOT EXISTS idx_player_bets_game_session ON player_bets(game_session_id);
CREATE INDEX IF NOT EXISTS idx_player_bets_status ON player_bets(status);

-- Trigger to update updated_at column
CREATE OR REPLACE FUNCTION update_player_bets_modtime()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_player_bets_modtime
BEFORE UPDATE ON player_bets
FOR EACH ROW
EXECUTE FUNCTION update_player_bets_modtime();

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

-- Function to auto-update bet status based on game session progress
CREATE OR REPLACE FUNCTION auto_update_bet_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.game_session_status = 'started' THEN
        UPDATE player_bets SET status = 'active' WHERE game_session_id = NEW.game_session_id AND status = 'pending';
    ELSIF NEW.game_session_status = 'ended' THEN
        UPDATE player_bets SET status = 'lost' WHERE game_session_id = NEW.game_session_id AND status = 'active';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bet_status_trigger
AFTER UPDATE ON game_sessions
FOR EACH ROW
EXECUTE FUNCTION auto_update_bet_status();
