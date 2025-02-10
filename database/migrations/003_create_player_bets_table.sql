-- Create player_bets table
CREATE TYPE bet_status AS ENUM ('placed', 'won', 'lost', 'cashout');

CREATE TABLE player_bets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    game_session_id INTEGER REFERENCES game_sessions(id) ON DELETE CASCADE,
    bet_amount DECIMAL(10, 2) NOT NULL,
    cashout_multiplier DECIMAL(10, 2),
    status bet_status DEFAULT 'placed',
    payout_amount DECIMAL(10, 2),
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
$$ language 'plpgsql';

CREATE TRIGGER update_player_bets_modtime
BEFORE UPDATE ON player_bets
FOR EACH ROW
EXECUTE FUNCTION update_player_bets_modtime();
