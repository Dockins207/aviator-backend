-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create group_chats table
CREATE TABLE group_chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID,
    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    name VARCHAR(255),
    integrity_hash VARCHAR(64),
    
    -- New columns for enhanced functionality
    type VARCHAR(50) DEFAULT 'default',
    status VARCHAR(50) DEFAULT 'active',
    created_by UUID,
    is_default BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);

-- Add foreign key constraints
ALTER TABLE group_chats 
ADD CONSTRAINT fk_group_chats_sender 
FOREIGN KEY (sender_id) REFERENCES users(user_id);

ALTER TABLE group_chats 
ADD CONSTRAINT fk_group_chats_created_by 
FOREIGN KEY (created_by) REFERENCES users(user_id);

-- Create indexes to improve query performance
CREATE INDEX idx_group_chats_sender ON group_chats(sender_id);
CREATE INDEX idx_group_chats_created_at ON group_chats(created_at);
CREATE INDEX idx_group_chats_name ON group_chats(name);
CREATE INDEX idx_group_chats_type ON group_chats(type);
CREATE INDEX idx_group_chats_status ON group_chats(status);

-- Trigger to log message timestamps
CREATE OR REPLACE FUNCTION log_group_chat_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.created_at = CURRENT_TIMESTAMP;
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER group_chat_timestamp_trigger
BEFORE INSERT ON group_chats
FOR EACH ROW
EXECUTE FUNCTION log_group_chat_timestamp();

-- Ensure a default group chat exists for the admin user
DO $$
DECLARE 
    admin_user_id UUID;
BEGIN
    -- Find the admin user's ID
    SELECT user_id INTO admin_user_id 
    FROM users 
    WHERE username = 'admin' 
    LIMIT 1;

    -- Insert default group chat if not exists
    IF NOT EXISTS (
        SELECT 1 FROM group_chats 
        WHERE is_default = TRUE
    ) AND admin_user_id IS NOT NULL THEN
        INSERT INTO group_chats (
            name, 
            message,
            sender_id,
            created_by,
            is_default,
            type,
            status,
            description
        ) VALUES (
            'Main Group',
            'Welcome to the Aviator Community Chat!',
            admin_user_id,
            admin_user_id,
            TRUE,
            'default',
            'active',
            'Official community chat for Aviator game players'
        );
    END IF;
END $$;
