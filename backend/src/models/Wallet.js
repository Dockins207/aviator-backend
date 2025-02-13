export class Wallet {
  constructor(id, userId, balance, currency) {
    this.id = id;
    this.userId = userId;
    this.balance = balance;
    this.currency = currency;
  }

  static fromRow(row) {
    return new Wallet(
      row.wallet_id,
      row.user_id,
      parseFloat(row.balance),
      row.currency
    );
  }
}
