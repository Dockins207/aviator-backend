-- Top players by total winnings
SELECT 
    u.id, 
    u.username, 
    SUM(pb.payout_amount - pb.bet_amount) as total_profit,
    COUNT(pb.id) as total_bets,
    AVG(pb.cashout_multiplier) as avg_cashout_multiplier
FROM 
    users u
JOIN 
    player_bets pb ON u.id = pb.user_id
WHERE 
    pb.status IN ('won', 'cashout')
GROUP BY 
    u.id, u.username
ORDER BY 
    total_profit DESC
LIMIT 10;

-- Game session performance
SELECT 
    gs.id as game_session_id,
    gs.game_type,
    gs.status,
    gs.max_multiplier,
    COUNT(pb.id) as total_bets,
    SUM(pb.bet_amount) as total_bet_amount,
    SUM(pb.payout_amount) as total_payouts,
    (SUM(pb.payout_amount) - SUM(pb.bet_amount)) as house_profit
FROM 
    game_sessions gs
LEFT JOIN 
    player_bets pb ON gs.id = pb.game_session_id
GROUP BY 
    gs.id, gs.game_type, gs.status, gs.max_multiplier
ORDER BY 
    game_session_id DESC
LIMIT 50;

-- User betting history with game details
SELECT 
    u.username,
    gs.game_type,
    pb.bet_amount,
    pb.cashout_multiplier,
    pb.status,
    pb.created_at
FROM 
    player_bets pb
JOIN 
    users u ON pb.user_id = u.id
JOIN 
    game_sessions gs ON pb.game_session_id = gs.id
WHERE 
    u.id = $1  -- Replace with specific user ID
ORDER BY 
    pb.created_at DESC
LIMIT 100;
