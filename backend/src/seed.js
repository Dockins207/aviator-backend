import mongoose from 'mongoose';
import dotenv from 'dotenv';
import logger from './config/logger.js';
import User from './models/User.js';
import GameSession from './models/GameSession.js';

// Load environment variables
dotenv.config();

// Seed data
const seedUsers = [
  {
    username: 'testuser1',
    email: 'test1@example.com',
    password: 'securePassword123',
    balance: 1000
  },
  {
    username: 'testuser2',
    email: 'test2@example.com',
    password: 'securePassword456',
    balance: 2000
  }
];

const seedGameSessions = [
  {
    gameType: 'aviator',
    multiplier: 1.5,
    status: 'completed',
    players: []
  }
];

async function seedDatabase() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info('Connected to database');

    // Clear existing data
    await User.deleteMany({});
    await GameSession.deleteMany({});

    // Insert seed data
    await User.create(seedUsers);
    await GameSession.create(seedGameSessions);

    logger.info('Database seeded successfully');
  } catch (error) {
    logger.error('Seeding failed:', error);
  } finally {
    await mongoose.connection.close();
  }
}

// Run seeding
seedDatabase();
