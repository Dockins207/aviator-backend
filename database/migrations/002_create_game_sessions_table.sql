-- Create game_sessions table
CREATE TYPE game_status AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');
CREATE TYPE game_type AS ENUM ('aviator', 'crash', 'roulette');

CREATE TABLE game_sessions (
    id SERIAL PRIMARY KEY,
    game_type game_type NOT NULL,
    status game_status DEFAULT 'pending',
    start_multiplier DECIMAL(10, 2) DEFAULT 1.00,
    current_multiplier DECIMAL(10, 2) DEFAULT 1.00,
    max_multiplier DECIMAL(10, 2),
    total_bet_amount DECIMAL(10, 2) DEFAULT 0.00,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE,
    server_seed VARCHAR(255),
    client_seed VARCHAR(255)
);

-- Create index for faster game type lookups
CREATE INDEX idx_game_sessions_type ON game_sessions(game_type);
CREATE INDEX idx_game_sessions_status ON game_sessions(status);
