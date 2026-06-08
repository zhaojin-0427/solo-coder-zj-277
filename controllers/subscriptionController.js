const { success, badRequest, error, notFound } = require('../utils/response');
const {
  getUserPreference,
  configureSubscription,
  getReportsByUser,
  getReportsByProduct,
  getProduct,
  getAllProducts,
  savePlan,
  confirmPlan,
  cancelPlan,
  getPlansByUser,
  getPlanById,
  cyclePhases,
  addReport,
  addAnomaly
} = require('../models/store');
const { calculateConsumptionRate, calculateAverageConsumptionCycle, calculateStockWarningDays, extrapolateCurrentStock, detectAnomaly } = require('../utils/consumption');
const { generateSavingsStrategies, calculateOptimalPurchase } = require('../utils/savings');
const { addDays, formatDate, todayISO, daysBetween } = require('../utils/date');

function generatePlanId() {
  return `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function detectCurrentCyclePhase(pref, reports) {
  if (!pref.lastMenstrualReported) return null;
  const cycleLength = pref.cycleLength || 28;
  const daysSinceLast = daysBetween(pref.lastMenstrualReported, todayISO());
  const dayInCycle = ((daysSinceLast % cycleLength) + cycleLength) % cycleLength;
  const menstrualLength = pref.menstrualLength || 5;

  if (dayInCycle < menstrualLength) return 'menstrual';
  if (dayInCycle < menstrualLength + 7) return 'follicular';
  if (dayInCycle < menstrualLength + 14) return 'ovulation';
  return 'luteal';
}

function shouldSkipCycle(productStrategy, pref, cycleIndex) {
  if (!productStrategy || !productStrategy.skipRules) return false;
  const rules = productStrategy.skipRules;

  if (rules.skipEveryNthCycle && rules.skipEveryNthCycle > 0) {
    if ((cycleIndex + 1) % rules.skipEveryNthCycle === 0) return true;
  }

  if (rules.skipWhenStockAboveDays) {
    return true;
  }

  if (rules.skipOnCertainPhases && rules.skipOnCertainPhases.length > 0) {
    const currentPhase = detectCurrentCyclePhase(pref, []);
    if (currentPhase && rules.skipOnCertainPhases.includes(currentPhase)) return true;
  }

  return false;
}

function getEffectiveProductStrategy(productId, subscription) {
  const globalStrategy = {
    cyclesAhead: subscription.cyclesAhead || 1,
    maxBudget: subscription.globalMaxBudget || null,
    minSafetyStockDays: subscription.globalMinSafetyStockDays || 3,
    skipRules: {}
  };

  const productSpecific = subscription.productStrategies && subscription.productStrategies[productId];
  if (!productSpecific) return globalStrategy;

  return {
    cyclesAhead: productSpecific.cyclesAhead ?? globalStrategy.cyclesAhead,
    maxBudget: productSpecific.maxBudget ?? globalStrategy.maxBudget,
    minSafetyStockDays: productSpecific.minSafetyStockDays ?? globalStrategy.minSafetyStockDays,
    skipRules: productSpecific.skipRules || globalStrategy.skipRules,
    preferredPackSize: productSpecific.preferredPackSize || null,
    preferredBrand: productSpecific.preferredBrand || null,
    autoConfirm: productSpecific.autoConfirm || false
  };
}

function applyBudgetAdjustment(items, maxBudget) {
  if (!maxBudget || maxBudget <= 0) return { items, totalCost: 0, budgetExceeded: false, adjusted: false };

  let totalCost = items.reduce((s, i) => s + (i.estimatedCost || 0), 0);

  if (totalCost <= maxBudget) {
    return { items, totalCost: Number(totalCost.toFixed(2)), budgetExceeded: false, adjusted: false };
  }

  const sorted = [...items].sort((a, b) => {
    const pa = a.urgencyPriority ?? 2;
    const pb = b.urgencyPriority ?? 2;
    return pa - pb;
  });

  const adjustedItems = [];
  let accumCost = 0;
  let budgetExceeded = false;

  for (const item of sorted) {
    const itemCost = item.estimatedCost || 0;
    if (accumCost + itemCost <= maxBudget) {
      adjustedItems.push({ ...item, budgetTrimmed: false });
      accumCost += itemCost;
    } else {
      budgetExceeded = true;
      const product = getProduct(item.productId);
      if (product) {
        const affordablePacks = Math.floor((maxBudget - accumCost) / (product.defaultPackSize * product.avgPricePerUnit));
        if (affordablePacks > 0) {
          adjustedItems.push({
            ...item,
            packsToBuy: affordablePacks,
            totalUnits: affordablePacks * product.defaultPackSize,
            estimatedCost: Number((affordablePacks * product.defaultPackSize * product.avgPricePerUnit).toFixed(2)),
            budgetTrimmed: true,
            originalPacksToBuy: item.packsToBuy,
            originalEstimatedCost: item.estimatedCost
          });
          accumCost += affordablePacks * product.defaultPackSize * product.avgPricePerUnit;
        } else {
          adjustedItems.push({ ...item, budgetTrimmed: true, skippedDueToBudget: true, packsToBuy: 0, totalUnits: 0, estimatedCost: 0 });
        }
      }
    }
  }

  return {
    items: adjustedItems.sort((a, b) => (a.urgencyPriority ?? 2) - (b.urgencyPriority ?? 2)),
    totalCost: Number(accumCost.toFixed(2)),
    budgetExceeded,
    adjusted: true,
    maxBudget
  };
}

function applyPromoSavings(items, pref) {
  const promoMultiplier = pref.budgetLevel === 'economy' ? 0.9 : pref.budgetLevel === 'premium' ? 1.0 : 0.95;

  return items.map(item => {
    const baseCost = item.estimatedCost || 0;
    const savingsStrategies = item.savingsStrategies || [];
    const bestSaving = savingsStrategies.length > 0
      ? Math.max(...savingsStrategies.map(s => s.savingPercent || 0))
      : 0;

    const promoAdjustedCost = Number((baseCost * promoMultiplier).toFixed(2));
    const potentialSavings = Number((baseCost * (bestSaving / 100)).toFixed(2));

    return {
      ...item,
      baseEstimatedCost: baseCost,
      promoAdjustedCost,
      potentialSavings,
      effectiveCost: Number((promoAdjustedCost - potentialSavings * 0.5).toFixed(2)),
      promoApplied: promoMultiplier < 1.0,
      savingsNote: bestSaving > 0 ? `建议结合促销策略可节省约¥${potentialSavings}` : null
    };
  });
}

function factorInAnomalies(userId, productId, baseDailyRate) {
  const pref = getUserPreference(userId);
  const recentAnomalies = pref.anomalies
    .filter(a => a.productId === productId)
    .filter(a => {
      const daysSince = daysBetween(a.detectedAt, todayISO());
      return daysSince <= 30;
    });

  if (recentAnomalies.length === 0 || !baseDailyRate) {
    return { adjustedRate: baseDailyRate, anomalyFactor: 1.0, anomaliesConsidered: 0 };
  }

  const highCount = recentAnomalies.filter(a => a.severity === 'high').length;
  const mediumCount = recentAnomalies.filter(a => a.severity === 'medium').length;

  const factor = 1 + (highCount * 0.3) + (mediumCount * 0.15);
  const adjustedRate = baseDailyRate * factor;

  return {
    adjustedRate: Number(adjustedRate.toFixed(4)),
    anomalyFactor: Number(factor.toFixed(4)),
    anomaliesConsidered: recentAnomalies.length,
    anomalyDetails: recentAnomalies.map(a => ({
      severity: a.severity,
      increaseRatio: a.increaseRatio,
      detectedAt: a.detectedAt
    }))
  };
}

function generateRestockPlanSnapshot(userId, options = {}) {
  const pref = getUserPreference(userId);
  const subscription = pref.subscription || { enabled: false, cyclesAhead: 1, globalMaxBudget: null, globalMinSafetyStockDays: 3, productStrategies: {} };
  const reports = getReportsByUser(userId);
  const cycleLength = pref.cycleLength || 28;
  const currentPhase = detectCurrentCyclePhase(pref, reports);

  const productIds = reports.length > 0
    ? [...new Set(reports.map(r => r.productId))]
    : getAllProducts().map(p => p.id);

  const cyclesAhead = subscription.cyclesAhead || 1;
  const cyclePlanItems = [];

  for (let cycleIdx = 0; cycleIdx < cyclesAhead; cycleIdx++) {
    const cycleStartDate = addDays(todayISO(), cycleIdx * cycleLength);
    const cycleItems = [];

    for (const productId of productIds) {
      const product = getProduct(productId);
      if (!product) continue;

      const strategy = getEffectiveProductStrategy(productId, subscription);

      if (shouldSkipCycle(strategy, pref, cycleIdx)) {
        cycleItems.push({
          productId,
          productName: product.name,
          skipped: true,
          skipReason: '按跳过规则配置跳过本轮采购'
        });
        continue;
      }

      const productReports = getReportsByProduct(userId, productId);
      const latestReport = productReports.length > 0 ? productReports[productReports.length - 1] : null;
      const rate = calculateConsumptionRate(userId, productId);

      if (!rate || productReports.length < 2) {
        cycleItems.push({
          productId,
          productName: product.name,
          unit: product.unit,
          hasEnoughData: false,
          message: '数据样本不足，无法精确计算，建议按常规用量采购',
          currentStock: latestReport ? latestReport.quantity : 0,
          suggestedPurchase: null,
          savingsStrategies: generateSavingsStrategies(productId, product.defaultPackSize)
        });
        continue;
      }

      const anomalyResult = factorInAnomalies(userId, productId, rate.dailyRate);
      const adjustedDailyRate = anomalyResult.adjustedRate;
      const stockExtrapolation = extrapolateCurrentStock(latestReport, adjustedDailyRate);
      let currentStock = stockExtrapolation.estimatedStock;

      if (cycleIdx > 0) {
        const prevCyclesConsumption = adjustedDailyRate * cycleLength * cycleIdx;
        currentStock = Math.max(0, currentStock - prevCyclesConsumption);
      }

      const safetyStockDays = strategy.minSafetyStockDays || 3;
      const safetyStockQuantity = Math.ceil(adjustedDailyRate * safetyStockDays);
      const warning = calculateStockWarningDays(currentStock, adjustedDailyRate, safetyStockDays);

      const cyclesToBuyForThisPlan = 1;
      const purchase = calculateOptimalPurchase(productId, currentStock, adjustedDailyRate, cycleLength, cyclesToBuyForThisPlan);

      if (purchase) {
        purchase.safetyStockQuantity = safetyStockQuantity;
        purchase.withSafetyStock = purchase.needToBuy + safetyStockQuantity;
        purchase.packsWithSafetyStock = Math.ceil(purchase.withSafetyStock / product.defaultPackSize);
        purchase.totalUnitsWithSafetyStock = purchase.packsWithSafetyStock * product.defaultPackSize;
        purchase.estimatedCostWithSafetyStock = Number((purchase.totalUnitsWithSafetyStock * product.avgPricePerUnit).toFixed(2));
      }

      const urgencyPriority = warning.critical ? 0 : warning.warning ? 1 : 2;

      cycleItems.push({
        productId,
        productName: product.name,
        unit: product.unit,
        hasEnoughData: true,
        currentStock: Number(currentStock.toFixed(2)),
        reportedStock: latestReport ? latestReport.quantity : 0,
        dailyConsumption: adjustedDailyRate,
        baseDailyConsumption: rate.dailyRate,
        anomalyAdjustment: anomalyResult,
        safetyStockDays,
        safetyStockQuantity,
        stockDaysLeft: warning.daysLeft === Infinity ? '充足' : warning.daysLeft,
        stockWarning: {
          isWarning: warning.warning,
          isCritical: warning.critical,
          daysLeft: warning.daysLeft === Infinity ? null : warning.daysLeft
        },
        suggestedPurchase: purchase,
        estimatedCost: purchase ? purchase.estimatedCostWithSafetyStock : 0,
        packsToBuy: purchase ? purchase.packsWithSafetyStock : 0,
        totalUnits: purchase ? purchase.totalUnitsWithSafetyStock : 0,
        urgencyPriority,
        urgency: warning.critical ? '立即购买' : warning.warning ? '近期购买' : '正常采购',
        savingsStrategies: generateSavingsStrategies(productId, rate.dailyRate * cycleLength)
      });
    }

    const itemsWithPromo = applyPromoSavings(cycleItems.filter(i => !i.skipped && i.suggestedPurchase), pref);
    const budgetResult = applyBudgetAdjustment(itemsWithPromo, subscription.globalMaxBudget);

    const finalItems = cycleItems.map(item => {
      if (item.skipped || !item.suggestedPurchase) return item;
      const adjusted = budgetResult.items.find(b => b.productId === item.productId);
      return adjusted ? { ...item, ...adjusted } : item;
    });

    cyclePlanItems.push({
      cycleIndex: cycleIdx,
      cycleNumber: cycleIdx + 1,
      cycleStartDate: formatDate(cycleStartDate),
      cycleEndDate: formatDate(addDays(cycleStartDate, cycleLength - 1)),
      currentPhase,
      items: finalItems,
      budgetSummary: {
        maxBudget: budgetResult.maxBudget || subscription.globalMaxBudget,
        estimatedTotalCost: budgetResult.totalCost,
        baseTotalCost: Number(finalItems.reduce((s, i) => s + (i.baseEstimatedCost || i.estimatedCost || 0), 0).toFixed(2)),
        budgetExceeded: budgetResult.budgetExceeded,
        budgetAdjusted: budgetResult.adjusted
      }
    });
  }

  const grandTotalCost = cyclePlanItems.reduce((s, c) => s + (c.budgetSummary.estimatedTotalCost || 0), 0);
  const grandBaseCost = cyclePlanItems.reduce((s, c) => s + (c.budgetSummary.baseTotalCost || 0), 0);
  const totalPotentialSavings = cyclePlanItems.reduce((s, c) =>
    s + c.items.reduce((is, i) => is + (i.potentialSavings || 0), 0), 0);

  const snapshot = {
    planId: generatePlanId(),
    userId,
    createdAt: new Date().toISOString(),
    status: 'draft',
    version: 1,
    cyclesAhead,
    cycleLength,
    currentPhase,
    generatedFrom: {
      reportsCount: reports.length,
      lastMenstrualReported: pref.lastMenstrualReported,
      budgetLevel: pref.budgetLevel,
      subscriptionEnabled: subscription.enabled,
      snapshotTimestamp: todayISO()
    },
    factorsConsidered: {
      historicalConsumption: true,
      cyclePhase: true,
      anomalyDetection: true,
      budgetPreferences: true,
      promoSavings: true,
      safetyStock: true,
      skipRules: true
    },
    cycles: cyclePlanItems,
    summary: {
      totalCycles: cyclesAhead,
      totalProducts: productIds.length,
      grandTotalCost: Number(grandTotalCost.toFixed(2)),
      grandBaseCost: Number(grandBaseCost.toFixed(2)),
      totalPotentialSavings: Number(totalPotentialSavings.toFixed(2)),
      immediatePurchaseCount: cyclePlanItems.reduce((s, c) =>
        s + c.items.filter(i => i.urgency === '立即购买' && !i.skipped).length, 0),
      warningPurchaseCount: cyclePlanItems.reduce((s, c) =>
        s + c.items.filter(i => i.urgency === '近期购买' && !i.skipped).length, 0)
    }
  };

  return snapshot;
}

function configureSubscriptionHandler(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) return badRequest('缺少 userId 参数', null, res);

    const body = req.body || {};
    const config = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return badRequest('enabled 必须是布尔值', null, res);
      config.enabled = body.enabled;
    }

    if (body.cyclesAhead !== undefined) {
      const n = Number(body.cyclesAhead);
      if (!Number.isInteger(n) || n < 1 || n > 3) return badRequest('cyclesAhead 必须是 1-3 之间的整数', null, res);
      config.cyclesAhead = n;
    }

    if (body.globalMaxBudget !== undefined) {
      if (body.globalMaxBudget !== null && (typeof body.globalMaxBudget !== 'number' || body.globalMaxBudget < 0)) {
        return badRequest('globalMaxBudget 必须是非负数字或 null', null, res);
      }
      config.globalMaxBudget = body.globalMaxBudget;
    }

    if (body.globalMinSafetyStockDays !== undefined) {
      const n = Number(body.globalMinSafetyStockDays);
      if (!Number.isInteger(n) || n < 0 || n > 30) {
        return badRequest('globalMinSafetyStockDays 必须是 0-30 之间的整数', null, res);
      }
      config.globalMinSafetyStockDays = n;
    }

    if (body.productStrategies !== undefined) {
      if (typeof body.productStrategies !== 'object' || body.productStrategies === null) {
        return badRequest('productStrategies 必须是对象', null, res);
      }
      const allProductIds = getAllProducts().map(p => p.id);
      for (const [pid, strat] of Object.entries(body.productStrategies)) {
        if (!allProductIds.includes(pid)) {
          return badRequest(`productStrategies 中存在无效产品ID: ${pid}`, null, res);
        }
        if (strat.cyclesAhead !== undefined) {
          const n = Number(strat.cyclesAhead);
          if (!Number.isInteger(n) || n < 1 || n > 3) {
            return badRequest(`产品 ${pid} 的 cyclesAhead 必须是 1-3 整数`, null, res);
          }
        }
        if (strat.maxBudget !== undefined && strat.maxBudget !== null) {
          if (typeof strat.maxBudget !== 'number' || strat.maxBudget < 0) {
            return badRequest(`产品 ${pid} 的 maxBudget 必须是非负数字或 null`, null, res);
          }
        }
        if (strat.minSafetyStockDays !== undefined) {
          const n = Number(strat.minSafetyStockDays);
          if (!Number.isInteger(n) || n < 0 || n > 30) {
            return badRequest(`产品 ${pid} 的 minSafetyStockDays 必须是 0-30 整数`, null, res);
          }
        }
        if (strat.skipRules !== undefined) {
          const sr = strat.skipRules;
          if (typeof sr !== 'object' || sr === null) {
            return badRequest(`产品 ${pid} 的 skipRules 必须是对象`, null, res);
          }
          if (sr.skipEveryNthCycle !== undefined) {
            const n = Number(sr.skipEveryNthCycle);
            if (!Number.isInteger(n) || n < 0 || n > 12) {
              return badRequest(`产品 ${pid} 的 skipEveryNthCycle 必须是 0-12 整数`, null, res);
            }
          }
          if (sr.skipOnCertainPhases !== undefined) {
            if (!Array.isArray(sr.skipOnCertainPhases)) {
              return badRequest(`产品 ${pid} 的 skipOnCertainPhases 必须是数组`, null, res);
            }
            const invalid = sr.skipOnCertainPhases.filter(p => !cyclePhases.includes(p));
            if (invalid.length > 0) {
              return badRequest(`产品 ${pid} 的 skipOnCertainPhases 包含无效值: ${invalid.join(', ')}`, null, res);
            }
          }
        }
        if (strat.autoConfirm !== undefined && typeof strat.autoConfirm !== 'boolean') {
          return badRequest(`产品 ${pid} 的 autoConfirm 必须是布尔值`, null, res);
        }
      }
      config.productStrategies = body.productStrategies;
    }

    if (Object.keys(config).length === 0) {
      return badRequest('没有提供任何可更新的订阅配置字段', null, res);
    }

    const existing = getUserPreference(userId).subscription;
    const mergedProductStrategies = {
      ...(existing?.productStrategies || {}),
      ...(config.productStrategies || {})
    };

    const finalConfig = {
      ...existing,
      ...config,
      productStrategies: config.productStrategies !== undefined ? config.productStrategies : mergedProductStrategies
    };

    const result = configureSubscription(userId, finalConfig);

    return success({
      userId,
      subscription: result
    }, '订阅配置更新成功', res);
  } catch (err) {
    console.error('configureSubscription error:', err);
    return error('订阅配置更新失败：' + err.message, 500, null, res);
  }
}

function getSubscriptionConfig(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) return badRequest('缺少 userId 参数', null, res);

    const pref = getUserPreference(userId);
    return success({
      userId,
      subscription: pref.subscription,
      availableProducts: getAllProducts().map(p => ({
        id: p.id,
        name: p.name,
        unit: p.unit,
        defaultPackSize: p.defaultPackSize,
        avgPricePerUnit: p.avgPricePerUnit
      }))
    }, '订阅配置查询成功', res);
  } catch (err) {
    console.error('getSubscriptionConfig error:', err);
    return error('订阅配置查询失败：' + err.message, 500, null, res);
  }
}

function previewPlan(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) return badRequest('缺少 userId 参数', null, res);

    const snapshot = generateRestockPlanSnapshot(userId);
    return success({
      plan: snapshot,
      note: '此为预览版计划，确认后将生成正式可追踪的快照'
    }, '补货计划预览生成成功', res);
  } catch (err) {
    console.error('previewPlan error:', err);
    return error('计划预览失败：' + err.message, 500, null, res);
  }
}

function confirmPlanHandler(req, res) {
  try {
    const { userId, planId } = req.params;
    if (!userId || !planId) return badRequest('缺少 userId 或 planId 参数', null, res);

    const existing = getPlanById(userId, planId);
    if (!existing) return notFound(`计划不存在: ${planId}`, null, res);
    if (existing.status === 'confirmed') return badRequest('该计划已确认，无需重复操作', null, res);
    if (existing.status === 'cancelled') return badRequest('该计划已取消，无法确认', null, res);

    const result = confirmPlan(userId, planId);
    return success({
      planId: result.planId,
      status: result.status,
      confirmedAt: result.confirmedAt
    }, '计划确认成功', res);
  } catch (err) {
    console.error('confirmPlan error:', err);
    return error('计划确认失败：' + err.message, 500, null, res);
  }
}

function cancelPlanHandler(req, res) {
  try {
    const { userId, planId } = req.params;
    const { reason } = req.body || {};
    if (!userId || !planId) return badRequest('缺少 userId 或 planId 参数', null, res);

    const existing = getPlanById(userId, planId);
    if (!existing) return notFound(`计划不存在: ${planId}`, null, res);
    if (existing.status === 'cancelled') return badRequest('该计划已取消，无需重复操作', null, res);

    const result = cancelPlan(userId, planId, reason);
    return success({
      planId: result.planId,
      status: result.status,
      cancelledAt: result.cancelledAt,
      cancelReason: result.cancelReason
    }, '计划取消成功', res);
  } catch (err) {
    console.error('cancelPlan error:', err);
    return error('计划取消失败：' + err.message, 500, null, res);
  }
}

function listPlans(req, res) {
  try {
    const { userId } = req.params;
    const { status, limit } = req.query;
    if (!userId) return badRequest('缺少 userId 参数', null, res);

    let plans = getPlansByUser(userId);

    if (status) {
      plans = plans.filter(p => p.status === status);
    }

    if (limit) {
      const n = Number(limit);
      if (Number.isInteger(n) && n > 0) {
        plans = plans.slice(0, n);
      }
    }

    return success({
      userId,
      totalCount: plans.length,
      plans: plans.map(p => ({
        planId: p.planId,
        createdAt: p.createdAt,
        status: p.status,
        version: p.version,
        cyclesAhead: p.cyclesAhead,
        confirmedAt: p.confirmedAt || null,
        cancelledAt: p.cancelledAt || null,
        summary: p.summary
      }))
    }, '计划列表查询成功', res);
  } catch (err) {
    console.error('listPlans error:', err);
    return error('计划列表查询失败：' + err.message, 500, null, res);
  }
}

function getPlanDetail(req, res) {
  try {
    const { userId, planId } = req.params;
    if (!userId || !planId) return badRequest('缺少 userId 或 planId 参数', null, res);

    const plan = getPlanById(userId, planId);
    if (!plan) return notFound(`计划不存在: ${planId}`, null, res);

    return success({ plan }, '计划详情查询成功', res);
  } catch (err) {
    console.error('getPlanDetail error:', err);
    return error('计划详情查询失败：' + err.message, 500, null, res);
  }
}

function comparePlanVersions(req, res) {
  try {
    const { userId } = req.params;
    const { planIdA, planIdB } = req.query;
    if (!userId) return badRequest('缺少 userId 参数', null, res);
    if (!planIdA || !planIdB) return badRequest('请提供 planIdA 和 planIdB 两个计划ID进行对比', null, res);

    const planA = getPlanById(userId, planIdA);
    const planB = getPlanById(userId, planIdB);

    if (!planA) return notFound(`计划A不存在: ${planIdA}`, null, res);
    if (!planB) return notFound(`计划B不存在: ${planIdB}`, null, res);

    const diff = {
      metadata: {
        planA: { planId: planA.planId, createdAt: planA.createdAt, status: planA.status, version: planA.version },
        planB: { planId: planB.planId, createdAt: planB.createdAt, status: planB.status, version: planB.version }
      },
      summaryDiff: {
        grandTotalCostA: planA.summary?.grandTotalCost ?? 0,
        grandTotalCostB: planB.summary?.grandTotalCost ?? 0,
        costDelta: Number(((planB.summary?.grandTotalCost ?? 0) - (planA.summary?.grandTotalCost ?? 0)).toFixed(2)),
        cyclesAheadA: planA.cyclesAhead,
        cyclesAheadB: planB.cyclesAhead,
        totalProductsA: planA.summary?.totalProducts ?? 0,
        totalProductsB: planB.summary?.totalProducts ?? 0
      },
      cycleDiffs: []
    };

    const maxCycles = Math.max(planA.cycles?.length || 0, planB.cycles?.length || 0);
    for (let i = 0; i < maxCycles; i++) {
      const ca = planA.cycles?.[i];
      const cb = planB.cycles?.[i];
      const cycleDiff = {
        cycleIndex: i,
        existsInA: !!ca,
        existsInB: !!cb,
        itemsDiff: []
      };

      if (ca && cb) {
        cycleDiff.budgetDiff = {
          estimatedTotalCostA: ca.budgetSummary?.estimatedTotalCost ?? 0,
          estimatedTotalCostB: cb.budgetSummary?.estimatedTotalCost ?? 0,
          costDelta: Number(((cb.budgetSummary?.estimatedTotalCost ?? 0) - (ca.budgetSummary?.estimatedTotalCost ?? 0)).toFixed(2))
        };

        const allProductIds = new Set([
          ...(ca.items || []).map(it => it.productId),
          ...(cb.items || []).map(it => it.productId)
        ]);

        for (const pid of allProductIds) {
          const ia = ca.items?.find(it => it.productId === pid);
          const ib = cb.items?.find(it => it.productId === pid);
          cycleDiff.itemsDiff.push({
            productId: pid,
            productName: ia?.productName || ib?.productName || pid,
            inA: !!ia,
            inB: !!ib,
            skippedA: !!ia?.skipped,
            skippedB: !!ib?.skipped,
            packsToBuyA: ia?.packsToBuy ?? 0,
            packsToBuyB: ib?.packsToBuy ?? 0,
            packsDelta: (ib?.packsToBuy ?? 0) - (ia?.packsToBuy ?? 0),
            costA: ia?.estimatedCost ?? 0,
            costB: ib?.estimatedCost ?? 0,
            costDelta: Number(((ib?.estimatedCost ?? 0) - (ia?.estimatedCost ?? 0)).toFixed(2)),
            urgencyA: ia?.urgency || null,
            urgencyB: ib?.urgency || null
          });
        }
      }
      diff.cycleDiffs.push(cycleDiff);
    }

    return success({ comparison: diff }, '计划版本对比完成', res);
  } catch (err) {
    console.error('comparePlanVersions error:', err);
    return error('计划版本对比失败：' + err.message, 500, null, res);
  }
}

function recalculatePlan(req, res) {
  try {
    const { userId } = req.params;
    const { basePlanId } = req.body || {};
    if (!userId) return badRequest('缺少 userId 参数', null, res);

    const newSnapshot = generateRestockPlanSnapshot(userId);

    let previousVersion = 1;
    if (basePlanId) {
      const basePlan = getPlanById(userId, basePlanId);
      if (basePlan) {
        newSnapshot.previousPlanId = basePlanId;
        previousVersion = (basePlan.version || 1) + 1;
      }
    }

    const existingPlans = getPlansByUser(userId);
    newSnapshot.version = Math.max(previousVersion, existingPlans.length + 1);

    const saved = savePlan(userId, newSnapshot);
    return success({
      plan: saved,
      note: basePlanId ? `基于计划 ${basePlanId} 重算生成新版本 v${saved.version}` : `生成新计划 v${saved.version}`
    }, '计划重算成功', res);
  } catch (err) {
    console.error('recalculatePlan error:', err);
    return error('计划重算失败：' + err.message, 500, null, res);
  }
}

function backfillReport(req, res) {
  try {
    const { userId, productId, quantity, cyclePhase, timestamp, note } = req.body;

    if (!userId || !productId || quantity === undefined || quantity === null) {
      return badRequest('缺少必要参数：userId, productId, quantity', null, res);
    }
    if (typeof quantity !== 'number' || quantity < 0) {
      return badRequest('quantity 必须是非负数字', null, res);
    }
    if (!getProduct(productId)) {
      return badRequest(`产品ID不存在: ${productId}`, null, res);
    }
    if (cyclePhase && !cyclePhases.includes(cyclePhase)) {
      return badRequest(`cyclePhase 必须是以下之一: ${cyclePhases.join(', ')}`, null, res);
    }
    if (!timestamp) {
      return badRequest('补录必须提供 timestamp（历史时间）', null, res);
    }
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) {
      return badRequest('timestamp 必须是合法的 ISO 日期字符串', null, res);
    }

    const report = { userId, productId, quantity, cyclePhase: cyclePhase || null, timestamp, note: note || null };
    const savedReport = addReport(userId, report, { backfill: true, source: 'backfill' });

    const anomaly = detectAnomaly(userId, productId, savedReport);
    if (anomaly) {
      addAnomaly(userId, anomaly, { backfill: true });
    }

    return success({
      reportId: savedReport.id,
      productName: getProduct(productId).name,
      backfill: true,
      cycleAnchorNotAffected: true,
      note: '补录数据已记录，不会影响当前周期锚点（lastMenstrualReported）',
      anomalyDetected: !!anomaly,
      anomaly: anomaly || null
    }, '历史数据补录成功', res);
  } catch (err) {
    console.error('backfillReport error:', err);
    return error('历史数据补录失败：' + err.message, 500, null, res);
  }
}

module.exports = {
  configureSubscriptionHandler,
  getSubscriptionConfig,
  previewPlan,
  confirmPlanHandler,
  cancelPlanHandler,
  listPlans,
  getPlanDetail,
  comparePlanVersions,
  recalculatePlan,
  backfillReport,
  generateRestockPlanSnapshot
};
