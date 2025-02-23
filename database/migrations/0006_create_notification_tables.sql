-- Create notification_templates table
CREATE TABLE IF NOT EXISTS notification_templates (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  channel VARCHAR(20) NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  variables TEXT[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  active BOOLEAN DEFAULT TRUE
);

-- Create critical_alerts table
CREATE TABLE IF NOT EXISTS critical_alerts (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) DEFAULT 'MEDIUM',
  game_id VARCHAR(100),
  error_message TEXT NOT NULL,
  error_stack TEXT,
  metadata JSONB,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by VARCHAR(100)
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_critical_alerts_type ON critical_alerts(type);
CREATE INDEX IF NOT EXISTS idx_critical_alerts_timestamp ON critical_alerts(timestamp);
CREATE INDEX IF NOT EXISTS idx_notification_templates_type ON notification_templates(type);
