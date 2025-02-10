import express from 'express';

const router = express.Router();

router.get('/balance', (req, res) => {
  res.json({ message: 'Wallet balance route placeholder' });
});

router.post('/deposit', (req, res) => {
  res.json({ message: 'Wallet deposit route placeholder' });
});

export default router;
