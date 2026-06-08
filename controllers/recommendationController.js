const { success, badRequest, error } = require('../utils/response');
const { getReportsByUser, getReportsByProduct, getUserPreference, getProduct, getAllProducts } = require('../models/store');
const { calculateConsumptionRate, calculateAverageConsumptionCycle, calculateStockWarningDays } = require('../utils/consumption');
const { generateSavingsStrategies, calculateOptimalPurchase } = require('../utils/savings');
const { addDays, formatDate, todayISO } = require('../utils/date');

function getRecommendation(req, res) {
  try {
    const { userId } = req.params;
    const { cycles = '1' } = req.query;
    const cyclesToBuy = parseInt(cycles) || 1;

    if (!userId) {
      return res.json(badRequest('缺少 userId 参数'));
    }

    const reports = getReportsByUser(userId);
    const pref = getUserPreference(userId);
    const cycleLength = pref.cycleLength || 28;

    if (reports.length === 0) {
      return res.json(success({
        userId,
        message: '暂无上报数据，以下为通用建议',
        hasEnoughData: false,
        purchaseList: [],
        savingsStrategies: getGenericSavingsTips(),
        averageConsumptionCycles: [],
        stockWarnings: []
      }, '查询成功'));
    }

    const productIds = [...new Set(reports.map(r => r.productId))];
    const purchaseList = [];
    const averageConsumptionCycles = [];
    const stockWarnings = [];
    let totalEstimatedCost = 0;

    productIds.forEach(productId => {
      const productReports = getReportsByProduct(userId, productId);
      const latestReport = productReports[productReports.length - 1];
      const product = getProduct(productId);
      const rate = calculateConsumptionRate(userId, productId);
      const cycle = calculateAverageConsumptionCycle(userId, productId, cycleLength);

      if (cycle) {
        averageConsumptionCycles.push({
          productId,
          productName: product?.name || productId,
          unit: product?.unit || '单位',
          averageDailyConsumption: cycle.dailyRate,
          averagePerCycleConsumption: cycle.perCycle,
          cycleLength: cycle.cycleLength,
          sampleCount: cycle.sampleCount
        });
      }

      if (!rate) {
        purchaseList.push({
          productId,
          productName: product?.name || productId,
          unit: product?.unit || '单位',
          hasEnoughData: false,
          message: '数据不足，无法精确计算，建议按常规用量采购',
          currentStock: latestReport.quantity,
          suggestedPurchase: null,
          savingsStrategies: product ? generateSavingsStrategies(productId, product.defaultPackSize) : []
        });
        return;
      }

      const warning = calculateStockWarningDays(latestReport.quantity, rate.dailyRate, 3);
      const purchase = calculateOptimalPurchase(productId, latestReport.quantity, rate.dailyRate, cycleLength, cyclesToBuy);

      if (warning.warning || warning.critical) {
        stockWarnings.push({
          productId,
          productName: product?.name || productId,
          currentStock: latestReport.quantity,
          dailyRate: rate.dailyRate,
          daysLeft: warning.daysLeft,
          level: warning.critical ? 'critical' : 'warning',
          suggestion: warning.critical
            ? `库存极度紧张，预计仅能维持${warning.daysLeft}天，请立即补货`
            : `库存偏低，预计仅能维持${warning.daysLeft}天，建议近期补货`
        });
      }

      if (purchase) {
        totalEstimatedCost += purchase.estimatedCost;
      }

      const restockDate = warning.daysLeft !== Infinity && warning.daysLeft <= 14
        ? formatDate(addDays(todayISO(), Math.max(0, warning.daysLeft - 3)))
        : null;

      purchaseList.push({
        productId,
        productName: product?.name || productId,
        unit: product?.unit || '单位',
        hasEnoughData: true,
        currentStock: latestReport.quantity,
        stockDaysLeft: warning.daysLeft === Infinity ? '充足' : warning.daysLeft,
        suggestedPurchase: purchase,
        suggestedRestockDate: restockDate,
        urgency: warning.critical ? '立即购买' : warning.warning ? '近期购买' : '正常采购',
        savingsStrategies: product ? generateSavingsStrategies(productId, cycle?.perCycle || product.defaultPackSize) : []
      });
    });

    const prioritizedList = purchaseList.sort((a, b) => {
      const priority = { '立即购买': 0, '近期购买': 1, '正常采购': 2 };
      const pa = priority[a.urgency] ?? 3;
      const pb = priority[b.urgency] ?? 3;
      return pa - pb;
    });

    const urgentCount = purchaseList.filter(p => p.urgency === '立即购买').length;
    const warningCount = purchaseList.filter(p => p.urgency === '近期购买').length;

    return res.json(success({
      userId,
      cycleLength,
      cyclesToBuy,
      hasEnoughData: purchaseList.some(p => p.hasEnoughData),
      totalEstimatedCost: Number(totalEstimatedCost.toFixed(2)),
      urgencySummary: {
        immediate: urgentCount,
        warning: warningCount,
        normal: purchaseList.length - urgentCount - warningCount
      },
      stockWarnings,
      averageConsumptionCycles,
      purchaseList: prioritizedList,
      tips: generateOverallTips(urgentCount, warningCount, cyclesToBuy)
    }, '补货建议查询成功'));
  } catch (err) {
    console.error('getRecommendation error:', err);
    return res.json(error('建议查询失败：' + err.message));
  }
}

function getGenericSavingsTips() {
  return [
    {
      id: 'cycle_pack',
      title: '选择周期套装',
      description: '包含日用、夜用、护垫的完整周期套装通常比单买更划算，平均节省15%',
      estimatedSavings: '约15%'
    },
    {
      id: 'promo',
      title: '促销节点囤货',
      description: '38节、618、双11等大促期间通常有满减和赠品，建议提前囤3个月用量',
      estimatedSavings: '约20%-40%'
    },
    {
      id: 'eco',
      title: '环保替代方案',
      description: '月经杯、可洗布卫生巾等可重复使用产品长期来看可节省80%以上开支',
      estimatedSavings: '约80%'
    }
  ];
}

function generateOverallTips(urgentCount, warningCount, cyclesToBuy) {
  const tips = [];
  if (urgentCount > 0) {
    tips.push(`有${urgentCount}种产品库存告急，建议立即下单补货以免断供`);
  }
  if (warningCount > 0) {
    tips.push(`有${warningCount}种产品库存偏低，建议本周内安排采购`);
  }
  if (cyclesToBuy >= 3) {
    tips.push('已按3个月用量计算，大批量采购通常可享受更多优惠，注意对比单价');
  }
  if (urgentCount === 0 && warningCount === 0) {
    tips.push('当前库存状况良好，可按正常节奏采购或等待促销活动');
  }
  tips.push('建议在经期前3-5天完成采购，预留物流缓冲时间');
  return tips;
}

module.exports = {
  getRecommendation
};
