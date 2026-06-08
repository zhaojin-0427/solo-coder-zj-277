const inventoryReports = new Map();
const userPreferences = new Map();
const productCatalog = new Map();

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

function addReport(userId, report) {
  if (!inventoryReports.has(userId)) {
    inventoryReports.set(userId, []);
  }
  const userReports = inventoryReports.get(userId);
  const reportWithId = {
    id: `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...report,
    timestamp: report.timestamp || new Date().toISOString()
  };
  userReports.push(reportWithId);
  userReports.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
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
    userPreferences.set(userId, {
      userId,
      cycleLength: 28,
      menstrualLength: 5,
      preferredProducts: [],
      budgetLevel: 'normal',
      lastUpdated: null,
      anomalies: []
    });
  }
  return userPreferences.get(userId);
}

function updateUserPreference(userId, updates) {
  const pref = getUserPreference(userId);
  Object.assign(pref, updates, { lastUpdated: new Date().toISOString() });
  userPreferences.set(userId, pref);
  return pref;
}

function addAnomaly(userId, anomaly) {
  const pref = getUserPreference(userId);
  pref.anomalies.push({
    id: `anm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...anomaly,
    detectedAt: new Date().toISOString()
  });
  userPreferences.set(userId, pref);
  return pref;
}

function getProduct(productId) {
  return productCatalog.get(productId);
}

function getAllProducts() {
  return Array.from(productCatalog.values());
}

module.exports = {
  cyclePhases,
  addReport,
  getReportsByUser,
  getReportsByProduct,
  getUserPreference,
  updateUserPreference,
  addAnomaly,
  getProduct,
  getAllProducts
};
