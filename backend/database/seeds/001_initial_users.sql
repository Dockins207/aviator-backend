-- Seed initial users
-- Note: In a real application, use a secure password hashing method
INSERT INTO users (username, phone_number, password_hash, balance, is_verified, role) VALUES
('testuser1', '+1234567890', 'hashed_password_1', 1000.00, true, 'player'),
('testuser2', '+1234567891', 'hashed_password_2', 2000.00, true, 'player'),
('admin', '+1234567892', 'admin_hashed_password', 0.00, true, 'admin')
ON CONFLICT (phone_number) DO NOTHING;

-- Seed initial game sessions
INSERT INTO game_sessions (game_type, status, start_multiplier, current_multiplier, max_multiplier) VALUES
('aviator', 'completed', 1.00, 2.45, 10.00),
('aviator', 'in_progress', 1.00, 1.22, NULL)
ON CONFLICT (id) DO NOTHING;
