-- Wallet Table for User Balance Management (Currency: KSH - Kenyan Shillings)
CREATE TABLE IF NOT EXISTS wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    balance NUMERIC(15, 2) DEFAULT 0.00 CHECK (balance >= 0),
    currency VARCHAR(3) DEFAULT 'KSH',
    total_deposited NUMERIC(15, 2) DEFAULT 0.00,
    total_withdrawn NUMERIC(15, 2) DEFAULT 0.00,
    total_bet_amount NUMERIC(15, 2) DEFAULT 0.00,
    total_winnings NUMERIC(15, 2) DEFAULT 0.00,
    last_transaction_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Transaction History Table (Currency: KSH - Kenyan Shillings)
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    wallet_id INTEGER NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'KSH',
    transaction_type VARCHAR(50) NOT NULL, -- deposit, withdrawal, bet, win, loss
    payment_method VARCHAR(50), -- mpesa, credit_card, bank_transfer, paypal, etc.
    payment_gateway VARCHAR(50), -- specific gateway provider
    external_transaction_id VARCHAR(100), -- transaction ID from payment gateway
    payment_status VARCHAR(30) DEFAULT 'pending', -- pending, completed, failed, refunded
    payment_metadata JSONB, -- store additional payment-related information
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'completed', -- completed, pending, failed
    reference_id VARCHAR(100), -- for tracking external transactions
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX idx_wallet_user_id ON wallets(user_id);
CREATE INDEX idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX idx_wallet_transactions_type ON wallet_transactions(transaction_type);
