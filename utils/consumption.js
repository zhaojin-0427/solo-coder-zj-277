const { daysBetween, todayISO } = require('./date');
const { getReportsByProduct, getProduct } = require('../models/store');

function calculateConsumptionRate(userId, productId) {
  const reports = getReportsByProduct(userId, productId);
  if (reports.length < 2) {
    return null;
  }

  const rates = [];
  for (let i = 1; i < reports.length; i++) {
    const prev = reports[i - 1];
    const curr = reports[i];
    const days = daysBetween(prev.timestamp, curr.timestamp);
    if (days <= 0) continue;

    const consumed = Math.max(0, prev.quantity - curr.quantity);
    if (consumed > 0) {
      rates.push(consumed / days);
    } else if (curr.quantity > prev.quantity) {
      continue;
    }
  }

  if (rates.length === 0) return null;

  const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
  return {
    dailyRate: Number(avgRate.toFixed(4)),
    sampleCount: rates.length,
    rates: rates.map(r => Number(r.toFixed(4)))
  };
}

function calculateAverageConsumptionCycle(userId, productId, cycleLength = 28) {
  const rate = calculateConsumptionRate(userId, productId);
  if (!rate) return null;

  const perCycle = rate.dailyRate * cycleLength;
  return {
    productId,
    productName: getProduct(productId)?.name || productId,
    dailyRate: rate.dailyRate,
    perCycle: Number(perCycle.toFixed(2)),
    cycleLength,
    sampleCount: rate.sampleCount
  };
}

function detectAnomaly(userId, productId, currentReport) {
  const reports = getReportsByProduct(userId, productId);
  if (reports.length < 3) return null;

  const historicalReports = reports.slice(0, -1);
  if (historicalReports.length < 2) return null;

  const prevReport = historicalReports[historicalReports.length - 1];
  const daysSincePrev = daysBetween(prevReport.timestamp, currentReport.timestamp);
  if (daysSincePrev <= 0) return null;

  const currentConsumed = Math.max(0, prevReport.quantity - currentReport.quantity);
  const currentDailyRate = currentConsumed / daysSincePrev;

  const rates = [];
  for (let i = 1; i < historicalReports.length; i++) {
    const p = historicalReports[i - 1];
    const c = historicalReports[i];
    const d = daysBetween(p.timestamp, c.timestamp);
    if (d > 0) {
      const cons = Math.max(0, p.quantity - c.quantity);
      if (cons > 0) rates.push(cons / d);
    }
  }

  if (rates.length === 0) return null;

  const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
  const variance = rates.reduce((a, b) => a + Math.pow(b - avgRate, 2), 0) / rates.length;
  const stdDev = Math.sqrt(variance);

  const threshold = avgRate + 2 * stdDev;
  const increaseRatio = avgRate > 0 ? (currentDailyRate - avgRate) / avgRate : 0;

  if (currentDailyRate > threshold && increaseRatio > 0.5) {
    return {
      productId,
      productName: getProduct(productId)?.name || productId,
      type: 'sudden_increase',
      severity: increaseRatio > 1.0 ? 'high' : 'medium',
      historicalDailyRate: Number(avgRate.toFixed(4)),
      currentDailyRate: Number(currentDailyRate.toFixed(4)),
      increaseRatio: Number(increaseRatio.toFixed(4)),
      suggestion: generateAdjustmentSuggestion(productId, increaseRatio)
    };
  }

  return null;
}

function generateAdjustmentSuggestion(productId, increaseRatio) {
  const product = getProduct(productId);
  const productName = product?.name || '该产品';

  if (increaseRatio > 1.0) {
    return `检测到${productName}消耗量骤增${(increaseRatio * 100).toFixed(0)}%，建议确认是否出现特殊情况（如经期量变多、外出备用等），可考虑更换大容量包装或增加安全库存`;
  }
  return `检测到${productName}消耗量有所增加（${(increaseRatio * 100).toFixed(0)}%），建议适当调高下次采购量约${Math.ceil(increaseRatio * 100 / 10) * 10}%`;
}

function calculateStockWarningDays(currentQuantity, dailyRate, safetyStockDays = 3) {
  if (!dailyRate || dailyRate <= 0) return { warning: false, daysLeft: Infinity };
  const daysLeft = Math.floor(currentQuantity / dailyRate);
  return {
    warning: daysLeft <= safetyStockDays + 3,
    critical: daysLeft <= safetyStockDays,
    daysLeft,
    safetyStockDays
  };
}

function extrapolateCurrentStock(latestReport, dailyRate) {
  if (!latestReport) return { estimatedStock: 0, daysSinceReport: 0, stale: true };
  if (!dailyRate || dailyRate <= 0) {
    return { estimatedStock: latestReport.quantity, daysSinceReport: 0, stale: false };
  }
  const daysSinceReport = daysBetween(latestReport.timestamp, todayISO());
  const estimatedConsumed = daysSinceReport * dailyRate;
  const estimatedStock = Math.max(0, latestReport.quantity - estimatedConsumed);
  const stale = daysSinceReport > 7;
  return {
    estimatedStock: Number(estimatedStock.toFixed(2)),
    reportedStock: latestReport.quantity,
    daysSinceReport,
    estimatedConsumed: Number(estimatedConsumed.toFixed(2)),
    stale,
    reportDate: latestReport.timestamp
  };
}

module.exports = {
  calculateConsumptionRate,
  calculateAverageConsumptionCycle,
  detectAnomaly,
  calculateStockWarningDays,
  extrapolateCurrentStock
};
