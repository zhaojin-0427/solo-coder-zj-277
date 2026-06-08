const { success, badRequest, error } = require('../utils/response');
const { getUserPreference, updateUserPreference, getReportsByUser, getReportsByProduct, getProduct, getAllProducts, addAnomaly } = require('../models/store');
const { calculateConsumptionRate, calculateAverageConsumptionCycle, detectAnomaly } = require('../utils/consumption');
const { daysBetween } = require('../utils/date');

function getPreference(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return badRequest('缺少 userId 参数', null, res);
    }

    const pref = getUserPreference(userId);
    const reports = getReportsByUser(userId);

    const learnedInsights = learnFromReports(userId, reports);

    const recentAnomalies = pref.anomalies.slice(-10).reverse();
    const hasUnaddressedAnomalies = recentAnomalies.length > 0;

    return success({
      userId,
      cycleLength: pref.cycleLength,
      menstrualLength: pref.menstrualLength,
      budgetLevel: pref.budgetLevel,
      preferredProducts: pref.preferredProducts,
      lastUpdated: pref.lastUpdated,
      lastMenstrualReported: pref.lastMenstrualReported || null,
      learnedInsights,
      anomalies: {
        totalCount: pref.anomalies.length,
        recentCount: recentAnomalies.length,
        hasUnaddressed: hasUnaddressedAnomalies,
        recentAnomalies,
        adjustmentTips: generateAdjustmentTips(recentAnomalies, learnedInsights)
      },
      productPreferences: generateProductPreferences(userId, reports)
    }, '偏好信息查询成功', res);
  } catch (err) {
    console.error('getPreference error:', err);
    return error('偏好查询失败：' + err.message, 500, null, res);
  }
}

function updatePreference(req, res) {
  try {
    const { userId } = req.params;
    const { cycleLength, menstrualLength, budgetLevel, preferredProducts } = req.body;

    if (!userId) {
      return badRequest('缺少 userId 参数', null, res);
    }

    const updates = {};
    if (cycleLength !== undefined) {
      if (typeof cycleLength !== 'number' || cycleLength < 21 || cycleLength > 45) {
        return badRequest('cycleLength 必须是 21-45 之间的数字', null, res);
      }
      updates.cycleLength = cycleLength;
    }
    if (menstrualLength !== undefined) {
      if (typeof menstrualLength !== 'number' || menstrualLength < 2 || menstrualLength > 10) {
        return badRequest('menstrualLength 必须是 2-10 之间的数字', null, res);
      }
      updates.menstrualLength = menstrualLength;
    }
    if (budgetLevel !== undefined) {
      const validLevels = ['economy', 'normal', 'premium'];
      if (!validLevels.includes(budgetLevel)) {
        return badRequest(`budgetLevel 必须是以下之一: ${validLevels.join(', ')}`, null, res);
      }
      updates.budgetLevel = budgetLevel;
    }
    if (preferredProducts !== undefined) {
      if (!Array.isArray(preferredProducts)) {
        return badRequest('preferredProducts 必须是数组', null, res);
      }
      const allProducts = getAllProducts().map(p => p.id);
      const invalid = preferredProducts.filter(p => !allProducts.includes(p));
      if (invalid.length > 0) {
        return badRequest(`以下产品ID无效: ${invalid.join(', ')}`, null, res);
      }
      updates.preferredProducts = preferredProducts;
    }

    if (Object.keys(updates).length === 0) {
      return badRequest('没有提供任何可更新的字段', null, res);
    }

    const updated = updateUserPreference(userId, updates);
    return success({
      userId,
      cycleLength: updated.cycleLength,
      menstrualLength: updated.menstrualLength,
      budgetLevel: updated.budgetLevel,
      preferredProducts: updated.preferredProducts,
      lastUpdated: updated.lastUpdated
    }, '偏好更新成功', res);
  } catch (err) {
    console.error('updatePreference error:', err);
    return error('偏好更新失败：' + err.message, 500, null, res);
  }
}

function learnFromReports(userId, reports) {
  const insights = {
    dataPoints: reports.length,
    estimatedCycleLength: null,
    estimatedMenstrualLength: null,
    phaseConsumptionPatterns: {},
    topConsumedProducts: [],
    learningStatus: 'insufficient_data'
  };

  if (reports.length < 5) {
    return insights;
  }

  insights.learningStatus = 'learning';

  const productIds = [...new Set(reports.map(r => r.productId))];
  const productStats = [];

  productIds.forEach(pid => {
    const prodReports = getReportsByProduct(userId, pid);
    const rate = calculateConsumptionRate(userId, pid);
    if (rate) {
      productStats.push({
        productId: pid,
        productName: getProduct(pid)?.name || pid,
        dailyRate: rate.dailyRate,
        sampleCount: rate.sampleCount
      });
    }
  });

  insights.topConsumedProducts = productStats
    .sort((a, b) => b.dailyRate - a.dailyRate)
    .slice(0, 5);

  const phaseReports = {};
  reports.forEach(r => {
    if (r.cyclePhase) {
      if (!phaseReports[r.cyclePhase]) phaseReports[r.cyclePhase] = [];
      phaseReports[r.cyclePhase].push(r);
    }
  });

  Object.keys(phaseReports).forEach(phase => {
    const phaseData = phaseReports[phase];
    if (phaseData.length >= 2) {
      const productConsumptions = {};
      const phaseProductIds = [...new Set(phaseData.map(r => r.productId))];

      phaseProductIds.forEach(pid => {
        const pReports = phaseData.filter(r => r.productId === pid).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        if (pReports.length >= 2) {
          const first = pReports[0];
          const last = pReports[pReports.length - 1];
          const days = daysBetween(first.timestamp, last.timestamp);
          if (days > 0) {
            const consumed = Math.max(0, first.quantity - last.quantity);
            productConsumptions[pid] = {
              productName: getProduct(pid)?.name || pid,
              dailyRate: Number((consumed / days).toFixed(4))
            };
          }
        }
      });

      insights.phaseConsumptionPatterns[phase] = {
        reportsCount: phaseData.length,
        productConsumptions
      };
    }
  });

  if (insights.phaseConsumptionPatterns.menstrual && productStats.length >= 2) {
    insights.learningStatus = 'learned';
  }

  return insights;
}

function generateProductPreferences(userId, reports) {
  if (reports.length === 0) {
    return getAllProducts().map(p => ({
      productId: p.id,
      productName: p.name,
      unit: p.unit,
      usageFrequency: 'unknown',
      recommendation: '首次使用，建议上报建立基线'
    }));
  }

  const productIds = [...new Set(reports.map(r => r.productId))];
  return productIds.map(pid => {
    const product = getProduct(pid);
    const prodReports = getReportsByProduct(userId, pid);
    const rate = calculateConsumptionRate(userId, pid);

    let usageFrequency = 'low';
    let recommendation = '使用较少';
    if (rate) {
      if (rate.dailyRate >= 2) {
        usageFrequency = 'high';
        recommendation = '高频使用产品，建议常备充足库存';
      } else if (rate.dailyRate >= 0.5) {
        usageFrequency = 'medium';
        recommendation = '中度使用产品，按周期采购即可';
      } else {
        usageFrequency = 'low';
        recommendation = '低频使用产品，注意保质期';
      }
    }

    return {
      productId: pid,
      productName: product?.name || pid,
      unit: product?.unit || '单位',
      reportsCount: prodReports.length,
      dailyRate: rate?.dailyRate || null,
      usageFrequency,
      recommendation
    };
  }).sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2, unknown: 3 };
    return order[a.usageFrequency] - order[b.usageFrequency];
  });
}

function generateAdjustmentTips(anomalies, insights) {
  const tips = [];

  const highAnomalies = anomalies.filter(a => a.severity === 'high');
  const mediumAnomalies = anomalies.filter(a => a.severity === 'medium');

  if (highAnomalies.length > 0) {
    const productNames = [...new Set(highAnomalies.map(a => a.productName))].join('、');
    tips.push(`⚠️ 检测到${productNames}出现重度异常消耗，建议确认身体状况或使用场景变化`);
  }

  if (mediumAnomalies.length > 0) {
    const productNames = [...new Set(mediumAnomalies.map(a => a.productName))].join('、');
    tips.push(`检测到${productNames}消耗有所增加，下次采购时建议增加约20%备用量`);
  }

  if (insights.learningStatus === 'learning') {
    tips.push('系统正在学习您的使用习惯，继续上报可获得更精准的预测');
  } else if (insights.learningStatus === 'insufficient_data') {
    tips.push('当前数据较少，建议每周至少上报1-2次以建立准确的消耗模型');
  }

  if (insights.phaseConsumptionPatterns.menstrual) {
    tips.push('已识别到经期消耗模式，系统将据此优化预测准确性');
  }

  if (tips.length === 0) {
    tips.push('当前消耗模式稳定，继续保持规律上报即可');
  }

  return tips;
}

module.exports = {
  getPreference,
  updatePreference
};
