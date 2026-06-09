const { EVENT_TYPES, publishEvent, readAllEvents, loadSnapshot, saveSnapshot, ensureDataDir } = require('./eventStore');

const inventoryReports = new Map();
const userPreferences = new Map();
const productCatalog = new Map();
const restockPlans = new Map();
const sharedSpaces = new Map();
const sharedSpaceMembers = new Map();
const sharedSpaceRecords = new Map();
const sharedSpacePlans = new Map();
const sharedSpaceBills = new Map();
const sharedSpaceConflicts = new Map();
const sharedSpaceSnapshots = new Map();

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

function ensureSharedSpaceArrays(spaceId) {
  if (!sharedSpaceMembers.has(spaceId)) sharedSpaceMembers.set(spaceId, []);
  if (!sharedSpaceRecords.has(spaceId)) sharedSpaceRecords.set(spaceId, []);
  if (!sharedSpacePlans.has(spaceId)) sharedSpacePlans.set(spaceId, []);
  if (!sharedSpaceBills.has(spaceId)) sharedSpaceBills.set(spaceId, []);
  if (!sharedSpaceConflicts.has(spaceId)) sharedSpaceConflicts.set(spaceId, []);
  if (!sharedSpaceSnapshots.has(spaceId)) sharedSpaceSnapshots.set(spaceId, []);
}

function applySharedSpaceCreated(payload) {
  const { space } = payload;
  sharedSpaces.set(space.id, space);
  ensureSharedSpaceArrays(space.id);
  if (space.ownerId) {
    const members = sharedSpaceMembers.get(space.id);
    const ownerMember = {
      userId: space.ownerId,
      role: 'owner',
      joinedAt: space.createdAt,
      status: 'active',
      inviteCode: null,
      cycleAnchor: null
    };
    if (!members.find(m => m.userId === space.ownerId)) {
      members.push(ownerMember);
    }
  }
}

function applySharedSpaceUpdated(payload) {
  const { spaceId, updates } = payload;
  const space = sharedSpaces.get(spaceId);
  if (space) {
    Object.assign(space, updates, { updatedAt: payload.timestamp || new Date().toISOString() });
  }
}

function applySharedSpaceDeleted(payload) {
  const { spaceId } = payload;
  sharedSpaces.delete(spaceId);
  sharedSpaceMembers.delete(spaceId);
  sharedSpaceRecords.delete(spaceId);
  sharedSpacePlans.delete(spaceId);
  sharedSpaceBills.delete(spaceId);
  sharedSpaceConflicts.delete(spaceId);
  sharedSpaceSnapshots.delete(spaceId);
}

function applySharedSpaceMemberInvited(payload) {
  const { spaceId, member } = payload;
  ensureSharedSpaceArrays(spaceId);
  const members = sharedSpaceMembers.get(spaceId);
  const exists = members.find(m => m.userId === member.userId);
  if (!exists) {
    members.push({ ...member, status: 'invited', cycleAnchor: null });
  } else {
    Object.assign(exists, member, { status: 'invited' });
  }
}

function applySharedSpaceMemberJoined(payload) {
  const { spaceId, userId, joinedAt } = payload;
  ensureSharedSpaceArrays(spaceId);
  const members = sharedSpaceMembers.get(spaceId);
  const member = members.find(m => m.userId === userId);
  if (member) {
    member.status = 'active';
    member.joinedAt = joinedAt || new Date().toISOString();
    member.inviteCode = null;
  } else {
    members.push({
      userId,
      role: 'collaborator',
      joinedAt: joinedAt || new Date().toISOString(),
      status: 'active',
      inviteCode: null,
      cycleAnchor: null
    });
  }
}

function applySharedSpaceMemberLeft(payload) {
  const { spaceId, userId, leftAt } = payload;
  const members = sharedSpaceMembers.get(spaceId) || [];
  const member = members.find(m => m.userId === userId);
  if (member) {
    member.status = 'left';
    member.leftAt = leftAt || new Date().toISOString();
  }
}

function applySharedSpaceMemberRemoved(payload) {
  const { spaceId, userId, removedAt, removedBy } = payload;
  const members = sharedSpaceMembers.get(spaceId) || [];
  const member = members.find(m => m.userId === userId);
  if (member) {
    member.status = 'removed';
    member.removedAt = removedAt || new Date().toISOString();
    member.removedBy = removedBy || null;
  }
}

function applySharedSpaceMemberUpdated(payload) {
  const { spaceId, userId, updates } = payload;
  const members = sharedSpaceMembers.get(spaceId) || [];
  const member = members.find(m => m.userId === userId);
  if (member) {
    Object.assign(member, updates);
  }
}

function applySharedSpaceConsumptionReported(payload, meta) {
  const { spaceId, record } = payload;
  ensureSharedSpaceArrays(spaceId);
  const records = sharedSpaceRecords.get(spaceId);
  const exists = records.find(r => r.id === record.id);
  if (!exists) {
    records.push({ ...record, type: 'consumption' });
    records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }
  if (!meta.backfill) {
    const members = sharedSpaceMembers.get(spaceId) || [];
    const member = members.find(m => m.userId === record.userId);
    if (member && record.cyclePhase === 'menstrual') {
      member.cycleAnchor = record.timestamp;
    }
  }
}

function applySharedSpacePurchaseReported(payload) {
  const { spaceId, record } = payload;
  ensureSharedSpaceArrays(spaceId);
  const records = sharedSpaceRecords.get(spaceId);
  const exists = records.find(r => r.id === record.id);
  if (!exists) {
    records.push({ ...record, type: 'purchase' });
    records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }
}

function applySharedSpaceBorrowReported(payload) {
  const { spaceId, record } = payload;
  ensureSharedSpaceArrays(spaceId);
  const records = sharedSpaceRecords.get(spaceId);
  const exists = records.find(r => r.id === record.id);
  if (!exists) {
    records.push({ ...record, type: 'borrow', status: 'active' });
    records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }
}

function applySharedSpaceReturnReported(payload) {
  const { spaceId, record, borrowId } = payload;
  ensureSharedSpaceArrays(spaceId);
  const records = sharedSpaceRecords.get(spaceId);
  const exists = records.find(r => r.id === record.id);
  if (!exists) {
    records.push({ ...record, type: 'return' });
    records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }
  if (borrowId) {
    const borrow = records.find(r => r.id === borrowId);
    if (borrow) {
      borrow.status = 'returned';
      borrow.returnedAt = record.timestamp;
      borrow.returnQuantity = record.quantity;
    }
  }
}

function applySharedSpacePreferenceReported(payload) {
  const { spaceId, userId, preference } = payload;
  ensureSharedSpaceArrays(spaceId);
  const members = sharedSpaceMembers.get(spaceId) || [];
  const member = members.find(m => m.userId === userId);
  if (member) {
    member.preference = preference;
    member.preferenceUpdatedAt = preference.timestamp || new Date().toISOString();
  }
}

function applySharedSpacePlanGenerated(payload) {
  const { spaceId, plan } = payload;
  ensureSharedSpaceArrays(spaceId);
  const plans = sharedSpacePlans.get(spaceId);
  const exists = plans.find(p => p.planId === plan.planId);
  if (!exists) {
    plans.push(plan);
    plans.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}

function applySharedSpacePlanConfirmed(payload) {
  const { spaceId, planId, confirmedAt, confirmedBy } = payload;
  const plans = sharedSpacePlans.get(spaceId) || [];
  const plan = plans.find(p => p.planId === planId);
  if (plan) {
    plan.status = 'confirmed';
    plan.confirmedAt = confirmedAt || new Date().toISOString();
    plan.confirmedBy = confirmedBy || null;
  }
}

function applySharedSpaceBillSettled(payload) {
  const { spaceId, bill } = payload;
  ensureSharedSpaceArrays(spaceId);
  const bills = sharedSpaceBills.get(spaceId);
  const exists = bills.find(b => b.billId === bill.billId);
  if (!exists) {
    bills.push(bill);
    bills.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}

function applySharedSpaceConflictResolved(payload) {
  const { spaceId, conflictId, resolution, resolvedAt, resolvedBy } = payload;
  const conflicts = sharedSpaceConflicts.get(spaceId) || [];
  const conflict = conflicts.find(c => c.conflictId === conflictId);
  if (conflict) {
    conflict.status = 'resolved';
    conflict.resolution = resolution;
    conflict.resolvedAt = resolvedAt || new Date().toISOString();
    conflict.resolvedBy = resolvedBy || null;
  }
}

function applySharedSpaceRollback(payload) {
  const { spaceId, toVersion, snapshot } = payload;
  if (snapshot) {
    if (snapshot.members) sharedSpaceMembers.set(spaceId, snapshot.members);
    if (snapshot.records) sharedSpaceRecords.set(spaceId, snapshot.records);
    if (snapshot.plans) sharedSpacePlans.set(spaceId, snapshot.plans);
    if (snapshot.bills) sharedSpaceBills.set(spaceId, snapshot.bills);
    if (snapshot.conflicts) sharedSpaceConflicts.set(spaceId, snapshot.conflicts);
    const space = sharedSpaces.get(spaceId);
    if (space) {
      space.currentVersion = toVersion;
      space.lastRollbackAt = new Date().toISOString();
    }
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
      case EVENT_TYPES.SHAREDSPACE_CREATED:
        applySharedSpaceCreated(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_UPDATED:
        applySharedSpaceUpdated(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_DELETED:
        applySharedSpaceDeleted(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_MEMBER_INVITED:
        applySharedSpaceMemberInvited(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_MEMBER_JOINED:
        applySharedSpaceMemberJoined(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_MEMBER_LEFT:
        applySharedSpaceMemberLeft(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_MEMBER_REMOVED:
        applySharedSpaceMemberRemoved(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_MEMBER_UPDATED:
        applySharedSpaceMemberUpdated(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_CONSUMPTION_REPORTED:
        applySharedSpaceConsumptionReported(event.payload, event.meta || {});
        break;
      case EVENT_TYPES.SHAREDSPACE_PURCHASE_REPORTED:
        applySharedSpacePurchaseReported(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_BORROW_REPORTED:
        applySharedSpaceBorrowReported(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_RETURN_REPORTED:
        applySharedSpaceReturnReported(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_PREFERENCE_REPORTED:
        applySharedSpacePreferenceReported(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_PLAN_GENERATED:
        applySharedSpacePlanGenerated(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_PLAN_CONFIRMED:
        applySharedSpacePlanConfirmed(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_BILL_SETTLED:
        applySharedSpaceBillSettled(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_CONFLICT_RESOLVED:
        applySharedSpaceConflictResolved(event.payload);
        break;
      case EVENT_TYPES.SHAREDSPACE_ROLLBACK:
        applySharedSpaceRollback(event.payload);
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
  sharedSpaces.clear();
  sharedSpaceMembers.clear();
  sharedSpaceRecords.clear();
  sharedSpacePlans.clear();
  sharedSpaceBills.clear();
  sharedSpaceConflicts.clear();
  sharedSpaceSnapshots.clear();

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
    if (snapshot.state.sharedSpaces) {
      Object.entries(snapshot.state.sharedSpaces).forEach(([k, v]) => sharedSpaces.set(k, v));
    }
    if (snapshot.state.sharedSpaceMembers) {
      Object.entries(snapshot.state.sharedSpaceMembers).forEach(([k, v]) => sharedSpaceMembers.set(k, v));
    }
    if (snapshot.state.sharedSpaceRecords) {
      Object.entries(snapshot.state.sharedSpaceRecords).forEach(([k, v]) => sharedSpaceRecords.set(k, v));
    }
    if (snapshot.state.sharedSpacePlans) {
      Object.entries(snapshot.state.sharedSpacePlans).forEach(([k, v]) => sharedSpacePlans.set(k, v));
    }
    if (snapshot.state.sharedSpaceBills) {
      Object.entries(snapshot.state.sharedSpaceBills).forEach(([k, v]) => sharedSpaceBills.set(k, v));
    }
    if (snapshot.state.sharedSpaceConflicts) {
      Object.entries(snapshot.state.sharedSpaceConflicts).forEach(([k, v]) => sharedSpaceConflicts.set(k, v));
    }
    if (snapshot.state.sharedSpaceSnapshots) {
      Object.entries(snapshot.state.sharedSpaceSnapshots).forEach(([k, v]) => sharedSpaceSnapshots.set(k, v));
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
    restockPlans: Object.fromEntries(restockPlans),
    sharedSpaces: Object.fromEntries(sharedSpaces),
    sharedSpaceMembers: Object.fromEntries(sharedSpaceMembers),
    sharedSpaceRecords: Object.fromEntries(sharedSpaceRecords),
    sharedSpacePlans: Object.fromEntries(sharedSpacePlans),
    sharedSpaceBills: Object.fromEntries(sharedSpaceBills),
    sharedSpaceConflicts: Object.fromEntries(sharedSpaceConflicts),
    sharedSpaceSnapshots: Object.fromEntries(sharedSpaceSnapshots)
  };
}

function persistSnapshot() {
  saveSnapshot(getFullState());
}

function generateSharedSpaceId() {
  return `space_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function generateRecordId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generatePlanId() {
  return `splan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateBillId() {
  return `bill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateConflictId() {
  return `cflt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createSharedSpace(spaceData, options = {}) {
  const now = new Date().toISOString();
  const space = {
    id: spaceData.id || generateSharedSpaceId(),
    name: spaceData.name,
    description: spaceData.description || null,
    ownerId: spaceData.ownerId,
    settings: spaceData.settings || {
      budgetSplitStrategy: 'equal',
      autoSettlement: false,
      settlementCycleDays: 30
    },
    createdAt: now,
    updatedAt: now,
    currentVersion: 1,
    status: 'active'
  };

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_CREATED, { space }, options);
  }

  sharedSpaces.set(space.id, space);
  ensureSharedSpaceArrays(space.id);
  const members = sharedSpaceMembers.get(space.id);
  if (!members.find(m => m.userId === space.ownerId)) {
    members.push({
      userId: space.ownerId,
      role: 'owner',
      joinedAt: now,
      status: 'active',
      inviteCode: null,
      cycleAnchor: null
    });
  }
  createSharedSpaceSnapshot(space.id, 1);
  return space;
}

function updateSharedSpace(spaceId, updates, options = {}) {
  const space = sharedSpaces.get(spaceId);
  if (!space) return null;
  const timestamp = new Date().toISOString();
  Object.assign(space, updates, { updatedAt: timestamp });

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_UPDATED, { spaceId, updates, timestamp }, options);
  }
  return space;
}

function deleteSharedSpace(spaceId, options = {}) {
  if (!sharedSpaces.has(spaceId)) return false;

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_DELETED, { spaceId }, options);
  }

  sharedSpaces.delete(spaceId);
  sharedSpaceMembers.delete(spaceId);
  sharedSpaceRecords.delete(spaceId);
  sharedSpacePlans.delete(spaceId);
  sharedSpaceBills.delete(spaceId);
  sharedSpaceConflicts.delete(spaceId);
  sharedSpaceSnapshots.delete(spaceId);
  return true;
}

function getSharedSpace(spaceId) {
  return sharedSpaces.get(spaceId) || null;
}

function getSharedSpacesByUser(userId) {
  const result = [];
  for (const [spaceId, space] of sharedSpaces.entries()) {
    const members = sharedSpaceMembers.get(spaceId) || [];
    if (members.find(m => m.userId === userId && m.status !== 'left' && m.status !== 'removed')) {
      result.push(space);
    }
  }
  return result;
}

function getMembers(spaceId) {
  return sharedSpaceMembers.get(spaceId) || [];
}

function getActiveMembers(spaceId) {
  return getMembers(spaceId).filter(m => m.status === 'active');
}

function getMemberRole(spaceId, userId) {
  const member = getMembers(spaceId).find(m => m.userId === userId);
  return member ? member.role : null;
}

function inviteMember(spaceId, inviteData, options = {}) {
  ensureSharedSpaceArrays(spaceId);
  const members = sharedSpaceMembers.get(spaceId);
  const inviteCode = generateInviteCode();
  const member = {
    userId: inviteData.userId,
    role: inviteData.role || 'collaborator',
    invitedBy: inviteData.invitedBy,
    invitedAt: new Date().toISOString(),
    status: 'invited',
    inviteCode,
    cycleAnchor: null,
    weight: inviteData.weight || 1
  };

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_MEMBER_INVITED, { spaceId, member }, options);
  }

  const existing = members.find(m => m.userId === inviteData.userId);
  if (existing) {
    Object.assign(existing, member, { status: 'invited' });
    return existing;
  }
  members.push(member);
  return member;
}

function joinSharedSpace(spaceId, userId, inviteCode, options = {}) {
  ensureSharedSpaceArrays(spaceId);
  const members = sharedSpaceMembers.get(spaceId);
  const member = members.find(m => m.userId === userId && (m.status === 'invited' || m.inviteCode === inviteCode));
  const joinedAt = new Date().toISOString();

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_MEMBER_JOINED, { spaceId, userId, joinedAt }, options);
  }

  if (member) {
    member.status = 'active';
    member.joinedAt = joinedAt;
    member.inviteCode = null;
    return member;
  }
  const newMember = {
    userId,
    role: 'collaborator',
    joinedAt,
    status: 'active',
    inviteCode: null,
    cycleAnchor: null,
    weight: 1
  };
  members.push(newMember);
  return newMember;
}

function leaveSharedSpace(spaceId, userId, options = {}) {
  const members = sharedSpaceMembers.get(spaceId) || [];
  const member = members.find(m => m.userId === userId);
  if (!member) return null;
  const leftAt = new Date().toISOString();

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_MEMBER_LEFT, { spaceId, userId, leftAt }, options);
  }

  member.status = 'left';
  member.leftAt = leftAt;
  return member;
}

function removeMember(spaceId, userId, removedBy, options = {}) {
  const members = sharedSpaceMembers.get(spaceId) || [];
  const member = members.find(m => m.userId === userId);
  if (!member) return null;
  const removedAt = new Date().toISOString();

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_MEMBER_REMOVED, { spaceId, userId, removedAt, removedBy }, options);
  }

  member.status = 'removed';
  member.removedAt = removedAt;
  member.removedBy = removedBy;
  return member;
}

function updateMember(spaceId, userId, updates, options = {}) {
  const members = sharedSpaceMembers.get(spaceId) || [];
  const member = members.find(m => m.userId === userId);
  if (!member) return null;

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_MEMBER_UPDATED, { spaceId, userId, updates }, options);
  }

  Object.assign(member, updates);
  return member;
}

function addSharedSpaceRecord(spaceId, recordData, recordType, options = {}) {
  ensureSharedSpaceArrays(spaceId);
  const records = sharedSpaceRecords.get(spaceId);
  const prefixMap = {
    consumption: 'cons',
    purchase: 'purch',
    borrow: 'brw',
    return: 'ret',
    preference: 'pref'
  };
  const record = {
    id: recordData.id || generateRecordId(prefixMap[recordType] || 'rec'),
    ...recordData,
    type: recordType,
    timestamp: recordData.timestamp || new Date().toISOString()
  };

  let eventType;
  switch (recordType) {
    case 'consumption':
      eventType = EVENT_TYPES.SHAREDSPACE_CONSUMPTION_REPORTED;
      break;
    case 'purchase':
      eventType = EVENT_TYPES.SHAREDSPACE_PURCHASE_REPORTED;
      break;
    case 'borrow':
      eventType = EVENT_TYPES.SHAREDSPACE_BORROW_REPORTED;
      record.status = record.status || 'active';
      break;
    case 'return':
      eventType = EVENT_TYPES.SHAREDSPACE_RETURN_REPORTED;
      break;
    case 'preference':
      eventType = EVENT_TYPES.SHAREDSPACE_PREFERENCE_REPORTED;
      break;
  }

  if (!replayInProgress) {
    if (recordType === 'return' && recordData.borrowId) {
      publishEvent(eventType, { spaceId, record, borrowId: recordData.borrowId }, options);
    } else if (recordType === 'preference') {
      publishEvent(eventType, { spaceId, userId: recordData.userId, preference: record }, options);
    } else {
      publishEvent(eventType, { spaceId, record }, options);
    }
  }

  records.push(record);
  records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (!options.backfill && recordType === 'consumption' && record.cyclePhase === 'menstrual') {
    const members = sharedSpaceMembers.get(spaceId) || [];
    const member = members.find(m => m.userId === record.userId);
    if (member) {
      member.cycleAnchor = record.timestamp;
    }
  }

  if (recordType === 'return' && recordData.borrowId) {
    const borrow = records.find(r => r.id === recordData.borrowId);
    if (borrow) {
      borrow.status = 'returned';
      borrow.returnedAt = record.timestamp;
      borrow.returnQuantity = record.quantity;
    }
  }

  if (recordType === 'preference') {
    const members = sharedSpaceMembers.get(spaceId) || [];
    const member = members.find(m => m.userId === recordData.userId);
    if (member) {
      member.preference = record;
      member.preferenceUpdatedAt = record.timestamp;
    }
  }

  return record;
}

function getSharedSpaceRecords(spaceId, filter = {}) {
  let records = sharedSpaceRecords.get(spaceId) || [];
  if (filter.type) records = records.filter(r => r.type === filter.type);
  if (filter.userId) records = records.filter(r => r.userId === filter.userId);
  if (filter.productId) records = records.filter(r => r.productId === filter.productId);
  if (filter.status) records = records.filter(r => r.status === filter.status);
  return records;
}

function saveSharedSpacePlan(spaceId, plan, options = {}) {
  ensureSharedSpaceArrays(spaceId);
  const plans = sharedSpacePlans.get(spaceId);

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_PLAN_GENERATED, { spaceId, plan }, options);
  }

  plans.push(plan);
  plans.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return plan;
}

function confirmSharedSpacePlan(spaceId, planId, confirmedBy, options = {}) {
  const plans = sharedSpacePlans.get(spaceId) || [];
  const plan = plans.find(p => p.planId === planId);
  if (!plan) return null;
  const confirmedAt = new Date().toISOString();

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_PLAN_CONFIRMED, { spaceId, planId, confirmedAt, confirmedBy }, options);
  }

  plan.status = 'confirmed';
  plan.confirmedAt = confirmedAt;
  plan.confirmedBy = confirmedBy;
  return plan;
}

function getSharedSpacePlans(spaceId) {
  return sharedSpacePlans.get(spaceId) || [];
}

function getSharedSpacePlanById(spaceId, planId) {
  return getSharedSpacePlans(spaceId).find(p => p.planId === planId) || null;
}

function settleSharedSpaceBill(spaceId, bill, options = {}) {
  ensureSharedSpaceArrays(spaceId);
  const bills = sharedSpaceBills.get(spaceId);

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_BILL_SETTLED, { spaceId, bill }, options);
  }

  bills.push(bill);
  bills.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return bill;
}

function getSharedSpaceBills(spaceId) {
  return sharedSpaceBills.get(spaceId) || [];
}

function addSharedSpaceConflict(spaceId, conflict) {
  ensureSharedSpaceArrays(spaceId);
  const conflicts = sharedSpaceConflicts.get(spaceId);
  const conflictWithId = {
    conflictId: conflict.conflictId || generateConflictId(),
    status: 'pending',
    detectedAt: new Date().toISOString(),
    ...conflict
  };
  conflicts.push(conflictWithId);
  return conflictWithId;
}

function resolveSharedSpaceConflict(spaceId, conflictId, resolution, resolvedBy, options = {}) {
  const conflicts = sharedSpaceConflicts.get(spaceId) || [];
  const conflict = conflicts.find(c => c.conflictId === conflictId);
  if (!conflict) return null;
  const resolvedAt = new Date().toISOString();

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_CONFLICT_RESOLVED, { spaceId, conflictId, resolution, resolvedAt, resolvedBy }, options);
  }

  conflict.status = 'resolved';
  conflict.resolution = resolution;
  conflict.resolvedAt = resolvedAt;
  conflict.resolvedBy = resolvedBy;
  return conflict;
}

function getSharedSpaceConflicts(spaceId) {
  return sharedSpaceConflicts.get(spaceId) || [];
}

function createSharedSpaceSnapshot(spaceId, version) {
  ensureSharedSpaceArrays(spaceId);
  const snapshots = sharedSpaceSnapshots.get(spaceId);
  const snapshot = {
    version,
    createdAt: new Date().toISOString(),
    members: JSON.parse(JSON.stringify(sharedSpaceMembers.get(spaceId) || [])),
    records: JSON.parse(JSON.stringify(sharedSpaceRecords.get(spaceId) || [])),
    plans: JSON.parse(JSON.stringify(sharedSpacePlans.get(spaceId) || [])),
    bills: JSON.parse(JSON.stringify(sharedSpaceBills.get(spaceId) || [])),
    conflicts: JSON.parse(JSON.stringify(sharedSpaceConflicts.get(spaceId) || []))
  };
  snapshots.push(snapshot);
  snapshots.sort((a, b) => b.version - a.version);
  return snapshot;
}

function getSharedSpaceSnapshots(spaceId) {
  return sharedSpaceSnapshots.get(spaceId) || [];
}

function rollbackSharedSpace(spaceId, toVersion, options = {}) {
  const snapshots = getSharedSpaceSnapshots(spaceId);
  const targetSnapshot = snapshots.find(s => s.version === toVersion);
  if (!targetSnapshot) return null;

  if (!replayInProgress) {
    publishEvent(EVENT_TYPES.SHAREDSPACE_ROLLBACK, {
      spaceId,
      toVersion,
      snapshot: targetSnapshot
    }, options);
  }

  sharedSpaceMembers.set(spaceId, JSON.parse(JSON.stringify(targetSnapshot.members)));
  sharedSpaceRecords.set(spaceId, JSON.parse(JSON.stringify(targetSnapshot.records)));
  sharedSpacePlans.set(spaceId, JSON.parse(JSON.stringify(targetSnapshot.plans)));
  sharedSpaceBills.set(spaceId, JSON.parse(JSON.stringify(targetSnapshot.bills)));
  sharedSpaceConflicts.set(spaceId, JSON.parse(JSON.stringify(targetSnapshot.conflicts)));

  const space = sharedSpaces.get(spaceId);
  if (space) {
    space.currentVersion = toVersion;
    space.lastRollbackAt = new Date().toISOString();
  }
  return targetSnapshot;
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
  getFullState,
  createSharedSpace,
  updateSharedSpace,
  deleteSharedSpace,
  getSharedSpace,
  getSharedSpacesByUser,
  getMembers,
  getActiveMembers,
  getMemberRole,
  inviteMember,
  joinSharedSpace,
  leaveSharedSpace,
  removeMember,
  updateMember,
  addSharedSpaceRecord,
  getSharedSpaceRecords,
  saveSharedSpacePlan,
  confirmSharedSpacePlan,
  getSharedSpacePlans,
  getSharedSpacePlanById,
  settleSharedSpaceBill,
  getSharedSpaceBills,
  addSharedSpaceConflict,
  resolveSharedSpaceConflict,
  getSharedSpaceConflicts,
  createSharedSpaceSnapshot,
  getSharedSpaceSnapshots,
  rollbackSharedSpace,
  generateSharedSpaceId,
  generateInviteCode,
  generateRecordId,
  generatePlanId,
  generateBillId,
  generateConflictId
};
