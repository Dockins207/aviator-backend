-- Test database integrity and complex queries

-- Test user creation and constraints
BEGIN;

-- Test unique email constraint
DO $$
BEGIN
    INSERT INTO users (username, email, password_hash) VALUES 
    ('testuser1', 'test1@example.com', 'hashed_password');
    
    -- This should raise an error
    INSERT INTO users (username, email, password_hash) VALUES 
    ('testuser2', 'test1@example.com', 'another_hashed_password');
    
    ASSERT false, 'Unique email constraint test failed';
EXCEPTION 
    WHEN unique_violation THEN
        RAISE NOTICE 'Unique email constraint test passed';
END $$;

-- Test game session creation and relationships
WITH new_game_session AS (
    INSERT INTO game_sessions (game_type, status) 
    VALUES ('aviator', 'in_progress') 
    RETURNING id
),
new_user AS (
    INSERT INTO users (username, email, password_hash) 
    VALUES ('gameuser', 'game@example.com', 'game_password')
    RETURNING id
),
new_bet AS (
    INSERT INTO player_bets (user_id, game_session_id, bet_amount, status)
    SELECT new_user.id, new_game_session.id, 100.00, 'placed'
    FROM new_game_session, new_user
    RETURNING id
)
SELECT 
    gs.id AS game_session_id,
    u.id AS user_id,
    pb.id AS bet_id,
    pb.bet_amount
FROM 
    new_game_session gs
JOIN 
    new_bet pb ON gs.id = pb.game_session_id
JOIN 
    new_user u ON pb.user_id = u.id;

-- Test complex aggregation query
SELECT 
    game_type,
    COUNT(*) as total_sessions,
    AVG(CASE WHEN status = 'completed' THEN 1.0 ELSE 0.0 END) as completion_rate,
    SUM(COALESCE(total_bet_amount, 0)) as total_bets
FROM 
    game_sessions
GROUP BY 
    game_type;

ROLLBACK;
