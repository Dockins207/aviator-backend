export const BetState = Object.freeze({
    QUEUED: 'QUEUED', // Bet is stored in the queue, waiting to be processed
    ACTIVE: 'ACTIVE', // Bet is stored in the database, waiting for the outcome
    PLACED: 'PLACED',
    CASHED_OUT: 'CASHED_OUT',
    EXPIRED: 'EXPIRED'
});

export const BetType = Object.freeze({
    NORMAL: 'NORMAL',
    AUTO_CASHOUT: 'AUTO_CASHOUT'
});

export const StorageType = Object.freeze({
    DATABASE: 'DATABASE',
    REDIS: 'REDIS'
});