-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- SEQUENCES
-- =============================================
-- Create sequence for user IDs starting at 100000 to ensure 6 digits
CREATE SEQUENCE IF NOT EXISTS user_id_seq START WITH 100000;
-- Create sequence for user counter starting at 1
CREATE SEQUENCE IF NOT EXISTS usr_cnt_seq START WITH 1;
-- Create sequence for wallet counter starting at 1
CREATE SEQUENCE IF NOT EXISTS wlt_cnt_seq START WITH 1;
-- Create sequence for game result IDs starting at 100000 to ensure 6 digits
CREATE SEQUENCE IF NOT EXISTS result_id_seq START WITH 100000;
-- Create sequence for game result counter starting at 1
CREATE SEQUENCE IF NOT EXISTS res_cnt_seq START WITH 1;

-- =============================================
-- ENUM TYPE DEFINITIONS
-- =============================================

-- User-related enums
CREATE TYPE user_role AS ENUM ('player', 'admin');
CREATE TYPE verification_status AS ENUM ('unverified', 'pending', 'verified');

-- Game-related enums
CREATE TYPE game_type AS ENUM ('aviator');
CREATE TYPE game_status AS ENUM ('betting', 'in_progress', 'completed');
CREATE TYPE bet_status AS ENUM ('pending', 'active', 'won', 'lost');
CREATE TYPE bet_type AS ENUM ('manual_cashout', 'auto_cashout', 'full_auto');

-- =============================================
-- TABLE DEFINITIONS
-- =============================================

-- =============================================
-- USERS TABLE - Core identity data that rarely changes
-- =============================================
CREATE TABLE users (
    _cnt INTEGER NOT NULL DEFAULT nextval('usr_cnt_seq'), -- Internal counter
    user_id INTEGER PRIMARY KEY NOT NULL DEFAULT nextval('user_id_seq'),
    username VARCHAR(50) NOT NULL UNIQUE,
    phone VARCHAR(15) NOT NULL UNIQUE,
    pwd_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(50) NOT NULL,
    role user_role DEFAULT 'player',
    ref_code VARCHAR(20) UNIQUE,
    ref_by INTEGER REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT six_digit_user_id CHECK (user_id BETWEEN 100000 AND 999999),
    CONSTRAINT unique_usr_cnt UNIQUE (_cnt)
);

-- =============================================
-- USER PROFILES TABLE - Data that changes more frequently
-- =============================================
CREATE TABLE user_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    profile_picture_url TEXT,
    ver_status verification_status DEFAULT 'unverified',
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP WITH TIME ZONE,
    last_pwd_change TIMESTAMP WITH TIME ZONE,
    preferences JSONB,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- GAME SESSIONS TABLE
-- =============================================
CREATE TABLE game_sessions (
    game_session_id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
    game_type game_type NOT NULL,
    status game_status DEFAULT 'betting' NOT NULL,
    crash_point numeric(5,2),
    ended_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- PLAYER BETS TABLE
-- =============================================
CREATE TABLE player_bets (
    bet_id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
    reference_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    game_session_id UUID NULL REFERENCES game_sessions(game_session_id) ON DELETE CASCADE,
    bet_amount DECIMAL(10, 2) NOT NULL CHECK (bet_amount >= 10),
    cashout_multiplier DECIMAL(10, 2),
    status bet_status DEFAULT 'pending',
    payout_amount DECIMAL(10, 2) CHECK (payout_amount >= 0),
    autocashout_multiplier DECIMAL(10, 2),
    bet_type bet_type DEFAULT 'manual_cashout',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- WALLETS TABLE
-- =============================================
CREATE TABLE wallets (
    _cnt INTEGER NOT NULL DEFAULT nextval('wlt_cnt_seq'), -- Internal counter
    wallet_id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
    reference_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    balance DECIMAL(15, 2) DEFAULT 0.00 CHECK (balance >= 0.00),
    currency VARCHAR(3) DEFAULT 'KSH',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_wlt_cnt UNIQUE (_cnt)
);

-- =============================================
-- WALLET TRANSACTIONS TABLE
-- =============================================
CREATE TABLE wallet_transactions (
    transaction_id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
    user_id INTEGER NOT NULL REFERENCES users(user_id),
    wallet_id UUID NOT NULL REFERENCES wallets(wallet_id),
    amount DECIMAL(15, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'KSH',
    transaction_type VARCHAR(50) NOT NULL, -- deposit, withdrawal, bet, win, loss
    description TEXT,
    payment_method VARCHAR(50),
    status VARCHAR(20) DEFAULT 'completed',
    reference_id UUID NULL, -- Optional reference to other entities like bets
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- GROUP CHATS TABLE
-- =============================================
CREATE TABLE group_chats (
    id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
    sender_id INTEGER,
    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    name VARCHAR(255),
    integrity_hash VARCHAR(64),
    type VARCHAR(50) DEFAULT 'default',
    status VARCHAR(50) DEFAULT 'active',
    created_by INTEGER,
    is_default BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    description TEXT,
    
    CONSTRAINT fk_group_chats_sender FOREIGN KEY (sender_id) REFERENCES users(user_id),
    CONSTRAINT fk_group_chats_created_by FOREIGN KEY (created_by) REFERENCES users(user_id)
);

-- =============================================
-- GAME RESULTS TABLE
-- =============================================
CREATE TABLE game_results (
    _cnt INTEGER NOT NULL DEFAULT nextval('res_cnt_seq'), -- Internal counter
    result_id INTEGER NOT NULL DEFAULT nextval('result_id_seq'),
    session_id UUID NOT NULL REFERENCES game_sessions(game_session_id) ON DELETE CASCADE,
    total_bets INTEGER NOT NULL DEFAULT 0,
    total_bet_amount DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    total_wins INTEGER NOT NULL DEFAULT 0,
    total_losses INTEGER NOT NULL DEFAULT 0,
    total_payout_amount DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT pk_game_results PRIMARY KEY (result_id),
    CONSTRAINT unique_game_result_session UNIQUE (session_id),
    CONSTRAINT unique_res_cnt UNIQUE (_cnt),
    CONSTRAINT six_digit_result_id CHECK (result_id BETWEEN 100000 AND 999999)
);

-- =============================================
-- MIGRATIONS TABLE
-- =============================================
CREATE TABLE migrations (
    id SERIAL PRIMARY KEY,
    migration_name VARCHAR(255) NOT NULL UNIQUE,
    migration_file VARCHAR(255) NOT NULL,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'success',
    notes TEXT,
    created_by VARCHAR(100),
    execution_time INTEGER -- time in milliseconds
);

-- Create index for migrations table
CREATE INDEX idx_migrations_name ON migrations(migration_name);
CREATE INDEX idx_migrations_status ON migrations(status);
CREATE INDEX idx_migrations_applied_at ON migrations(applied_at);

-- =============================================
-- INDEXES
-- =============================================

-- User indexes
CREATE INDEX idx_users_id ON users(user_id);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_referral ON users(ref_code);

-- User profiles indexes
CREATE INDEX idx_user_profiles_status ON user_profiles(ver_status);
CREATE INDEX idx_user_profiles_active ON user_profiles(is_active);
CREATE INDEX idx_user_profiles_updated ON user_profiles(updated_at);

-- Game sessions indexes
CREATE INDEX idx_game_sessions_id ON game_sessions(game_session_id);
CREATE INDEX idx_game_sessions_type ON game_sessions(game_type);
CREATE INDEX idx_game_sessions_status ON game_sessions(status);
CREATE INDEX idx_game_sessions_created_at ON game_sessions(created_at);

-- Player bets indexes
CREATE INDEX idx_player_bets_id ON player_bets(bet_id);
CREATE INDEX idx_player_bets_user ON player_bets(user_id);
CREATE INDEX idx_player_bets_game_session ON player_bets(game_session_id);
CREATE INDEX idx_player_bets_status ON player_bets(status);
CREATE INDEX idx_player_bets_bet_type ON player_bets(bet_type);
CREATE INDEX idx_player_bets_reference ON player_bets(reference_id);

-- Wallet indexes
CREATE INDEX idx_wallets_id ON wallets(wallet_id);
CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_wallets_reference ON wallets(reference_id);

-- Wallet transactions indexes
CREATE INDEX idx_wallet_transactions_id ON wallet_transactions(transaction_id);
CREATE INDEX idx_wallet_transactions_user ON wallet_transactions(user_id);
CREATE INDEX idx_wallet_transactions_wallet ON wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_transactions_type ON wallet_transactions(transaction_type);

-- Group chats indexes
CREATE INDEX idx_group_chats_id ON group_chats(id);
CREATE INDEX idx_group_chats_sender ON group_chats(sender_id);
CREATE INDEX idx_group_chats_created_at ON group_chats(created_at);
CREATE INDEX idx_group_chats_name ON group_chats(name);
CREATE INDEX idx_group_chats_type ON group_chats(type);
CREATE INDEX idx_group_chats_status ON group_chats(status);

-- Game results indexes
CREATE INDEX idx_game_results_id ON game_results(result_id);
CREATE INDEX idx_game_results_cnt ON game_results(_cnt);
CREATE INDEX idx_game_results_session ON game_results(session_id);
CREATE INDEX idx_game_results_created_at ON game_results(created_at);

-- =============================================
-- FUNCTIONS AND COMMENTS ON ID GENERATION
-- =============================================

-- Add comments to document ID generation strategy
COMMENT ON COLUMN users.user_id IS 'Database-generated 6-digit sequential ID';
COMMENT ON COLUMN users._cnt IS 'Internal database counter (not for application use)';
COMMENT ON COLUMN users.phone IS 'User phone number for authentication';
COMMENT ON COLUMN users.pwd_hash IS 'Hashed user password';
COMMENT ON COLUMN users.ref_code IS 'Unique referral code for the user';
COMMENT ON COLUMN users.ref_by IS 'ID of user who referred this user';
COMMENT ON COLUMN user_profiles.user_id IS 'References users table';
COMMENT ON COLUMN user_profiles.ver_status IS 'Account verification status';
COMMENT ON COLUMN user_profiles.is_active IS 'Whether account is active';
COMMENT ON COLUMN user_profiles.preferences IS 'JSON field for user preferences';
COMMENT ON COLUMN wallets.wallet_id IS 'Database-generated UUID';
COMMENT ON COLUMN wallets._cnt IS 'Internal database counter (not for application use)';
COMMENT ON COLUMN player_bets.bet_id IS 'Database-generated UUID';
COMMENT ON COLUMN player_bets.reference_id IS 'Database-generated UUID for external reference';
COMMENT ON COLUMN game_sessions.game_session_id IS 'Database-generated UUID';
COMMENT ON COLUMN game_results.result_id IS 'Database-generated 6-digit sequential ID';
COMMENT ON COLUMN game_results._cnt IS 'Internal database counter (not for application use)';
COMMENT ON COLUMN wallet_transactions.transaction_id IS 'Database-generated UUID';
COMMENT ON COLUMN group_chats.id IS 'Database-generated UUID';

-- Function to ensure user_id is a 6-digit number
CREATE OR REPLACE FUNCTION ensure_six_digit_user_id()
RETURNS TRIGGER AS $$
BEGIN
    -- If user_id is not provided or less than 100000, get next value from sequence
    IF NEW.user_id IS NULL OR NEW.user_id < 100000 THEN
        NEW.user_id := nextval('user_id_seq');
    END IF;
    
    -- Ensure it's in valid range
    IF NEW.user_id < 100000 OR NEW.user_id > 999999 THEN
        RAISE EXCEPTION 'User ID must be a 6-digit number between 100000 and 999999';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to enforce 6-digit user IDs
CREATE TRIGGER ensure_six_digit_user_id_trigger
BEFORE INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION ensure_six_digit_user_id();

-- Function to generate unique referral code
CREATE OR REPLACE FUNCTION generate_referral_code()
RETURNS TRIGGER AS $$
BEGIN
    -- Generate a unique 8-character referral code
    NEW.ref_code = UPPER(SUBSTRING(MD5(RANDOM()::text), 1, 8));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to generate referral code before insert
CREATE TRIGGER generate_user_referral_code
BEFORE INSERT ON users
FOR EACH ROW
WHEN (NEW.ref_code IS NULL)
EXECUTE FUNCTION generate_referral_code();

-- Function to ensure result_id is a 6-digit number
CREATE OR REPLACE FUNCTION ensure_six_digit_result_id()
RETURNS TRIGGER AS $$
BEGIN
    -- If result_id is not provided or less than 100000, get next value from sequence
    IF NEW.result_id IS NULL OR NEW.result_id < 100000 THEN
        NEW.result_id := nextval('result_id_seq');
    END IF;
    
    -- Ensure it's in valid range
    IF NEW.result_id < 100000 OR NEW.result_id > 999999 THEN
        RAISE EXCEPTION 'Result ID must be a 6-digit number between 100000 and 999999';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to enforce 6-digit result IDs
CREATE TRIGGER ensure_six_digit_result_id_trigger
BEFORE INSERT ON game_results
FOR EACH ROW
EXECUTE FUNCTION ensure_six_digit_result_id();