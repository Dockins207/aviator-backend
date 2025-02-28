import Redis from 'ioredis';
import logger from './logger.js';

const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
};

const redisClient = new Redis(redisConfig);

redisClient.on('connect', () => {
    logger.info('REDIS_CONNECTED', {
        service: 'aviator-backend',
        host: redisConfig.host,
        port: redisConfig.port
    });
});

redisClient.on('error', (error) => {
    logger.error('REDIS_CONNECTION_ERROR', {
        service: 'aviator-backend',
        errorMessage: error.message,
        errorStack: error.stack
    });
});

export { redisClient };
