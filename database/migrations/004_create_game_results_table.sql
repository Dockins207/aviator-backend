-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create game_results table to store detailed game outcomes
CREATE TABLE game_results (
    game_result_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game_session_id UUID NOT NULL REFERENCES game_sessions(game_session_id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL,
    multiplier DECIMAL(10, 2) NOT NULL DEFAULT 1.00,
    crash_point DECIMAL(10, 2) NOT NULL DEFAULT 1.00,
    crash_point_history JSONB DEFAULT '[]'::JSONB,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster game session lookups
CREATE INDEX idx_game_results_game_session ON game_results(game_session_id);
CREATE INDEX idx_game_results_status ON game_results(status);

-- Trigger to update created_at column
CREATE OR REPLACE FUNCTION update_game_results_created_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.created_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_game_results_created_at
BEFORE UPDATE ON game_results
FOR EACH ROW
EXECUTE FUNCTION update_game_results_created_at();
