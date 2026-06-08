const { getProduct } = require('../models/store');

function generateSavingsStrategies(productId, perCycleUsage) {
  const product = getProduct(productId);
  if (!product || !perCycleUsage || perCycleUsage <= 0) return [];

  const strategies = [];
  const unitPrice = product.avgPricePerUnit;
  const packSize = product.defaultPackSize;

  const packsPerCycle = Math.ceil(perCycleUsage / packSize);
  const cycleCost = packsPerCycle * packSize * unitPrice;
  const annualCost = cycleCost * 12;

  strategies.push({
    id: 'bulk_buy',
    title: '整箱囤货策略',
    description: `按3个月用量一次性采购${Math.ceil(perCycleUsage * 3 / packSize)}包，可节省约5%-10%的单价`,
    estimatedSavings: Number((annualCost * 0.08).toFixed(2)),
    savingPercent: 8,
    action: `建议购买${Math.ceil(perCycleUsage * 3)}${product.unit}（约${Math.ceil(perCycleUsage * 3 / packSize)}包）`
  });

  if (productId.includes('pad') || productId.includes('tampon')) {
    strategies.push({
      id: 'brand_comparison',
      title: '品牌对比策略',
      description: '同类产品不同品牌价格差异可达20%-40%，建议对比线上平台评价后选择高性价比品牌',
      estimatedSavings: Number((annualCost * 0.25).toFixed(2)),
      savingPercent: 25,
      action: '关注大促活动期间（618、双11）的品牌套装优惠'
    });
  }

  if (productId === 'menstrual_cup') {
    strategies.push({
      id: 'reusable_switch',
      title: '可重复使用方案',
      description: '月经杯可重复使用2-5年，相比一次性产品长期成本极低',
      estimatedSavings: Number((annualCost * 0.9).toFixed(2)),
      savingPercent: 90,
      action: '首次投入后平均每年仅需更换1次，建议优先考虑'
    });
  } else {
    strategies.push({
      id: 'eco_alternative',
      title: '环保替代方案',
      description: '可考虑月经杯/可洗布卫生巾等可重复使用产品，减少长期开支',
      estimatedSavings: Number((annualCost * 0.6).toFixed(2)),
      savingPercent: 60,
      action: '根据个人习惯评估是否切换到更环保经济的方案'
    });
  }

  strategies.push({
    id: 'promo_timing',
    title: '促销节点采购',
    description: '电商大促（38节、618、双11、双12）期间通常有满减、买赠活动，可提前囤货',
    estimatedSavings: Number((annualCost * 0.15).toFixed(2)),
    savingPercent: 15,
    action: '建议在下个大促节点提前采购2-3个月用量'
  });

  strategies.push({
    id: 'combo_package',
    title: '组合套装策略',
    description: '日夜组合装、周期套装通常比单品购买更划算',
    estimatedSavings: Number((annualCost * 0.1).toFixed(2)),
    savingPercent: 10,
    action: '优先选择包含日用+夜用+护垫的完整周期套装'
  });

  return strategies.sort((a, b) => b.savingPercent - a.savingPercent);
}

function calculateOptimalPurchase(productId, currentStock, dailyRate, cycleLength = 28, cyclesToBuy = 1) {
  const product = getProduct(productId);
  if (!product || !dailyRate || dailyRate <= 0) return null;

  const perCycleNeed = dailyRate * cycleLength * cyclesToBuy;
  const needToBuy = Math.max(0, perCycleNeed - currentStock);
  const packsToBuy = Math.ceil(needToBuy / product.defaultPackSize);
  const totalUnits = packsToBuy * product.defaultPackSize;
  const estimatedCost = Number((totalUnits * product.avgPricePerUnit).toFixed(2));

  return {
    productId,
    productName: product.name,
    unit: product.unit,
    packSize: product.defaultPackSize,
    currentStock,
    perCycleNeed: Number(perCycleNeed.toFixed(2)),
    needToBuy: Math.ceil(needToBuy),
    packsToBuy,
    totalUnits,
    estimatedCost,
    unitPrice: product.avgPricePerUnit
  };
}

module.exports = {
  generateSavingsStrategies,
  calculateOptimalPurchase
};
