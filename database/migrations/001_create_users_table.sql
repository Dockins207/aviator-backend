-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create user roles enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('player', 'admin', 'support', 'moderator');
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_status') THEN
        CREATE TYPE verification_status AS ENUM ('unverified', 'pending', 'verified');
    END IF;
END $$;

-- Create users table
CREATE TABLE users (
    user_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(50) NOT NULL,
    role user_role DEFAULT 'player',
    verification_status verification_status DEFAULT 'unverified',
    is_active BOOLEAN DEFAULT TRUE,
    profile_picture_url TEXT,
    referral_code VARCHAR(20) UNIQUE,
    referred_by UUID REFERENCES users(user_id),
    last_login TIMESTAMP WITH TIME ZONE,
    last_password_change TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for faster lookups
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_verification_status ON users(verification_status);
CREATE INDEX idx_users_referral ON users(referral_code);

-- Create user activity logs table
CREATE TABLE user_activity_logs (
    log_id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    activity_type VARCHAR(50) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    location JSONB,
    device_info JSONB,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for user activity logs
CREATE INDEX idx_user_activity_logs_user_id ON user_activity_logs(user_id);
CREATE INDEX idx_user_activity_logs_timestamp ON user_activity_logs(timestamp);
CREATE INDEX idx_user_activity_logs_type ON user_activity_logs(activity_type);

-- Create user verification tokens table
CREATE TABLE user_verification_tokens (
    token_id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'email', 'phone', 'password_reset'
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for verification tokens
CREATE INDEX idx_verification_tokens_user ON user_verification_tokens(user_id);
CREATE INDEX idx_verification_tokens_token ON user_verification_tokens(token);
CREATE INDEX idx_verification_tokens_type ON user_verification_tokens(type);

-- Create a function to update the updated_at column
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a trigger to automatically update updated_at
CREATE TRIGGER update_users_modtime
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();

-- Function to generate unique referral code
CREATE OR REPLACE FUNCTION generate_referral_code()
RETURNS TRIGGER AS $$
BEGIN
    -- Generate a unique 8-character referral code
    NEW.referral_code = UPPER(SUBSTRING(MD5(RANDOM()::text), 1, 8));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to generate referral code before insert
CREATE TRIGGER generate_user_referral_code
BEFORE INSERT ON users
FOR EACH ROW
WHEN (NEW.referral_code IS NULL)
EXECUTE FUNCTION generate_referral_code();
