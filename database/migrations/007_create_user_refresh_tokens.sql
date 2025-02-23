-- Migration: Create user_refresh_tokens table
-- Purpose: Store refresh tokens for enhanced authentication security
-- Date: 2025-02-21

-- Create user_refresh_tokens table if not exists
CREATE TABLE IF NOT EXISTS user_refresh_tokens (
    user_id UUID PRIMARY KEY,
    token TEXT NOT NULL,
    token_salt TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '7 days',
    is_revoked BOOLEAN DEFAULT FALSE,
    
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Create an index for faster token lookup
CREATE INDEX IF NOT EXISTS idx_user_refresh_tokens_user_id ON user_refresh_tokens(user_id);

-- Create a function to automatically expire old refresh tokens
CREATE OR REPLACE FUNCTION expire_old_refresh_tokens()
RETURNS TRIGGER AS $$
BEGIN
    -- Mark tokens as revoked if they are older than 7 days
    UPDATE user_refresh_tokens 
    SET is_revoked = TRUE 
    WHERE created_at < NOW() - INTERVAL '7 days';
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a trigger to run the expiration function periodically
CREATE TRIGGER trigger_expire_refresh_tokens
AFTER INSERT ON user_refresh_tokens
FOR EACH STATEMENT
EXECUTE FUNCTION expire_old_refresh_tokens();

-- Add comments to improve database documentation
COMMENT ON TABLE user_refresh_tokens IS 'Stores user refresh tokens for secure authentication';
COMMENT ON COLUMN user_refresh_tokens.user_id IS 'Foreign key referencing the users table';
COMMENT ON COLUMN user_refresh_tokens.token IS 'Hashed refresh token';
COMMENT ON COLUMN user_refresh_tokens.token_salt IS 'Salt used for token hashing';
COMMENT ON COLUMN user_refresh_tokens.created_at IS 'Timestamp when the refresh token was created';
COMMENT ON COLUMN user_refresh_tokens.expires_at IS 'Timestamp when the refresh token expires';
COMMENT ON COLUMN user_refresh_tokens.is_revoked IS 'Flag to indicate if the refresh token has been revoked';
