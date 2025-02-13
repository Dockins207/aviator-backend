-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create bet status enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bet_status') THEN
        CREATE TYPE bet_status AS ENUM ('placed', 'won', 'lost', 'cashout');
    END IF;
END $$;

-- Create player_bets table
CREATE TABLE player_bets (
    player_bet_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    game_session_id UUID NOT NULL REFERENCES game_sessions(game_session_id) ON DELETE CASCADE,
    bet_amount DECIMAL(10, 2) NOT NULL CHECK (bet_amount > 0),
    cashout_multiplier DECIMAL(10, 2) CHECK (
        (status = 'cashout' AND cashout_multiplier > 1) OR 
        (status != 'cashout' AND cashout_multiplier IS NULL)
    ),
    status bet_status DEFAULT 'placed',
    payout_amount DECIMAL(10, 2) CHECK (payout_amount >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for faster queries
CREATE INDEX idx_player_bets_user ON player_bets(user_id);
CREATE INDEX idx_player_bets_game_session ON player_bets(game_session_id);
CREATE INDEX idx_player_bets_status ON player_bets(status);

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
