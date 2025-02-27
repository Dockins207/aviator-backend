export class User {
  constructor(
    userId, 
    username, 
    phoneNumber, 
    passwordHash, 
    salt, 
    role, 
    verificationStatus, 
    isActive, 
    profilePictureUrl, 
    referralCode, 
    referredBy, 
    lastLogin, 
    lastPasswordChange, 
    createdAt, 
    updatedAt
  ) {
    this.userId = userId;
    this.username = username;
    this.phoneNumber = phoneNumber;
    this.passwordHash = passwordHash;
    this.salt = salt;
    this.role = role;
    this.verificationStatus = verificationStatus;
    this.isActive = isActive;
    this.profilePictureUrl = profilePictureUrl;
    this.referralCode = referralCode;
    this.referredBy = referredBy;
    this.lastLogin = lastLogin;
    this.lastPasswordChange = lastPasswordChange;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  static fromRow(row) {
    return new User(
      row.user_id,
      row.username,
      row.phone_number,
      row.password_hash,
      row.salt,
      row.role,
      row.verification_status,
      row.is_active,
      row.profile_picture_url,
      row.referral_code,
      row.referred_by,
      row.last_login,
      row.last_password_change,
      row.created_at,
      row.updated_at
    );
  }

  toJSON() {
    return {
      userId: this.userId,
      username: this.username,
      phoneNumber: this.phoneNumber,
      role: this.role,
      verificationStatus: this.verificationStatus,
      isActive: this.isActive,
      profilePictureUrl: this.profilePictureUrl,
      referralCode: this.referralCode,
      referredBy: this.referredBy,
      lastLogin: this.lastLogin,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}
