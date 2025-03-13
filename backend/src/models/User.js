export class User {
  constructor(
    userId, 
    username, 
    phone, 
    pwdHash, 
    salt, 
    role, 
    verStatus, 
    isActive, 
    profilePictureUrl, 
    refCode, 
    refBy, 
    lastLogin, 
    lastPwdChange, 
    createdAt, 
    updatedAt
  ) {
    this.userId = userId;
    this.username = username;
    this.phone = phone;
    this.pwdHash = pwdHash;
    this.salt = salt;
    this.role = role;
    this.verStatus = verStatus;
    this.isActive = isActive;
    this.profilePictureUrl = profilePictureUrl;
    this.refCode = refCode;
    this.refBy = refBy;
    this.lastLogin = lastLogin;
    this.lastPwdChange = lastPwdChange;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  static fromRow(userRow, profileRow = null) {
    // Handle case where data comes from joined query
    if (profileRow === null && userRow.profile_picture_url !== undefined) {
      profileRow = userRow;
    }
    
    return new User(
      userRow.user_id,
      userRow.username,
      userRow.phone,
      userRow.pwd_hash,
      userRow.salt,
      userRow.role,
      profileRow?.ver_status || 'unverified',
      profileRow?.is_active !== undefined ? profileRow.is_active : true,
      profileRow?.profile_picture_url || null,
      userRow.ref_code,
      userRow.ref_by,
      profileRow?.last_login || null,
      profileRow?.last_pwd_change || null,
      userRow.created_at,
      profileRow?.updated_at || userRow.created_at
    );
  }

  toJSON() {
    return {
      userId: this.userId,
      username: this.username,
      phone: this.phone,
      role: this.role,
      verStatus: this.verStatus,
      isActive: this.isActive,
      profilePictureUrl: this.profilePictureUrl,
      refCode: this.refCode,
      refBy: this.refBy,
      lastLogin: this.lastLogin,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}
