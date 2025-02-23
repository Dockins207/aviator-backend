import Redis from 'redis';
import logger from './src/config/logger.js';

async function testRedisConnection() {
  try {
    console.log('Attempting Redis connection...');
    
    const client = Redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        connectTimeout: 10000,
        disconnectTimeout: 10000
      }
    });

    client.on('error', (err) => {
      console.error('Redis Client Error', err);
    });

    await client.connect();
    console.log('Redis connection successful!');

    // Perform a simple test operation
    await client.set('test_key', 'test_value');
    const value = await client.get('test_key');
    console.log('Test key value:', value);

    await client.quit();
  } catch (error) {
    console.error('Redis connection failed:', error);
  }
}

testRedisConnection();
