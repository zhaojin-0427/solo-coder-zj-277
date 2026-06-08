const { success, badRequest, error } = require('../utils/response');
const { addReport, getReportsByUser, getProduct, cyclePhases, addAnomaly, updateUserPreference } = require('../models/store');
const { detectAnomaly } = require('../utils/consumption');

function reportInventory(req, res) {
  try {
    const { userId, productId, quantity, cyclePhase, timestamp, note } = req.body;

    if (!userId || !productId || quantity === undefined || quantity === null) {
      return res.json(badRequest('缺少必要参数：userId, productId, quantity'));
    }

    if (typeof quantity !== 'number' || quantity < 0) {
      return res.json(badRequest('quantity 必须是非负数字'));
    }

    if (!getProduct(productId)) {
      return res.json(badRequest(`产品ID不存在: ${productId}，请先确认产品列表`));
    }

    if (cyclePhase && !cyclePhases.includes(cyclePhase)) {
      return res.json(badRequest(`cyclePhase 必须是以下之一: ${cyclePhases.join(', ')}`));
    }

    const report = {
      userId,
      productId,
      quantity,
      cyclePhase: cyclePhase || null,
      timestamp: timestamp || new Date().toISOString(),
      note: note || null
    };

    const savedReport = addReport(userId, report);

    const anomaly = detectAnomaly(userId, productId, savedReport);
    if (anomaly) {
      addAnomaly(userId, anomaly);
    }

    if (cyclePhase === 'menstrual') {
      const pref = updateUserPreference(userId, { lastMenstrualReported: savedReport.timestamp });
    }

    return res.json(success({
      reportId: savedReport.id,
      productName: getProduct(productId).name,
      anomalyDetected: !!anomaly,
      anomaly: anomaly || null
    }, '库存上报成功'));
  } catch (err) {
    console.error('reportInventory error:', err);
    return res.json(error('库存上报失败：' + err.message));
  }
}

function getInventoryHistory(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.json(badRequest('缺少 userId 参数'));
    }

    const reports = getReportsByUser(userId);
    const grouped = {};

    reports.forEach(r => {
      if (!grouped[r.productId]) {
        grouped[r.productId] = {
          productId: r.productId,
          productName: getProduct(r.productId)?.name || r.productId,
          reports: []
        };
      }
      grouped[r.productId].reports.push(r);
    });

    return res.json(success({
      userId,
      totalReports: reports.length,
      products: Object.values(grouped)
    }, '查询成功'));
  } catch (err) {
    console.error('getInventoryHistory error:', err);
    return res.json(error('查询失败：' + err.message));
  }
}

module.exports = {
  reportInventory,
  getInventoryHistory
};
