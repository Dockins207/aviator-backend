import redisConnection from '../src/config/redisConfig.js';
import RedisRepository from '../src/repositories/redisRepository.js';
import logger from '../src/utils/logger.js';
import gameUtils from '../src/utils/gameUtils.js';

async function testBettingSystemRedisIntegration() {
  try {
    // Connect to Redis
    await redisConnection.connect();
    const client = redisConnection.getClient();

    // Simulate a game scenario
    const gameId = gameUtils.generateGameUUID();
    const testBets = [
      {
        id: gameUtils.generateGameUUID(),
        gameId: gameId,
        user: 'user1',
        amount: 100,
        status: 'active',
        isUserActivated: true
      },
      {
        id: gameUtils.generateGameUUID(),
        gameId: gameId,
        user: 'user2',
        amount: 200,
        status: 'pending',
        isUserActivated: false
      }
    ];

    // Test 1: Store Bets in Redis with Expiration
    console.log('Test 1: Storing Bets in Redis with Expiration');
    for (const bet of testBets) {
      await RedisRepository.storeBet(gameId, bet, 60);  // 60 seconds expiration
    }

    // Test 2: Retrieve Active Bets
    console.log('Test 2: Retrieving Active Bets');
    const activeBets = await RedisRepository.getActiveBets(gameId);
    console.log('Active Bets:', activeBets);
    
    if (activeBets.length !== 1 || activeBets[0].user !== 'user1') {
      throw new Error('Failed to retrieve correct active bets');
    }

    // Test 3: Get Bet by ID
    console.log('Test 3: Get Bet by ID');
    const retrievedBet = await RedisRepository.getBetById(gameId, testBets[0].id);
    console.log('Retrieved Bet:', retrievedBet);
    
    if (!retrievedBet || retrievedBet.user !== 'user1') {
      throw new Error('Failed to retrieve bet by ID');
    }

    // Test 4: Atomic Bet Status Update
    console.log('Test 4: Atomic Bet Status Update');
    const betToUpdate = testBets[0].id;
    const atomicUpdateResult = await RedisRepository.updateBetStatusAtomic(
      gameId, 
      betToUpdate, 
      'active', 
      'cashed_out'
    );
    
    if (!atomicUpdateResult) {
      throw new Error('Failed to atomically update bet status');
    }

    // Test 5: Game Metrics Tracking
    console.log('Test 5: Game Metrics Tracking');
    const metricKey = 'total_bets';
    
    // Increment metrics
    const initialMetric = await RedisRepository.incrementGameMetrics(gameId, metricKey, 2);
    console.log('Initial Metric Value:', initialMetric);
    
    const updatedMetric = await RedisRepository.incrementGameMetrics(gameId, metricKey, 3);
    console.log('Updated Metric Value:', updatedMetric);
    
    if (updatedMetric !== 5) {
      throw new Error(`Incorrect metric value: ${updatedMetric}`);
    }

    // Retrieve metric
    const retrievedMetric = await RedisRepository.getGameMetrics(gameId, metricKey);
    console.log('Retrieved Metric:', retrievedMetric);
    
    if (retrievedMetric !== 5) {
      throw new Error(`Failed to retrieve correct metric value: ${retrievedMetric}`);
    }

    // Test 6: Clear Game Bets
    console.log('Test 6: Clearing Game Bets');
    await RedisRepository.clearGameBets(gameId);

    // Verify clear
    const remainingBets = await RedisRepository.getActiveBets(gameId);
    if (remainingBets.length !== 0) {
      throw new Error('Failed to clear game bets');
    }

    console.log('✅ Redis Betting System Integration Test: Successful');
    logger.info('✅ Redis Betting System Integration Test: Successful');

    // Disconnect
    await redisConnection.disconnect();
  } catch (error) {
    console.error('❌ Redis Betting System Test Error:', error);
    logger.error('❌ Redis Betting System Test Error', { 
      errorMessage: error.message,
      errorStack: error.stack 
    });
    throw error;
  }
}

// Run the test
testBettingSystemRedisIntegration();
