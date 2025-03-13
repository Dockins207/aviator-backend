import express from 'express';
import cors from 'cors';

const app = express();

// CORS configuration with proper origin handling
app.use(cors({
  origin: ['http://localhost:3000', 'https://your-frontend-domain.com', 'http://192.168.0.11:3000/'],
  credentials: true
}));

// Body parsing middleware - make sure these come BEFORE your routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ...existing code...