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

  static async findOne(query) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1',
        [query.where.userId]
      );
      if (result.rows.length > 0) {
        return this.fromRow(result.rows[0]);
      }
      return null;
    } catch (error) {
      logger.error(`Error querying wallet: ${error.message}`);
      throw new Error('Database query failed.');
    } finally {
      client.release();
    }
  }
}
