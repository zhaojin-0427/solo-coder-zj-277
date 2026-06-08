const { EVENT_TYPES, publishEvent, readAllEvents, loadSnapshot, saveSnapshot, ensureDataDir } = require('./eventStore');

const inventoryReports = new Map();
const userPreferences = new Map();
const productCatalog = new Map();
const restockPlans = new Map();

let replayInProgress = false;

const defaultProducts = [
  { id: 'sanitary_pad_regular', name: '日用卫生巾', unit: '片', defaultPackSize: 10, avgPricePerUnit: 1.5 },
  { id: 'sanitary_pad_night', name: '夜用卫生巾', unit: '片', defaultPackSize: 8, avgPricePerUnit: 2.0 },
  { id: 'tampon_regular', name: '普通量卫生棉条', unit: '支', defaultPackSize: 16, avgPricePerUnit: 2.5 },
  { id: 'tampon_super', name: '大量卫生棉条', unit: '支', defaultPackSize: 16, avgPricePerUnit: 2.8 },
  { id: 'menstrual_cup', name: '月经杯', unit: '个', defaultPackSize: 1, avgPricePerUnit: 80.0 },
  { id: 'panty_liner', name: '护垫', unit: '片', defaultPackSize: 30, avgPricePerUnit: 0.5 },
  { id: 'pain_relief', name: '痛经止痛药', unit: '片', defaultPackSize: 20, avgPricePerUnit: 1.0 },
  { id: 'heat_patch', name: '暖宫贴', unit: '片', defaultPackSize: 6, avgPricePerUnit: 3.0 }
];

defaultProducts.forEach(p => productCatalog.set(p.id, p));

const cyclePhases = ['menstrual', 'follicular', 'ovulation', 'luteal'];

function defaultPref(userId) {
  return {
    userId,
    cycleLength: 28,
    menstrualLength: 5,
    preferredProducts: [],
    budgetLevel: 'normal',
    lastUpdated: null,
    lastMenstrualReported: null,
    anomalies: [],
    subscription: {
      enabled: false,
      cyclesAhead: 1,
      globalMaxBudget: null,
      globalMinSafetyStockDays: 3,
      productStrategies: {}
    }
  };
}

function applyInventoryReported(payload, meta) {
  const { userId, report } = payload;
  if (!inventoryReports.has(userId)) {
    inventoryReports.set(userId, []);
  }
  const userReports = inventoryReports.get(userId);
  const exists = userReports.find(r => r.id === report.id);
  if (!exists) {
    userReports.push(report);
    userReports.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  if (!meta.backfill && report.cyclePhase === 'menstrual') {
    const pref = getUserPreference(userId);
    pref.lastMenstrualReported = report.timestamp;
    userPreferences.set(userId, pref);
  }
}

function applyPreferenceUpdated(payload) {
  const { userId, updates } = payload;
  const pref = getUserPreference(userId);
  Object.assign(pref, updates, { lastUpdated: payload.timestamp || new Date().toISOString() });
  userPreferences.set(userId, pref);
}

function applyAnomalyDetected(payload) {
  const { userId, anomaly } = payload;
  const pref = getUserPreference(userId);
  const exists = pref.anomalies.find(a => a.id === anomaly.id);
  if (!exists) {
    pref.anomalies.push(anomaly);
    userPreferences.set(userId, pref);
  }
}

function applySubscriptionConfigured(payload) {
  const { userId, config } = payload;
  const pref = getUserPreference(userId);
  pref.subscription = {
    ...pref.subscription,
    ...config,
    lastUpdated: payload.timestamp || new Date().toISOString()
  };
  userPreferences.set(userId, pref);
}

function applyPlanGenerated(payload) {
  const { userId, plan } = payload;
  if (!restockPlans.has(userId)) {
    restockPlans.set(userId, []);
  }
  const userPlans = restockPlans.get(userId);
  const exists = userPlans.find(p => p.planId === plan.planId);
  if (!exists) {
    userPlans.push(plan);
    userPlans.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}

function applyPlanConfirmed(payload) {
  const { userId, planId, confirmedAt } = payload;
  const userPlans = restockPlans.get(userId) || [];
  const plan = userPlans.find(p => p.planId === planId);
  if (plan) {
    plan.status = 'confirmed';
    plan.confirmedAt = confirmedAt || new Date().toISOString();
  }
}

function applyPlanCancelled(payload) {
  const { userId, planId, cancelledAt, reason } = payload;
  const userPlans = restockPlans.get(userId) || [];
  const plan = userPlans.find(p => p.planId === planId);
  if (plan) {
    plan.status = 'cancelled';
    plan.cancelledAt = cancelledAt || new Date().toISOString();
    plan.cancelReason = reason || null;
  }
}

function applyEvent(event) {
  try {
    switch (event.type) {
      case EVENT_TYPES.INVENTORY_REPORTED:
        applyInventoryReported(event.payload, event.meta || {});
        break;
      case EVENT_TYPES.PREFERENCE_UPDATED:
        applyPreferenceUpdated(event.payload);
        break;
      case EVENT_TYPES.ANOMALY_DETECTED:
        applyAnomalyDetected(event.payload);
        break;
      case EVENT_TYPES.SUBSCRIPTION_CONFIGURED:
        applySubscriptionConfigured(event.payload);
        break;
      case EVENT_TYPES.PLAN_GENERATED:
        applyPlanGenerated(event.payload);
        break;
      case EVENT_TYPES.PLAN_CONFIRMED:
        applyPlanConfirmed(event.payload);
        break;
      case EVENT_TYPES.PLAN_CANCELLED:
        applyPlanCancelled(event.payload);
        break;
      default:
        console.warn('Unknown event type during replay:', event.type);
    }
  } catch (e) {
    console.error('Error applying event', event.id, event.type, ':', e.message);
  }
}

function replayAllEvents() {
  replayInProgress = true;
  ensureDataDir();
  inventoryReports.clear();
  userPreferences.clear();
  restockPlans.clear();

  const snapshot = loadSnapshot();
  if (snapshot && snapshot.state) {
    if (snapshot.state.inventoryReports) {
      Object.entries(snapshot.state.inventoryReports).forEach(([k, v]) => inventoryReports.set(k, v));
    }
    if (snapshot.state.userPreferences) {
      Object.entries(snapshot.state.userPreferences).forEach(([k, v]) => userPreferences.set(k, v));
    }
    if (snapshot.state.restockPlans) {
      Object.entries(snapshot.state.restockPlans).forEach(([k, v]) => restockPlans.set(k, v));
    }
    console.log(`[EventStore] Loaded snapshot from ${snapshot.timestamp}`);
  }

  const events = readAllEvents();
  events.forEach(applyEvent);
  console.log(`[EventStore] Replayed ${events.length} events`);
  replayInProgress = false;
}

function addReport(userId, report, options = {}) {
  const reportWithId = {
    id: report.id || `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...report,
    timestamp: report.timestamp || new Date().toISOString()
  };

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.INVENTORY_REPORTED, {
      userId,
      report: reportWithId
    }, options);
  }

  if (!inventoryReports.has(userId)) {
    inventoryReports.set(userId, []);
  }
  const userReports = inventoryReports.get(userId);
  userReports.push(reportWithId);
  userReports.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (!options.backfill && reportWithId.cyclePhase === 'menstrual') {
    const pref = getUserPreference(userId);
    pref.lastMenstrualReported = reportWithId.timestamp;
    userPreferences.set(userId, pref);
  }

  return reportWithId;
}

function getReportsByUser(userId) {
  return inventoryReports.get(userId) || [];
}

function getReportsByProduct(userId, productId) {
  return getReportsByUser(userId).filter(r => r.productId === productId);
}

function getUserPreference(userId) {
  if (!userPreferences.has(userId)) {
    userPreferences.set(userId, defaultPref(userId));
  }
  return userPreferences.get(userId);
}

function updateUserPreference(userId, updates, options = {}) {
  const pref = getUserPreference(userId);
  const timestamp = new Date().toISOString();
  Object.assign(pref, updates, { lastUpdated: timestamp });

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.PREFERENCE_UPDATED, {
      userId,
      updates,
      timestamp
    }, options);
  }

  userPreferences.set(userId, pref);
  return pref;
}

function addAnomaly(userId, anomaly, options = {}) {
  const pref = getUserPreference(userId);
  const anomalyWithId = {
    id: anomaly.id || `anm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...anomaly,
    detectedAt: anomaly.detectedAt || new Date().toISOString()
  };

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.ANOMALY_DETECTED, {
      userId,
      anomaly: anomalyWithId
    }, options);
  }

  pref.anomalies.push(anomalyWithId);
  userPreferences.set(userId, pref);
  return pref;
}

function configureSubscription(userId, config, options = {}) {
  const pref = getUserPreference(userId);
  const timestamp = new Date().toISOString();
  pref.subscription = {
    ...pref.subscription,
    ...config,
    lastUpdated: timestamp
  };

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SUBSCRIPTION_CONFIGURED, {
      userId,
      config,
      timestamp
    }, options);
  }

  userPreferences.set(userId, pref);
  return pref.subscription;
}

function savePlan(userId, plan, options = {}) {
  if (!restockPlans.has(userId)) {
    restockPlans.set(userId, []);
  }
  const userPlans = restockPlans.get(userId);

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.PLAN_GENERATED, {
      userId,
      plan
    }, options);
  }

  userPlans.push(plan);
  userPlans.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return plan;
}

function confirmPlan(userId, planId, options = {}) {
  const userPlans = restockPlans.get(userId) || [];
  const plan = userPlans.find(p => p.planId === planId);
  if (!plan) return null;

  const confirmedAt = new Date().toISOString();
  plan.status = 'confirmed';
  plan.confirmedAt = confirmedAt;

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.PLAN_CONFIRMED, {
      userId,
      planId,
      confirmedAt
    }, options);
  }
  return plan;
}

function cancelPlan(userId, planId, reason, options = {}) {
  const userPlans = restockPlans.get(userId) || [];
  const plan = userPlans.find(p => p.planId === planId);
  if (!plan) return null;

  const cancelledAt = new Date().toISOString();
  plan.status = 'cancelled';
  plan.cancelledAt = cancelledAt;
  plan.cancelReason = reason || null;

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.PLAN_CANCELLED, {
      userId,
      planId,
      cancelledAt,
      reason: reason || null
    }, options);
  }
  return plan;
}

function getPlansByUser(userId) {
  return restockPlans.get(userId) || [];
}

function getPlanById(userId, planId) {
  return getPlansByUser(userId).find(p => p.planId === planId) || null;
}

function getProduct(productId) {
  return productCatalog.get(productId);
}

function getAllProducts() {
  return Array.from(productCatalog.values());
}

function getFullState() {
  return {
    inventoryReports: Object.fromEntries(inventoryReports),
    userPreferences: Object.fromEntries(userPreferences),
    restockPlans: Object.fromEntries(restockPlans)
  };
}

function persistSnapshot() {
  saveSnapshot(getFullState());
}

module.exports = {
  cyclePhases,
  addReport,
  getReportsByUser,
  getReportsByProduct,
  getUserPreference,
  updateUserPreference,
  addAnomaly,
  configureSubscription,
  savePlan,
  confirmPlan,
  cancelPlan,
  getPlansByUser,
  getPlanById,
  getProduct,
  getAllProducts,
  replayAllEvents,
  persistSnapshot,
  getFullState
};
