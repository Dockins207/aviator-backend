import { 
  registerUser, 
  loginUser, 
  generateToken 
} from '../../../backend/src/services/authService';
import User from '../../../backend/src/models/User';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Mock dependencies
jest.mock('../../../backend/src/models/User');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

describe('Authentication Service', () => {
  const mockUser = {
    username: 'testuser',
    email: 'test@example.com',
    password: 'password123'
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('registerUser', () => {
    test('should successfully register a new user', async () => {
      // Mock bcrypt hash
      bcrypt.genSalt.mockResolvedValue('salt');
      bcrypt.hash.mockResolvedValue('hashedPassword');

      // Mock User.findOne to return null (user doesn't exist)
      User.findOne.mockResolvedValue(null);

      // Mock User.create
      const createdUser = { 
        ...mockUser, 
        _id: 'user123', 
        password: 'hashedPassword' 
      };
      User.create.mockResolvedValue(createdUser);

      const result = await registerUser(mockUser);

      expect(User.findOne).toHaveBeenCalledWith({
        $or: [
          { email: mockUser.email },
          { username: mockUser.username }
        ]
      });
      expect(bcrypt.genSalt).toHaveBeenCalled();
      expect(bcrypt.hash).toHaveBeenCalledWith(mockUser.password, 'salt');
      expect(User.create).toHaveBeenCalledWith({
        ...mockUser,
        password: 'hashedPassword'
      });
      expect(result).toEqual(createdUser);
    });

    test('should throw error if user already exists', async () => {
      // Mock User.findOne to return an existing user
      User.findOne.mockResolvedValue({ email: mockUser.email });

      await expect(registerUser(mockUser)).rejects.toThrow('User already exists');
    });
  });

  describe('loginUser', () => {
    test('should successfully login with correct credentials', async () => {
      // Mock User.findOne to return a user
      const existingUser = {
        ...mockUser,
        _id: 'user123',
        password: 'hashedPassword'
      };
      User.findOne.mockResolvedValue(existingUser);

      // Mock password comparison
      bcrypt.compare.mockResolvedValue(true);

      // Mock token generation
      jwt.sign.mockReturnValue('fakeToken');

      const result = await loginUser(mockUser.email, mockUser.password);

      expect(User.findOne).toHaveBeenCalledWith({ email: mockUser.email });
      expect(bcrypt.compare).toHaveBeenCalledWith(mockUser.password, 'hashedPassword');
      expect(jwt.sign).toHaveBeenCalled();
      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('user');
    });

    test('should throw error for non-existent user', async () => {
      User.findOne.mockResolvedValue(null);

      await expect(loginUser(mockUser.email, mockUser.password))
        .rejects.toThrow('Invalid credentials');
    });

    test('should throw error for incorrect password', async () => {
      const existingUser = {
        ...mockUser,
        _id: 'user123',
        password: 'hashedPassword'
      };
      User.findOne.mockResolvedValue(existingUser);
      bcrypt.compare.mockResolvedValue(false);

      await expect(loginUser(mockUser.email, mockUser.password))
        .rejects.toThrow('Invalid credentials');
    });
  });

  describe('generateToken', () => {
    test('should generate a valid JWT token', () => {
      const user = { _id: 'user123', email: 'test@example.com' };
      
      jwt.sign.mockReturnValue('generatedToken');

      const token = generateToken(user);

      expect(jwt.sign).toHaveBeenCalledWith(
        { id: user._id },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRATION }
      );
      expect(token).toBe('generatedToken');
    });
  });
});
