-- Create UUID extension if not exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create global group chat table
CREATE TABLE group_chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    name VARCHAR(255),
    integrity_hash VARCHAR(64)
);

-- Create indexes to improve query performance
CREATE INDEX idx_group_chats_sender ON group_chats(sender_id);
CREATE INDEX idx_group_chats_created_at ON group_chats(created_at);

-- Trigger to log message timestamps
CREATE OR REPLACE FUNCTION log_group_chat_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.created_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER group_chat_timestamp_trigger
BEFORE INSERT ON group_chats
FOR EACH ROW
EXECUTE FUNCTION log_group_chat_timestamp();
