import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

// Standardized JWT secret
export const JWT_SECRET = process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237';

// Phone number normalization
export function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;
  
  // Remove all non-digit characters
  const digitsOnly = phoneNumber.replace(/[^\d]/g, '');
  
  // Handle different phone number formats
  if (digitsOnly.startsWith('254')) {
    return digitsOnly; // Already in international format
  }
  
  if (digitsOnly.startsWith('0')) {
    // Convert 0-prefixed number to international format
    return `254${digitsOnly.slice(1)}`;
  }
  
  if (digitsOnly.length === 9) {
    // Assume it's a local number without country code
    return `254${digitsOnly}`;
  }
  
  // If it doesn't match expected formats, return as-is
  return digitsOnly;
}

// Standardized token validation
export async function validateToken(token) {
  try {
    if (!token) {
      throw new Error('No token provided');
    }

    // Remove 'Bearer ' prefix if present
    const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
    
    // Verify token
    const decoded = jwt.verify(cleanToken, JWT_SECRET);
    
    // Normalize phone number in decoded token
    if (decoded.phone_number) {
      decoded.phone_number = normalizePhoneNumber(decoded.phone_number);
    }

    logger.debug('TOKEN_VALIDATION', {
      userId: decoded.user_id,
      phoneNumber: decoded.phone_number,
      timestamp: new Date().toISOString()
    });

    return decoded;
  } catch (error) {
    logger.error('TOKEN_VALIDATION_ERROR', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

// Standard token generation
export function generateToken(user) {
  const payload = {
    user_id: user.user_id,
    username: user.username,
    role: user.role || 'user',
    roles: user.roles || ['user'],
    phone_number: normalizePhoneNumber(user.phone_number),
    is_active: user.is_active || false
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
