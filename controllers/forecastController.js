const { success, badRequest, error } = require('../utils/response');
const { getReportsByUser, getReportsByProduct, getUserPreference, getProduct } = require('../models/store');
const { calculateConsumptionRate, calculateAverageConsumptionCycle, calculateStockWarningDays } = require('../utils/consumption');
const { addDays, formatDate, todayISO, daysBetween } = require('../utils/date');

function getForecast(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.json(badRequest('缺少 userId 参数'));
    }

    const reports = getReportsByUser(userId);
    if (reports.length === 0) {
      return res.json(success({
        userId,
        message: '暂无上报数据，请先进行库存上报以建立消耗基线',
        hasEnoughData: false,
        productForecasts: []
      }, '查询成功'));
    }

    const pref = getUserPreference(userId);
    const cycleLength = pref.cycleLength || 28;
    const productIds = [...new Set(reports.map(r => r.productId))];

    const productForecasts = [];

    productIds.forEach(productId => {
      const productReports = getReportsByProduct(userId, productId);
      const latestReport = productReports[productReports.length - 1];
      const product = getProduct(productId);
      const cycle = calculateAverageConsumptionCycle(userId, productId, cycleLength);
      const rate = calculateConsumptionRate(userId, productId);

      if (!cycle || !rate) {
        productForecasts.push({
          productId,
          productName: product?.name || productId,
          hasEnoughData: false,
          message: '数据样本不足，需要至少2次有效上报记录',
          latestReport: {
            quantity: latestReport.quantity,
            timestamp: latestReport.timestamp,
            cyclePhase: latestReport.cyclePhase
          },
          reportsCount: productReports.length
        });
        return;
      }

      const warning = calculateStockWarningDays(latestReport.quantity, rate.dailyRate, 3);
      const nextRestockDate = warning.daysLeft !== Infinity
        ? addDays(todayISO(), Math.max(0, warning.daysLeft - 3))
        : null;

      const nextPeriodStart = pref.lastMenstrualReported
        ? addDays(pref.lastMenstrualReported, cycleLength)
        : addDays(todayISO(), cycleLength);

      const needBeforeNextPeriod = rate.dailyRate * (pref.menstrualLength || 5);
      const stockAdequate = latestReport.quantity >= needBeforeNextPeriod;

      productForecasts.push({
        productId,
        productName: product?.name || productId,
        unit: product?.unit || '单位',
        hasEnoughData: true,
        dailyConsumption: rate.dailyRate,
        perCycleConsumption: cycle.perCycle,
        cycleLength,
        currentStock: latestReport.quantity,
        stockReportDate: latestReport.timestamp,
        stockWarning: {
          daysLeft: warning.daysLeft === Infinity ? '充足' : warning.daysLeft,
          isWarning: warning.warning,
          isCritical: warning.critical,
          safetyStockDays: warning.safetyStockDays
        },
        predictedRestockDate: nextRestockDate ? formatDate(nextRestockDate) : null,
        predictedNextPeriodStart: formatDate(nextPeriodStart),
        needBeforeNextPeriod: Number(needBeforeNextPeriod.toFixed(2)),
        stockAdequateForNextPeriod: stockAdequate,
        dataSampleCount: rate.sampleCount
      });
    });

    const summary = generateSummary(productForecasts, cycleLength);

    return res.json(success({
      userId,
      cycleLength,
      menstrualLength: pref.menstrualLength || 5,
      hasEnoughData: productForecasts.some(p => p.hasEnoughData),
      summary,
      productForecasts
    }, '消耗预测查询成功'));
  } catch (err) {
    console.error('getForecast error:', err);
    return res.json(error('预测查询失败：' + err.message));
  }
}

function generateSummary(productForecasts, cycleLength) {
  const validProducts = productForecasts.filter(p => p.hasEnoughData);
  if (validProducts.length === 0) {
    return { totalProducts: productForecasts.length, warningProducts: 0, criticalProducts: 0 };
  }

  const warningProducts = validProducts.filter(p => p.stockWarning.isWarning && !p.stockWarning.isCritical);
  const criticalProducts = validProducts.filter(p => p.stockWarning.isCritical);
  const adequateProducts = validProducts.filter(p => !p.stockWarning.isWarning);
  const totalCycleCost = validProducts.reduce((sum, p) => {
    const product = getProduct(p.productId);
    return sum + (product ? p.perCycleConsumption * product.avgPricePerUnit : 0);
  }, 0);

  return {
    totalProducts: productForecasts.length,
    trackedProducts: validProducts.length,
    adequateProducts: adequateProducts.length,
    warningProducts: warningProducts.length,
    criticalProducts: criticalProducts.length,
    estimatedCycleCost: Number(totalCycleCost.toFixed(2)),
    estimatedAnnualCost: Number((totalCycleCost * 12).toFixed(2)),
    needsAttention: criticalProducts.length > 0 || warningProducts.length > 0
  };
}

module.exports = {
  getForecast
};
