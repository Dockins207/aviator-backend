export class User {
  constructor(id, username, phoneNumber, isActive, lastLogin) {
    this.id = id;
    this.username = username;
    this.phoneNumber = phoneNumber;
    this.isActive = isActive;
    this.lastLogin = lastLogin;
  }

  static fromRow(row) {
    return new User(
      row.id,
      row.username,
      row.phone_number,
      row.is_active,
      row.last_login
    );
  }
}
