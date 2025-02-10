# Aviator Backend

## Project Setup

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
- Copy `.env.example` to `.env`
- Fill in the required configuration values

3. Run development server:
```bash
npm run dev
```

4. Seed initial database data:
```bash
npm run seed
```

## Project Structure
- `src/`: Source code directory
  - `config/`: Configuration files
  - `controllers/`: Route handlers
  - `services/`: Business logic
  - `repositories/`: Database interaction
  - `models/`: Database models
  - `middleware/`: Custom middleware
  - `utils/`: Utility functions
  - `sockets/`: WebSocket handlers
  - `routes/`: API routes

## Environment Variables
- `PORT`: Server port
- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: JSON Web Token secret
- `NODE_ENV`: Application environment

## Testing
Run tests:
```bash
npm test
```

## Docker (Optional)
Build Docker image:
```bash
docker build -t aviator-backend .
```

Run Docker container:
```bash
docker run -p 8000:8000 aviator-backend
```
