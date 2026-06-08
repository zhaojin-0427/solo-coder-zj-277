const fs = require('fs');
const path = require('path');

const EVENT_LOG_DIR = path.join(__dirname, '..', 'data');
const EVENT_LOG_FILE = path.join(EVENT_LOG_DIR, 'events.jsonl');
const SNAPSHOT_FILE = path.join(EVENT_LOG_DIR, 'snapshot.json');

const EVENT_TYPES = {
  INVENTORY_REPORTED: 'inventory.reported',
  PREFERENCE_UPDATED: 'preference.updated',
  ANOMALY_DETECTED: 'anomaly.detected',
  SUBSCRIPTION_CONFIGURED: 'subscription.configured',
  PLAN_GENERATED: 'plan.generated',
  PLAN_CONFIRMED: 'plan.confirmed',
  PLAN_CANCELLED: 'plan.cancelled'
};

function ensureDataDir() {
  if (!fs.existsSync(EVENT_LOG_DIR)) {
    fs.mkdirSync(EVENT_LOG_DIR, { recursive: true });
  }
}

function generateEventId() {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function appendEvent(event) {
  ensureDataDir();
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(EVENT_LOG_FILE, line, 'utf8');
}

function publishEvent(type, payload, options = {}) {
  const event = {
    id: generateEventId(),
    type,
    timestamp: new Date().toISOString(),
    payload,
    meta: {
      backfill: !!options.backfill,
      source: options.source || 'api',
      ...options.meta
    }
  };
  appendEvent(event);
  return event;
}

function readAllEvents() {
  ensureDataDir();
  if (!fs.existsSync(EVENT_LOG_FILE)) {
    return [];
  }
  const content = fs.readFileSync(EVENT_LOG_FILE, 'utf8');
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      console.warn('Skipping malformed event line:', line.slice(0, 100));
      return null;
    }
  }).filter(Boolean);
}

function getEventsByUser(userId) {
  return readAllEvents().filter(e => e.payload && e.payload.userId === userId);
}

function getEventsByType(type) {
  return readAllEvents().filter(e => e.type === type);
}

function saveSnapshot(state) {
  ensureDataDir();
  const snapshot = {
    timestamp: new Date().toISOString(),
    state
  };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    return null;
  }
  try {
    const content = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.warn('Failed to load snapshot:', e.message);
    return null;
  }
}

module.exports = {
  EVENT_TYPES,
  publishEvent,
  readAllEvents,
  getEventsByUser,
  getEventsByType,
  saveSnapshot,
  loadSnapshot,
  ensureDataDir,
  EVENT_LOG_FILE,
  SNAPSHOT_FILE
};
