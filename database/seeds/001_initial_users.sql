-- Seed initial users
-- Note: In a real application, use a secure password hashing method
INSERT INTO users (username, email, password_hash, balance, is_verified, role) VALUES
('testuser1', 'test1@example.com', 'hashed_password_1', 1000.00, true, 'player'),
('testuser2', 'test2@example.com', 'hashed_password_2', 2000.00, true, 'player'),
('admin', 'admin@aviator.com', 'admin_hashed_password', 0.00, true, 'admin')
ON CONFLICT (email) DO NOTHING;

-- Seed initial game sessions
INSERT INTO game_sessions (game_type, status, start_multiplier, current_multiplier, max_multiplier) VALUES
('aviator', 'completed', 1.00, 2.45, 10.00),
('aviator', 'in_progress', 1.00, 1.22, NULL)
ON CONFLICT (id) DO NOTHING;
