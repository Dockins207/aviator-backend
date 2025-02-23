-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create bet status enum if not exists
DO $$
DECLARE 
    v_type_exists boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bet_status') INTO v_type_exists;
    IF NOT v_type_exists THEN
        CREATE TYPE bet_status AS ENUM ('active', 'won', 'lost', 'placed');
    ELSE
        -- Alter existing type to add new values if needed
        BEGIN
            ALTER TYPE bet_status ADD VALUE IF NOT EXISTS 'active';
            ALTER TYPE bet_status ADD VALUE IF NOT EXISTS 'won';
            ALTER TYPE bet_status ADD VALUE IF NOT EXISTS 'lost';
            ALTER TYPE bet_status ADD VALUE IF NOT EXISTS 'placed';
        EXCEPTION WHEN OTHERS THEN
            -- Ignore if values already exist
            NULL;
        END;
    END IF;
END $$;

-- Bet Status Lifecycle:
-- 'placed': Initial state when bet is created
-- 'active': Bet is in progress, player can potentially cashout
-- 'won': Bet is successful, payout calculated
-- 'lost': Bet is unsuccessful, no payout

-- Create player_bets table if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'player_bets'
    ) THEN
        CREATE TABLE player_bets (
            player_bet_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            game_session_id UUID NOT NULL REFERENCES game_sessions(game_session_id) ON DELETE CASCADE,
            bet_id UUID NOT NULL UNIQUE,
            bet_amount DECIMAL(10, 2) NOT NULL CONSTRAINT player_bets_bet_amount_check CHECK (bet_amount >= 10),
            cashout_multiplier DECIMAL(10, 2),
            status bet_status DEFAULT 'placed',
            payout_amount DECIMAL(10, 2) CONSTRAINT player_bets_payout_amount_check CHECK (payout_amount >= 0),
            autocashout_multiplier DECIMAL(10, 2),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

-- Check if column exists before adding
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='player_bets' AND column_name='autocashout_multiplier'
    ) THEN
        ALTER TABLE player_bets 
        ADD COLUMN autocashout_multiplier DECIMAL(10, 2);
    END IF;
END $$;

-- Remove existing constraints
DO $$
BEGIN
    -- Drop existing check constraints
    BEGIN
        ALTER TABLE player_bets 
        DROP CONSTRAINT IF EXISTS player_bets_cashout_multiplier_check;
    EXCEPTION WHEN OTHERS THEN
        -- Ignore if constraint doesn't exist
        NULL;
    END;

    BEGIN
        ALTER TABLE player_bets 
        DROP CONSTRAINT IF EXISTS player_bets_check;
    EXCEPTION WHEN OTHERS THEN
        -- Ignore if constraint doesn't exist
        NULL;
    END;
END $$;

-- Modify cashout_multiplier to be fully flexible
ALTER TABLE player_bets 
ALTER COLUMN cashout_multiplier DROP NOT NULL;

-- Indexes for performance
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM pg_indexes 
        WHERE tablename = 'player_bets' AND indexname = 'idx_player_bets_user'
    ) THEN
        CREATE INDEX idx_player_bets_user ON player_bets(user_id);
    END IF;

    IF NOT EXISTS (
        SELECT FROM pg_indexes 
        WHERE tablename = 'player_bets' AND indexname = 'idx_player_bets_game_session'
    ) THEN
        CREATE INDEX idx_player_bets_game_session ON player_bets(game_session_id);
    END IF;

    IF NOT EXISTS (
        SELECT FROM pg_indexes 
        WHERE tablename = 'player_bets' AND indexname = 'idx_player_bets_status'
    ) THEN
        CREATE INDEX idx_player_bets_status ON player_bets(status);
    END IF;
END $$;

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

-- Create a function to check bet limit
CREATE OR REPLACE FUNCTION check_user_bet_limit()
RETURNS TRIGGER AS $$
BEGIN
    -- Do not count bets with the same bet_id
    IF (
        SELECT COUNT(*) 
        FROM player_bets 
        WHERE user_id = NEW.user_id 
        AND game_session_id = NEW.game_session_id 
        AND status IN ('active', 'placed')
        AND bet_id != NEW.bet_id
    ) >= 2 THEN
        RAISE EXCEPTION 'User cannot place more than 2 bets in a game session';
    END IF;
 
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a trigger to enforce the bet limit before insert
CREATE TRIGGER enforce_bet_limit
BEFORE INSERT ON player_bets
FOR EACH ROW
EXECUTE FUNCTION check_user_bet_limit();
